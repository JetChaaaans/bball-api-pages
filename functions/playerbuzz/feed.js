
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
    return String(value)
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

  async function getRssNews(config) {
    const response = await fetch(config.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 B-BALL-News-Reader/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml"
      }
    });

    if (!response.ok) {
      throw new Error(
        config.name + " RSS 请求失败：" + response.status
      );
    }

    const xml = await response.text();
    const entries = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

    return entries.slice(0, config.limit).map(item => {
      const link = getTag(item, "link");
      const guid = getTag(item, "guid");
      const title = getTag(item, "title");

      return {
        id: guid || link || title,
        type: "news",
        category: config.category,
        title,
        content: getTag(item, "description"),
        source: config.name,
        sourceLink: link,
        publishedAt: getTag(item, "pubDate"),
        reviewStatus: "pending"
      };
    }).filter(item => item.title);
  }

  const feeds = [
    {
      name: "ESPN",
      url: "https://www.espn.com/espn/rss/nba/news",
      category: "NBA新闻",
      limit: 20
    },
    {
      name: "RotoWire",
      url: "https://www.rotowire.com/rss/news.php?sport=NBA",
      category: "球员动态",
      limit: 20
    },
    {
      name: "Yahoo Sports",
      url: "https://sports.yahoo.com/nba/rss/",
      category: "NBA新闻",
      limit: 20
    }
  ];

  const results = await Promise.allSettled(
    feeds.map(feed => getRssNews(feed))
  );

  const items = [];
  const errors = [];
  const successfulSources = [];

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);

      successfulSources.push({
        name: feeds[index].name,
        count: result.value.length
      });
    } else {
      errors.push(
        feeds[index].name + "：" +
        (result.reason?.message || "请求失败")
      );
    }
  });

  const finalItems = [];
  const seen = new Set();

  for (const item of items) {
    const key = item.id || item.title;

    if (!seen.has(key)) {
      seen.add(key);
      finalItems.push(item);
    }
  }

  finalItems.sort((a, b) => {
    const timeA = Date.parse(a.publishedAt) || 0;
    const timeB = Date.parse(b.publishedAt) || 0;
    return timeB - timeA;
  });

  // 将新闻保存到 D1 数据库
  let databaseSaved = 0;
  let databaseError = null;

  try {
    const db = context.env.DB;

    if (!db) {
      throw new Error("没有找到 DB 数据库绑定，请检查 Cloudflare Bindings 设置");
    }

    const statements = finalItems.map(item =>
      db.prepare(`
        INSERT OR IGNORE INTO playerbuzz_items (
          id,
          source,
          source_link,
          original_title,
          original_content,
          category,
          published_at,
          review_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
      `).bind(
        String(item.id),
        item.source,
        item.sourceLink || "",
        item.title,
        item.content || "",
        item.category || "NBA新闻",
        item.publishedAt || ""
      )
    );

    if (statements.length > 0) {
      const saveResults = await db.batch(statements);

      databaseSaved = saveResults.reduce(
        (total, result) => total + (result.meta?.changes || 0),
        0
      );
    }

  } catch (error) {
    databaseError = error.message || "数据库保存失败";
    errors.push("D1 数据库：" + databaseError);
  }

  return json({
    success: finalItems.length > 0,
    service: "B-BALL Player Buzz",
    dataSource: feeds.map(feed => feed.name),
    successfulSources,
    total: finalItems.length,
    pendingReview: finalItems.length,
    database: {
      connected: !databaseError,
      saved: databaseSaved,
      skipped: finalItems.length - databaseSaved,
      error: databaseError
    },
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
      "Cache-Control": "public, max-age=300"
    }
  });
}
