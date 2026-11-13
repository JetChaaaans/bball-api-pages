
export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (context.request.method !== "GET") {
    return json({ success: false, message: "只支持 GET 请求" }, 405, cors);
  }

  function cleanText(value = "") {
    return value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTag(xml, tag) {
    const match = xml.match(
      new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i")
    );
    return match ? cleanText(match[1]) : "";
  }

  async function getEspnNews() {
    const response = await fetch(
      "https://www.espn.com/espn/rss/nba/news",
      { headers: { "User-Agent": "B-BALL-News-Reader/1.0" } }
    );

    if (!response.ok) {
      throw new Error("ESPN 请求失败：" + response.status);
    }

    const xml = await response.text();
    const entries = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

    return entries.slice(0, 20).map(item => ({
      id: getTag(item, "guid") || getTag(item, "link"),
      type: "news",
      category: "NBA新闻",
      title: getTag(item, "title"),
      content: getTag(item, "description"),
      source: "ESPN",
      publishedAt: getTag(item, "pubDate"),
      reviewStatus: "pending"
    })).filter(item => item.title);
  }

  async function getBlueskyPosts() {
    const hosts = [
      "https://api.bsky.app",
      "https://public.api.bsky.app"
    ];

    let lastError = "";

    for (const host of hosts) {
      try {
        const url = new URL(
          host + "/xrpc/app.bsky.feed.searchPosts"
        );

        url.searchParams.set("q", "NBA");
        url.searchParams.set("sort", "latest");
        url.searchParams.set("limit", "30");

        const response = await fetch(url.toString(), {
          headers: {
            "Accept": "application/json",
            "User-Agent": "B-BALL-News-Reader/1.0"
          }
        });

        if (!response.ok) {
          lastError = host + " 返回 " + response.status;
          continue;
        }

        const data = await response.json();

        return (data.posts || []).map(post => ({
          id: post.uri,
          type: "social",
          category: "社交平台动态",
          title: post.author?.displayName ||
            post.author?.handle || "未知用户",
          content: post.record?.text || "",
          author: post.author?.handle || "",
          source: "Bluesky",
          publishedAt: post.record?.createdAt ||
            post.indexedAt || "",
          reviewStatus: "pending"
        })).filter(item => item.content);
      } catch (error) {
        lastError = error.message;
      }
    }

    throw new Error("两个公开接口均无法访问：" + lastError);
  }

  const results = await Promise.allSettled([
    getEspnNews(),
    getBlueskyPosts()
  ]);

  const items = [];
  const errors = [];

  if (results[0].status === "fulfilled") {
    items.push(...results[0].value);
  } else {
    errors.push("ESPN：" + results[0].reason.message);
  }

  if (results[1].status === "fulfilled") {
    items.push(...results[1].value);
  } else {
    errors.push("Bluesky：" + results[1].reason.message);
  }

  return json({
    success: items.length > 0,
    service: "B-BALL Player Buzz",
    dataSource: ["ESPN RSS", "Bluesky Public API"],
    total: items.length,
    pendingReview: items.length,
    errors,
    items
  }, items.length > 0 ? 200 : 502, cors);
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=900"
    }
  });
}
