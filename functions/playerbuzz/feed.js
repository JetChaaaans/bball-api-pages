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
    return json({ success: false, message: "只支持 GET 请求" }, 405);
  }

  const url = new URL(context.request.url);
  const repairMode = url.searchParams.get("repair") === "1";

  function cleanText(value = "") {
    return String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/\s+/g, " ")
      .trim();
  }

  function hasChinese(value = "") {
    return /[\u3400-\u4dbf\u4e00-\u9fff]/.test(String(value));
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getTag(xml, tag) {
    const match = xml.match(
      new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">", "i")
    );
    return match ? cleanText(match[1]) : "";
  }

  // 常见NBA球员英文姓名保护名单
  const playerNames = [
    "LeBron James", "Stephen Curry", "Kevin Durant", "Nikola Jokic",
    "Luka Doncic", "Giannis Antetokounmpo", "Victor Wembanyama",
    "Joel Embiid", "Jayson Tatum", "Jaylen Brown", "Anthony Edwards",
    "Shai Gilgeous-Alexander", "Jalen Brunson", "Donovan Mitchell",
    "Devin Booker", "Cade Cunningham", "Tyrese Haliburton",
    "Anthony Davis", "James Harden", "Kyrie Irving", "Kawhi Leonard",
    "Paul George", "Damian Lillard", "Trae Young", "Ja Morant",
    "Zion Williamson", "Austin Reaves", "Marcus Smart", "Charles Bassey",
    "Malcolm Brogdon", "Coby White", "VJ Edgecombe", "Jamison Battle",
    "Collin Murray-Boyles", "Caleb Wilson", "AJ Dybantsa",
    "Yaxel Lendeborg", "Kristaps Porzingis", "Mikal Bridges",
    "Tyler Herro", "Bam Adebayo", "Evan Mobley", "Darius Garland",
    "Donte DiVincenzo", "Karl-Anthony Towns", "Julius Randle",
    "Jaren Jackson Jr.", "Desmond Bane", "Lauri Markkanen",
    "De'Aaron Fox", "Domantas Sabonis", "Draymond Green",
    "Jimmy Butler", "Klay Thompson", "Khris Middleton", "Brook Lopez",
    "Chet Holmgren", "Jalen Williams", "Alperen Sengun",
    "Fred VanVleet", "Amen Thompson", "Ausar Thompson",
    "Paolo Banchero", "Franz Wagner", "LaMelo Ball",
    "Brandon Miller", "Scottie Barnes", "RJ Barrett",
    "Immanuel Quickley", "Tyrese Maxey", "Paul Reed", "Derrick White",
    "Jrue Holiday", "Deandre Ayton", "DeMar DeRozan", "Zach LaVine",
    "Nikola Vucevic", "Josh Giddey", "Michael Porter Jr.",
    "Aaron Gordon", "Jamal Murray", "Russell Westbrook",
    "Bradley Beal", "Devin Vassell", "Stephon Castle", "Chris Paul",
    "Harrison Barnes", "Terry Rozier", "Duncan Robinson",
    "Jalen Green", "Dillon Brooks", "Tari Eason", "Reed Sheppard",
    "Cooper Flagg", "Kon Knueppel", "Dylan Harper", "Ace Bailey",
    "Derik Queen", "Nolan Traore"
  ];

  function protectPlayerNames(title, content) {
    const combined = title + " " + content;
    const found = [];

    for (const fullName of playerNames) {
      const pattern = new RegExp("\\b" + escapeRegExp(fullName) + "\\b", "i");
      if (pattern.test(combined)) {
        found.push({
          original: fullName,
          surname: fullName.split(/\s+/).pop()
        });
      }
    }

    const entries = [];
    for (const player of found) {
      entries.push(player.original);
      if (player.surname.length > 2) {
        const surnamePattern = new RegExp(
          "\\b" + escapeRegExp(player.surname) + "\\b", "i"
        );
        if (surnamePattern.test(combined)) {
          entries.push(player.surname);
        }
      }
    }

    const uniqueNames = [...new Set(entries)].sort((a, b) => b.length - a.length);
    const replacements = [];
    let index = 0;

    function maskText(text) {
      let result = text;
      for (const name of uniqueNames) {
        const pattern = new RegExp("\\b" + escapeRegExp(name) + "\\b", "gi");
        result = result.replace(pattern, matched => {
          const existing = replacements.find(
            item => item.original.toLowerCase() === matched.toLowerCase()
          );
          if (existing) return existing.token;

          const token = "BBALLPLAYER" + index + "TOKEN";
          index++;
          replacements.push({ token, original: matched });
          return token;
        });
      }
      return result;
    }

    return {
      title: maskText(title),
      content: maskText(content),
      replacements
    };
  }

  function restorePlayerNames(text, replacements) {
    let result = String(text);
    for (const item of replacements) {
      result = result.split(item.token).join(item.original);
    }
    return result;
  }

  function parseTranslation(rawText) {
    const cleaned = String(rawText)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error("AI返回内容不是有效JSON：" + cleaned.slice(0, 120));
    }
  }

  async function translateNews(item) {
    if (!context.env.AI) {
      throw new Error("没有找到 AI 绑定");
    }

    const protectedText = protectPlayerNames(
      String(item.title || "").slice(0, 300),
      String(item.content || "").slice(0, 700)
    );

    const sourceText = JSON.stringify({
      title: protectedText.title,
      description: protectedText.content
    });

    const systemPrompt = `你是一名专业的NBA中文新闻编辑。

将用户提供的英文NBA新闻标题和摘要翻译成准确、自然的简体中文。

必须遵守：
1. 所有 BBALLPLAYER数字TOKEN 占位符必须原样保留，不能翻译、删除或修改。
2. 占位符代表NBA球员英文姓名，最终由系统自动还原。
3. 球员姓名必须保留英文原名，不得翻译或音译。
4. 不要猜测球员身份，不得把一个球员写成另一个球员。
5. 球队名称翻译成常见中文名称。
6. 标题和摘要都必须翻译成中文。
7. 保留原文比分、数据、日期和比赛事实。
8. oblique 是腹斜肌，不是腹股沟。
9. groin 是腹股沟；strain 是拉伤；tear 是撕裂。
10. 篮球投篮数据顺序必须正确。例如 12-20 FG 应译为20投12中；4-8 3PT 应译为三分8投4中；2-2 FT 应译为罚球2罚2中。
11. 不得编造原文没有的信息。
12. 不要输出解释、分析或Markdown。
13. 必须输出合法JSON，字符串使用英文双引号。

只允许返回：
{"title":"中文标题","summary":"中文摘要"}`;

    async function requestTranslation(extraInstruction = "") {
      const result = await context.env.AI.run(
        "@cf/zai-org/glm-4.7-flash",
        {
          messages: [
            {
              role: "system",
              content: systemPrompt + extraInstruction
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
          max_completion_tokens: 400,
          temperature: 0.1
        }
      );

      const message = result?.choices?.[0]?.message;
      const rawText = message?.content || result?.response || result?.output_text || "";

      if (typeof rawText !== "string" || !rawText.trim()) {
        throw new Error("AI没有返回翻译内容");
      }
      return parseTranslation(rawText);
    }

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const translated = await requestTranslation(
          attempt === 2
            ? "\n再次检查：球员姓名占位符必须完整保留；篮球数据顺序必须正确；伤病部位必须准确。"
            : ""
        );

        if (
          typeof translated.title !== "string" ||
          !translated.title.trim() ||
          typeof translated.summary !== "string" ||
          !translated.summary.trim()
        ) {
          throw new Error("AI返回的标题或摘要格式不正确");
        }

        for (const item of protectedText.replacements) {
          if (
            !translated.title.includes(item.token) &&
            !translated.summary.includes(item.token)
          ) {
            throw new Error("AI遗漏了球员姓名占位符");
          }
        }

        const finalTitle = restorePlayerNames(
          translated.title,
          protectedText.replacements
        );
        const finalSummary = restorePlayerNames(
          translated.summary,
          protectedText.replacements
        );

        if (!hasChinese(finalTitle) || !hasChinese(finalSummary)) {
          throw new Error("AI返回内容没有包含中文");
        }

        if (
          /BBALLPLAYER\d+TOKEN/.test(finalTitle) ||
          /BBALLPLAYER\d+TOKEN/.test(finalSummary)
        ) {
          throw new Error("球员姓名还原失败");
        }

        return {
          title: finalTitle.trim(),
          summary: finalSummary.trim()
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("AI翻译失败");
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

  const db = context.env.DB;
  if (!db) {
    return json({ success: false, message: "没有找到 DB 数据库绑定" }, 500);
  }

  // 修复模式：只重新翻译待审核新闻，不采集新内容
  if (repairMode) {
    let rows;
    try {
      const result = await db.prepare(`
        SELECT id, original_title, original_content
        FROM playerbuzz_items
        WHERE review_status = 'pending'
        ORDER BY COALESCE(published_at, created_at) DESC
        LIMIT 10
      `).all();

      rows = result.results || [];
    } catch (error) {
      return json({
        success: false,
        message: "读取待审核新闻失败：" + error.message
      }, 500);
    }

    let repaired = 0;
    let failed = 0;
    const errors = [];

    for (const row of rows) {
      try {
        const translated = await translateNews({
          title: row.original_title || "",
          content: row.original_content || ""
        });

        const updateResult = await db.prepare(`
          UPDATE playerbuzz_items
          SET chinese_title = ?,
              chinese_content = ?,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND review_status = 'pending'
        `).bind(
          translated.title,
          translated.summary,
          row.id
        ).run();

        if ((updateResult.meta?.changes || 0) > 0) {
          repaired++;
        }
      } catch (error) {
        failed++;
        errors.push(
          (row.original_title || row.id) + "：" + (error.message || "翻译失败")
        );
      }
    }

    return json({
      success: true,
      mode: "repair",
      message: "待审核新闻修复完成",
      selected: rows.length,
      repaired,
      failed,
      limitPerRequest: 10,
      protectedStatus: "approved",
      errors
    });
  }

  // 正常采集模式
  const results = await Promise.allSettled(
    feeds.map(async config => {
      const response = await fetch(config.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 B-BALL-News-Reader/1.0",
          "Accept": "application/rss+xml, application/xml, text/xml"
        }
      });

      if (!response.ok) {
        throw new Error(config.name + " RSS 请求失败：" + response.status);
      }

      const xml = await response.text();
      const entries = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];

      return entries.slice(0, config.limit).map(item => {
        const link = getTag(item, "link");
        const guid = getTag(item, "guid");
        const title = getTag(item, "title");

        return {
          id: guid || link || title,
          title,
          content: getTag(item, "description"),
          source: config.name,
          sourceLink: link,
          category: config.category,
          publishedAt: getTag(item, "pubDate")
        };
      }).filter(item => item.title);
    })
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
        feeds[index].name + "：" + (result.reason?.message || "请求失败")
      );
    }
  });

  const seen = new Set();
  const finalItems = [];

  for (const item of items) {
    const key = item.id || item.title;
    if (!seen.has(key)) {
      seen.add(key);
      finalItems.push(item);
    }
  }

  finalItems.sort((a, b) =>
    (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)
  );

  let databaseSaved = 0;
  let translatedCount = 0;
  let alreadyTranslated = 0;
  let translationPending = 0;
  let translationFailed = 0;
  let databaseError = null;

  const translationLimit = 10;

  try {
    let processed = 0;

    for (const item of finalItems) {
      const itemId = String(item.id);

      const insertResult = await db.prepare(`
        INSERT OR IGNORE INTO playerbuzz_items (
          id, source, source_link, original_title, original_content,
          category, published_at, review_status
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
            chinese_title = CASE WHEN ? = 1 THEN ? ELSE chinese_title END,
            chinese_content = CASE WHEN ? = 1 THEN ? ELSE chinese_content END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND review_status = 'pending'
        `).bind(
          titleIsChinese ? 0 : 1,
          translated.title,
          contentIsChinese ? 0 : 1,
          translated.summary,
          itemId
        ).run();

        const saved = await db.prepare(`
          SELECT chinese_title, chinese_content
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(itemId).first();

        item.chineseTitle = saved?.chinese_title || "";
        item.chineseContent = saved?.chinese_content || "";
        item.translationStatus = "translated";
        translatedCount++;
      } catch (error) {
        translationFailed++;
        translationPending++;
        item.translationStatus = "failed";
        errors.push(
          "AI翻译失败：" + item.title + "：" + (error.message || "未知错误")
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
