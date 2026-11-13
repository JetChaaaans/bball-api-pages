
export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (context.request.method !== "GET") {
    return json({
      success: false,
      message: "只支持 GET 请求"
    }, 405);
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

  // 使用 AI 翻译标题和新闻摘要
  async function translateNews(item) {
    if (!context.env.AI) {
      throw new Error("没有找到 AI 绑定");
    }

    const sourceText = JSON.stringify({
      title: item.title.slice(0, 300),
      description: item.content.slice(0, 700)
    });

    const result = await context.env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          {
            role: "system",
            content: `你是一名专业的NBA中文新闻编辑。
请将提供的英文NBA新闻标题和摘要翻译、整理为简体中文。
要求：
1. 准确保留球员姓名、球队名称、比赛数据和事实。
2. title 是简洁自然的中文新闻标题。
3. summary 是简短、流畅的中文新闻摘要，通常1至2句话。
4. 只能依据提供的英文内容，不得编造事实。
5. 如果没有提供摘要，只能根据标题进行简短转述。
6. 不要展示分析过程。
7. 必须只返回合法JSON，不要使用Markdown代码块。
返回格式：
{"title":"中文标题","summary":"中文摘要"}`
          },
          {
            role: "user",
            content: sourceText
          }
        ],
        chat_template_kwargs: {
          enable_thinking: false,
          clear_thinking: true
        },
        max_completion_tokens: 300,
        temperature: 0.2
      }
    );

    const message = result?.choices?.[0]?.message;

    const rawText =
      message?.content ||
      result?.response ||
      result?.output_text ||
      "";

    if (typeof rawText !== "string" || !rawText.trim()) {
      throw new Error("AI 没有返回翻译内容");
    }

    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let translated;

    try {
      translated = JSON.parse(cleaned);
    } catch {
      throw new Error("AI 返回内容不是有效JSON：" + cleaned.slice(0, 150));
    }

    if (
      typeof translated.title !== "string" ||
      !translated.title.trim() ||
      typeof translated.summary !== "string"
    ) {
      throw new Error("AI 返回的中文标题或摘要格式不正确");
    }

    return {
      title: translated.title.trim(),
      summary: translated.summary.trim()
    };
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

  let databaseSaved = 0;
  let translatedCount = 0;
  let alreadyTranslated = 0;
  let translationPending = 0;
  let translationFailed = 0;
  let databaseError = null;

  // 每次最多翻译10条，避免单次请求过长
  const translationLimit = 10;

  try {
    const db = context.env.DB;

    if (!db) {
      throw new Error("没有找到 DB 数据库绑定");
    }

    let processed = 0;

    for (const item of finalItems) {
      const itemId = String(item.id);

      // 先保存原文，确保翻译失败时新闻也不会丢失
      const insertResult = await db.prepare(`
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
        itemId,
        item.source,
        item.sourceLink || "",
        item.title,
        item.content || "",
        item.category || "NBA新闻",
        item.publishedAt || ""
      ).run();

      databaseSaved += insertResult.meta?.changes || 0;

      // 查询数据库中已有的中文翻译
      const existing = await db.prepare(`
        SELECT chinese_title, chinese_content
        FROM playerbuzz_items
        WHERE id = ?
      `).bind(itemId).first();

      if (!existing) {
        errors.push("数据库读取失败：" + item.title);
        continue;
      }

      if (
        existing.chinese_title &&
        existing.chinese_content
      ) {
        alreadyTranslated++;
        item.chineseTitle = existing.chinese_title;
        item.chineseContent = existing.chinese_content;
        item.translationStatus = "translated";
        continue;
      }

      if (processed >= translationLimit) {
        translationPending++;
        item.translationStatus = "waiting";
        continue;
      }

      processed++;

      try {
        const translated = await translateNews(item);

        // 只补充空白翻译字段，不覆盖人工已经编辑的内容
        await db.prepare(`
          UPDATE playerbuzz_items
          SET
            chinese_title = CASE
              WHEN chinese_title IS NULL OR chinese_title = ''
              THEN ?
              ELSE chinese_title
            END,
            chinese_content = CASE
              WHEN chinese_content IS NULL OR chinese_content = ''
              THEN ?
              ELSE chinese_content
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          translated.title,
          translated.summary,
          itemId
        ).run();

        const savedTranslation = await db.prepare(`
          SELECT chinese_title, chinese_content
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(itemId).first();

        item.chineseTitle = savedTranslation?.chinese_title || translated.title;
        item.chineseContent = savedTranslation?.chinese_content || translated.summary;
        item.translationStatus = "translated";

        translatedCount++;

      } catch (error) {
        translationFailed++;
        translationPending++;

        item.translationStatus = "failed";

        errors.push(
          "AI翻译失败：" + item.title + "：" +
          (error.message || "未知错误")
        );
      }
    }

  } catch (error) {
    databaseError = error.message || "数据库保存失败";
    errors.push("D1数据库：" + databaseError);
  }

  return json({
    success: finalItems.length > 0,
    service: "B-BALL Player Buzz",
    dataSource: feeds.map(feed => feed.name),

    successfulSources,

    total: finalItems.length,

    database: {
      connected: !databaseError,
      saved: databaseSaved,
      error: databaseError
    },

    translation: {
      model: "@cf/zai-org/glm-4.7-flash",
      translated: translatedCount,
      alreadyTranslated,
      failed: translationFailed,
      waiting: translationPending,
      limitPerRequest: translationLimit
    },

    pendingReview: finalItems.length,

    errors,

    items: finalItems

  }, finalItems.length > 0 ? 200 : 502);
}
