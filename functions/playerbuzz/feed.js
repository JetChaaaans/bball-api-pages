
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
    return json({
      success: false,
      message: "只支持 GET 请求"
    }, 405, cors);
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
      .replace(/&#(\d+);/g, (_, n) =>
        String.fromCodePoint(Number(n))
      )
      .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
        String.fromCodePoint(parseInt(n, 16))
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  function getTag(xml, tag) {
    const match = xml.match(
      new RegExp(
        "<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">",
        "i"
      )
    );

    return match ? cleanText(match[1]) : "";
  }

  // ESPN NBA 新闻
  async function getEspnNews() {
    const url = "https://www.espn.com/espn/rss/nba/news";

    const response = await fetch(url, {
      headers: {
        "User-Agent": "B-BALL-News-Reader/1.0"
      }
    });

    if (!response.ok) {
      throw new Error("ESPN RSS 请求失败：" + response.status);
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
      sourceLink: getTag(item, "link"),
      publishedAt: getTag(item, "pubDate"),
      reviewStatus: "pending"
    })).filter(item => item.title);
  }

  // Google News RSS：球员场外动态相关新闻
  async function getGoogleNews() {
    const queries = [
      '"NBA player" social media OR Instagram OR TikTok when:7d',
      'NBA players off court viral post when:7d',
      'NBA star interview personal life social media when:7d'
    ];

    const allItems = [];

    for (const query of queries) {
      const url = new URL(
        "https://news.google.com/rss/search"
      );

      url.searchParams.set("q", query);
      url.searchParams.set("hl", "en-US");
      url.searchParams.set("gl", "US");
      url.searchParams.set("ceid", "US:en");

      const response = await fetch(url.toString(), {
        headers: {
          "User-Agent": "Mozilla/5.0 B-BALL-News-Reader/1.0",
          "Accept": "application/rss+xml, application/xml, text/xml"
        }
      });

      if (!response.ok) {
        throw new Error("Google News RSS 请求失败：" + response.status);
      }

      const xml = await response.text();
      const entries = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

      const items = entries.map(item => ({
        id: getTag(item, "guid") || getTag(item, "link"),
        type: "news",
        category: "球员动态相关新闻",
        title: getTag(item, "title"),
        content: getTag(item, "description"),
        source: getTag(item, "source") || "Google News",
        sourceLink: getTag(item, "link"),
        publishedAt: getTag(item, "pubDate"),
        reviewStatus: "pending"
      })).filter(item => item.title);

      allItems.push(...items);
    }

    // 按链接去重
    const uniqueItems = [];
    const seen = new Set();

    for (const item of allItems) {
      const key = item.id || item.title;

      if (!seen.has(key)) {
        seen.add(key);
        uniqueItems.push(item);
      }
    }

    return uniqueItems.slice(0, 30);
  }

  // 两个新闻来源分别采集
  const results = await Promise.allSettled([
    getEspnNews(),
    getGoogleNews()
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
    errors.push("Google News：" + results[1].reason.message);
  }

  // 全部数据去重
  const finalItems = [];
  const finalSeen = new Set();

  for (const item of items) {
    const key = item.id || item.title;

    if (!finalSeen.has(key)) {
      finalSeen.add(key);
      finalItems.push(item);
    }
  }

  return json({
    success: finalItems.length > 0,
    service: "B-BALL Player Buzz",
    dataSource: ["ESPN RSS", "Google News RSS"],
    total: finalItems.length,
    pendingReview: finalItems.length,
    errors,
    items: finalItems
  }, finalItems.length > 0 ? 200 : 502, cors);
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
