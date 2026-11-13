
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

  // 判断内容是否真正包含中文
  function hasChinese(value = "") {
    return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value));
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

  // AI 翻译标题和摘要
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
请将提供的英文NBA新闻标题和摘要翻译为自然、准确的简体中文。

要求：
1. 标题必须翻译成中文，不得直接照抄英文标题。
2. 摘要必须翻译成中文，不得直接照抄英文摘要。
3. NBA球员姓名应使用常见、准确的中文译名。
4. 球队名称应使用常见中文译名。
5. 不得把一个球员的姓名误译成另一个球员。
6. 比赛数据、比分、时间和事实必须准确。
7. 不得编造原文没有的信息。
8. 如果原文只有标题没有摘要，可以根据标题写一句简短中文说明，但不得编造新闻事实。
9. 不要展示分析过程。
10. 必须只返回合法JSON，不要使用Markdown代码块。

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
      typeof translated.summary !== "string" ||
      !translated.summary.trim()
    ) {
      throw new Error("AI 返回的标题或摘要格式不正确");
    }

    if (
      !hasChinese(translated.title) ||
      !hasChinese(translated.summary)
    ) {
      throw new Error("AI 返回内容没有包含中文，未保存翻译");
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

  // 每次最多翻译10条
  const translationLimit = 10;

  try {
    const db = context.env.DB;

    if (!db) {
      throw new Error("没有找到 DB 数据库绑定");
    }

    let processed = 0;

    for (const item of finalItems) {
      const itemId = String(item.id);

      // 先保存原始新闻
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

      // 读取已有翻译
      const existing = await db.prepare(`
        SELECT chinese_title, chinese_content
        FROM playerbuzz_items
        WHERE id = ?
      `).bind(itemId).first();

      if (!existing) {
        errors.push("数据库读取失败：" + item.title);
        continue;
      }

      const oldTitle = existing.chinese_title || "";
      const oldContent = existing.chinese_content || "";

      const titleIsChinese = hasChinese(oldTitle);
      const contentIsChinese = hasChinese(oldContent);

      // 两个字段都是真正的中文，才算翻译完成
      if (titleIsChinese && contentIsChinese) {
        alreadyTranslated++;

        item.chineseTitle = oldTitle;
        item.chineseContent = oldContent;
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

        // 只更新空白或不含中文的字段
        // 已有中文内容不会被覆盖
        await db.prepare(`
          UPDATE playerbuzz_items
          SET
            chinese_title = CASE
              WHEN ? = 1 THEN ?
              ELSE chinese_title
            END,
            chinese_content = CASE
              WHEN ? = 1 THEN ?
              ELSE chinese_content
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          titleIsChinese ? 0 : 1,
          translated.title,
          contentIsChinese ? 0 : 1,
          translated.summary,
          itemId
        ).run();

        const savedTranslation = await db.prepare(`
          SELECT chinese_title, chinese_content
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(itemId).first();

        item.chineseTitle = savedTranslation?.chinese_title || "";
        item.chineseContent = savedTranslation?.chinese_content || "";
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
