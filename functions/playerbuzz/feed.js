
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

  // 解析AI返回的JSON，并兼容部分格式错误
  function parseTranslation(rawText) {
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      // 尝试修复 summary 字段缺少引号的情况
      const titleMatch = cleaned.match(
        /"title"\s*:\s*"((?:\\.|[^"\\])*)"/
      );

      const summaryMatch = cleaned.match(
        /"summary"\s*:\s*(?:"((?:\\.|[^"\\])*)"|([\s\S]*?))\s*\}\s*$/
      );

      if (titleMatch && summaryMatch) {
        const title = JSON.parse('"' + titleMatch[1] + '"');

        let summary = summaryMatch[1];

        if (summary === undefined) {
          summary = summaryMatch[2] || "";
        } else {
          summary = JSON.parse('"' + summary + '"');
        }

        summary = String(summary)
          .replace(/,\s*$/, "")
          .trim();

        if (title && summary) {
          return { title, summary };
        }
      }

      throw new Error(
        "AI返回内容不是有效JSON：" + cleaned.slice(0, 150)
      );
    }
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

  // AI翻译：球员姓名必须保留英文
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

请把英文NBA新闻标题和摘要翻译成自然、准确的简体中文。

必须严格遵守以下规则：

1. 所有NBA球员姓名必须保留英文原名。
2. 禁止将球员姓名翻译成中文、音译成中文或改写成其他英文姓名。
3. 例如 Devin Booker 必须写作 Devin Booker，Marcus Smart 必须写作 Marcus Smart，Stephen Curry 必须写作 Stephen Curry，LeBron James 必须写作 LeBron James。
4. 如果原文只出现球员姓氏，可以保留原文中的姓氏，不要自行猜测或替换成其他球员。
5. 绝对不能把一个球员误写成另一个球员。例如 Marcus Smart 不能变成 Malcolm Brogdon。
6. 球队名称翻译成常见中文名称。
7. 新闻标题必须是中文，但其中球员姓名保持英文。
8. 新闻摘要必须是中文，但其中球员姓名保持英文。
9. 比分、数据、时间、伤病和比赛事实必须准确。
10. 只能根据原文翻译，不得编造事实。
11. 如果没有摘要，可以根据标题写一句简短中文说明，不得编造事实。
12. 不要输出分析过程、解释或Markdown代码块。
13. 必须返回合法JSON，title和summary的值必须使用英文双引号包围，不能遗漏引号。

返回格式：
{"title":"Devin Booker砍下30分，率队取得胜利","summary":"Devin Booker全场贡献30分，帮助球队战胜对手。"}`
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
        temperature: 0.1
      }
    );

    const message = result?.choices?.[0]?.message;

    const rawText =
      message?.content ||
      result?.response ||
      result?.output_text ||
      "";

    if (typeof rawText !== "string" || !rawText.trim()) {
      throw new Error("AI没有返回翻译内容");
    }

    const translated = parseTranslation(rawText);

    if (
      typeof translated.title !== "string" ||
      !translated.title.trim() ||
      typeof translated.summary !== "string" ||
      !translated.summary.trim()
    ) {
      throw new Error("AI返回的标题或摘要格式不正确");
    }

    if (
      !hasChinese(translated.title) ||
      !hasChinese(translated.summary)
    ) {
      throw new Error("AI返回内容没有包含中文");
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

  const translationLimit = 10;

  try {
    const db = context.env.DB;

    if (!db) {
      throw new Error("没有找到 DB 数据库绑定");
    }

    let processed = 0;

    for (const item of finalItems) {
      const itemId = String(item.id);

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

      // 已有中文内容不覆盖
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
