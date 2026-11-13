
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

  function getBeijingDate() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    const values = {};
    for (const part of parts) {
      values[part.type] = part.value;
    }

    return values.year + "-" + values.month + "-" + values.day;
  }

  // 球员英文姓名保护名单
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

  // 只保护名单中不重复的姓氏，避免 Smart 被翻译或改成其他球员
  const surnameCounts = {};

  for (const fullName of playerNames) {
    const parts = fullName.replace(/\./g, "").split(/\s+/);
    const surname = parts[parts.length - 1];

    if (surname && surname.length > 2) {
      surnameCounts[surname.toLowerCase()] =
        (surnameCounts[surname.toLowerCase()] || 0) + 1;
    }
  }

  const uniqueSurnames = Object.keys(surnameCounts)
    .filter(name => surnameCounts[name] === 1);

  function protectPlayerNames(title, content) {
    const combined = title + " " + content;
    const namesToProtect = [];

    // 保护名单中的完整姓名
    for (const fullName of playerNames) {
      const pattern = new RegExp(
        "\\b" + escapeRegExp(fullName) + "\\b",
        "i"
      );

      const match = combined.match(pattern);

      if (match) {
        namesToProtect.push(match[0]);
      }
    }

    // 即使原文只写姓氏，也保护唯一姓氏
    for (const surname of uniqueSurnames) {
      const pattern = new RegExp(
        "\\b" + escapeRegExp(surname) + "\\b",
        "i"
      );

      const match = combined.match(pattern);

      if (match) {
        namesToProtect.push(match[0]);
      }
    }

    const uniqueNames = [...new Set(namesToProtect)]
      .sort((a, b) => b.length - a.length);

    const replacements = [];
    let index = 0;

    function maskText(text) {
      let result = text;

      for (const name of uniqueNames) {
        const pattern = new RegExp(
          "\\b" + escapeRegExp(name) + "\\b",
          "gi"
        );

        result = result.replace(pattern, matched => {
          const existing = replacements.find(
            item => item.original.toLowerCase() === matched.toLowerCase()
          );

          if (existing) {
            return existing.token;
          }

          const token = "BBALLPLAYER" + index + "TOKEN";
          index++;

          replacements.push({
            token,
            original: matched
          });

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

  function parseAIJson(rawText) {
    let cleaned = String(rawText)
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    try {
      return JSON.parse(cleaned);
    } catch (error) {
      throw new Error("AI返回内容不是有效JSON：" + cleaned.slice(0, 150));
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

    const systemPrompt = `你是一名严谨的NBA中文新闻编辑。

请把英文新闻标题和摘要翻译成简体中文。

【球员姓名规则】
1. 所有 BBALLPLAYER数字TOKEN 必须原样保留，不能修改、拆分或删除。
2. 这些占位符代表原文中的球员英文姓名或姓氏。
3. 球员姓名必须保留英文，不得翻译、音译或自行补全。
4. 不得将一个球员的姓名替换成另一个球员。
5. 原文只出现姓氏时，仍然保留该姓氏，不要擅自补全名字。
6. 不确定的人名保持英文原文，不要猜测。

【事实准确性】
7. 球队名称翻译成常见中文名称。
8. 不得编造原文没有的信息。
9. 不得改变伤病部位、伤病程度、球员身份、球队、比赛结果、日期和数字。
10. oblique 是腹斜肌，不是腹股沟。
11. groin 是腹股沟；strain 是拉伤；tear 是撕裂。
12. 不能把球员的名字、伤病、球队或事件张冠李戴。
13. 如果原文存在歧义，不要擅自推断。

【篮球数据】
14. 12-20 FG 应译为20投12中。
15. 4-8 3PT 应译为三分8投4中。
16. 2-2 FT 应译为罚球2罚2中。

【输出】
17. 标题和摘要都必须翻译成中文。
18. 不要输出解释、分析或Markdown。
19. 必须输出合法JSON。

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
      const rawText =
        message?.content || result?.response || result?.output_text || "";

      if (typeof rawText !== "string" || !rawText.trim()) {
        throw new Error("AI没有返回翻译内容");
      }

      return parseAIJson(rawText);
    }

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const translated = await requestTranslation(
          attempt === 2
            ? "\n再次检查：姓名占位符必须完整保留；绝对不能改变任何人名、球队、伤病部位和数字。"
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

  // 硬性过滤：只让有明确场外话题特征的新闻进入AI精选
  function isPotentialOffCourtNews(item) {
    const text = (
      String(item.title || "") + " " +
      String(item.content || "")
    ).toLowerCase();

    // 普通比赛、数据、伤病和球队事务，一律排除
    const excludedPatterns = [
      /\b(box score|game recap|game preview|matchup|postgame|pre-game)\b/i,
      /\b(points|rebounds|assists|steals|blocks|field goal|three-pointers)\b/i,
      /\b(shot|shooting|scored|scores|scoring|win over|beat the|defeated)\b/i,
      /\b(injury|injured|sidelined|out for|misses? .*games?|surgery|fracture|sprain|strain|torn|tear|rehab|return from injury)\b/i,
      /\b(trade rumors?|trade deadline|contract extension|free agency|waived|signed with|roster move)\b/i,
      /\b(power rankings?|rankings?|standings|playoff picture|fantasy basketball|betting odds)\b/i,
      /\b(practice|training camp|starting lineup|rotation|coach says|team announces)\b/i
    ];

    if (excludedPatterns.some(pattern => pattern.test(text))) {
      return false;
    }

    // 必须具备明确的场外话题信号
    const offCourtPatterns = [
      /\b(instagram|tiktok|twitter|x.com|social media|youtube|podcast)\b/i,
      /\b(posted|posting|viral|went viral|online reaction|responded|reply|replied)\b/i,
      /\b(wife|husband|girlfriend|boyfriend|partner|family|son|daughter|children|kids|mother|father)\b/i,
      /\b(wedding|marriage|dating|relationship|birthday|vacation|holiday|home life)\b/i,
      /\b(charity|foundation|donation|community work|philanthropy|fundraiser)\b/i,
      /\b(fashion|style|outfit|sneakers|collection|watch collection|car collection)\b/i,
      /\b(business venture|brand launch|business|entrepreneur|investment|fashion line)\b/i,
      /\b(feud|controversy|clashes|trash talk|confrontation|altercation|apologized|apology)\b/i,
      /\b(criticized|criticism|called out|responds to|fires back|slams|blasts)\b/i,
      /\b(prank|funny|hilarious|meme|surprise|unexpected|fun fact|off-court)\b/i,
      /\b(arrested|lawsuit|legal dispute|court filing|investigation|incident)\b/i,
      /\b(appearance|celebrity|movie|music|concert|fashion week|red carpet)\b/i
    ];

    return offCourtPatterns.some(pattern => pattern.test(text));
  }

  // AI每日精选：只从通过硬性过滤的场外新闻中选择
  async function selectDailyNews(candidates, remaining) {
    if (!context.env.AI) {
      throw new Error("没有找到 AI 绑定");
    }

    if (!candidates.length || remaining <= 0) {
      return [];
    }

    const eligibleCandidates = candidates.filter(isPotentialOffCourtNews);

    if (!eligibleCandidates.length) {
      return [];
    }

    const limitedCandidates = eligibleCandidates.slice(0, 60);

    const compactCandidates = limitedCandidates.map((item, index) => ({
      index,
      title: String(item.title || "").slice(0, 220),
      description: String(item.content || "").slice(0, 450),
      source: item.source
    }));

    const systemPrompt = `你是NBA球员场外新闻主编。

你的任务是从候选内容中挑选真正值得NBA球迷阅读的场外新闻。

【只允许选择以下内容】
1. 球员本人及家庭、伴侣、子女、朋友的生活动态。
2. 球员社交媒体发布、互动、回应和网络热门话题。
3. 球员之间的场外趣闻、冲突、关系变化和公开争议。
4. 球员公益活动、商业活动、个人品牌和生活方式。
5. 球员穿搭、收藏、兴趣爱好、娱乐活动和个人故事。
6. 有明确事件、有新闻价值的场外突发动态。
7. 球员本人参与或直接回应的非比赛争议。

【以下内容绝对不能选择】
1. 普通比赛战报、赛前预告、赛后比分。
2. 得分、篮板、助攻、投篮命中率等比赛数据。
3. 普通比赛表现评价或赛后采访。
4. 常规伤病、手术、复出、缺席比赛消息。
5. 球队战术、训练、阵容、轮换和普通球队新闻。
6. 普通交易传闻、合同、自由球员和排名消息。
7. 博彩、Fantasy、预测和赛程。
8. 只有球员名字出现，但没有球员场外事件的文章。
9. 只有标题噱头，摘要没有具体事件的文章。
10. 重复事件、低价值消息和无法核实的猜测。

【特别要求】
- 不能因为一条新闻涉及明星球员就自动选中。
- 新闻必须有明确的场外事件或话题。
- 不允许选择普通比赛或伤病新闻。
- 不允许根据标题猜测摘要没有提供的内容。
- 球员英文姓名只作为原文标识，不要翻译或改变姓名。
- 同一事件只选择一条。
- 尽量选择不同球员和不同事件。
- 质量优先，不需要凑足数量。
- 最多选择指定数量。
- 如果没有符合条件的新闻，返回空数组。
- 只返回候选新闻原有的 index 数字。

必须只返回合法JSON，不要输出解释或Markdown。

返回格式：
{"selected":[0,2,5]}`;

    const userPrompt = JSON.stringify({
      requiredMaximum: remaining,
      candidates: compactCandidates
    });

    const result = await context.env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: userPrompt
          }
        ],
        chat_template_kwargs: {
          enable_thinking: false,
          clear_thinking: true
        },
        max_completion_tokens: 1200,
        temperature: 0.1
      }
    );

    const message = result?.choices?.[0]?.message;
    const rawText =
      message?.content || result?.response || result?.output_text || "";

    if (typeof rawText !== "string" || !rawText.trim()) {
      throw new Error("AI没有返回精选结果");
    }

    const parsed = parseAIJson(rawText);

    if (!Array.isArray(parsed.selected)) {
      throw new Error("AI精选结果格式不正确");
    }

    const indexes = [];
    const seen = new Set();

    for (const value of parsed.selected) {
      const index = Number(value);

      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < limitedCandidates.length &&
        !seen.has(index)
      ) {
        seen.add(index);

        // 再次执行硬性过滤，防止AI错误选入
        if (isPotentialOffCourtNews(limitedCandidates[index])) {
          indexes.push(index);
        }
      }
    }

    return indexes
      .slice(0, remaining)
      .map(index => limitedCandidates[index]);
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
    return json({
      success: false,
      message: "没有找到 DB 数据库绑定"
    }, 500);
  }

  // 历史修复模式：只重新翻译待审核新闻
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
          (row.original_title || row.id) + "：" +
          (error.message || "翻译失败")
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
          title,
          content: getTag(item, "description"),
          source: config.name,
          sourceLink: link,
          category: config.category,
          publishedAt: getTag(item, "pubDate")
        };
      }).filter(item => item.title && item.id);
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
        feeds[index].name + "：" +
        (result.reason?.message || "请求失败")
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
    (Date.parse(b.publishedAt) || 0) -
    (Date.parse(a.publishedAt) || 0)
  );

  // 保存RSS新闻，原有新闻不会被覆盖
  let databaseSaved = 0;
  let databaseError = null;

  try {
    for (const item of finalItems) {
      const insertResult = await db.prepare(`
        INSERT OR IGNORE INTO playerbuzz_items (
          id, source, source_link, original_title, original_content,
          category, published_at, review_status
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
      ).run();

      databaseSaved += insertResult.meta?.changes || 0;
    }
  } catch (error) {
    databaseError = error.message || "数据库保存失败";
    errors.push("D1数据库：" + databaseError);
  }

  if (databaseError) {
    return json({
      success: false,
      service: "B-BALL Player Buzz",
      message: "新闻采集完成，但数据库保存发生错误",
      dataSource: feeds.map(feed => feed.name),
      successfulSources,
      total: finalItems.length,
      database: {
        connected: false,
        saved: databaseSaved,
        error: databaseError
      },
      errors
    }, 500);
  }

  // 查询当天已精选的新闻
  const today = getBeijingDate();
  const dailyLimit = 20;
  const selectedIds = new Set();

  try {
    const selectedResult = await db.prepare(`
      SELECT id
      FROM playerbuzz_items
      WHERE ai_selected = 1
        AND selection_date = ?
        AND review_status != 'rejected'
    `).bind(today).all();

    for (const row of selectedResult.results || []) {
      selectedIds.add(String(row.id));
    }
  } catch (error) {
    errors.push("读取今日精选记录失败：" + error.message);
  }

  let newlySelected = 0;
  let selectionError = null;
  let selectedToday = selectedIds.size;

  const remaining = Math.max(0, dailyLimit - selectedToday);

  if (remaining > 0) {
    try {
      const candidates = [];

      for (const item of finalItems) {
        if (selectedIds.has(String(item.id))) {
          continue;
        }

        const existing = await db.prepare(`
          SELECT review_status
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(String(item.id)).first();

        if (!existing || existing.review_status !== "pending") {
          continue;
        }

        if (!isPotentialOffCourtNews(item)) {
          continue;
        }

        candidates.push(item);
      }

      const selectedItems = await selectDailyNews(
        candidates,
        remaining
      );

      for (const item of selectedItems) {
        const result = await db.prepare(`
          UPDATE playerbuzz_items
          SET
            ai_selected = 1,
            selection_date = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND ai_selected = 0
            AND review_status = 'pending'
        `).bind(
          today,
          String(item.id)
        ).run();

        const changes = result.meta?.changes || 0;

        if (changes > 0) {
          newlySelected++;
          selectedIds.add(String(item.id));
        }
      }
    } catch (error) {
      selectionError = error.message || "AI精选失败";
      errors.push("AI每日精选：" + selectionError);
    }
  }

  selectedToday = selectedIds.size;

  // 精选新闻优先翻译
  const orderedItems = [...finalItems].sort((a, b) => {
    const aSelected = selectedIds.has(String(a.id)) ? 1 : 0;
    const bSelected = selectedIds.has(String(b.id)) ? 1 : 0;

    return bSelected - aSelected;
  });

  let translatedCount = 0;
  let alreadyTranslated = 0;
  let translationPending = 0;
  let translationFailed = 0;

  const translationLimit = 20;
  let processed = 0;

  try {
    for (const item of orderedItems) {
      const itemId = String(item.id);

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
          "AI翻译失败：" + item.title + "：" +
          (error.message || "未知错误")
        );
      }
    }
  } catch (error) {
    errors.push("新闻翻译流程异常：" + error.message);
  }

  // 返回今日精选新闻列表
  let todayFeatured = [];

  try {
    const featuredResult = await db.prepare(`
      SELECT
        id,
        source,
        original_title,
        chinese_title,
        chinese_content,
        player_name,
        category,
        published_at,
        review_status
      FROM playerbuzz_items
      WHERE ai_selected = 1
        AND selection_date = ?
        AND review_status != 'rejected'
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT 20
    `).bind(today).all();

    todayFeatured = featuredResult.results || [];
  } catch (error) {
    errors.push("读取今日精选列表失败：" + error.message);
  }

  return json({
    success: finalItems.length > 0,
    service: "B-BALL Player Buzz",
    dataSource: feeds.map(feed => feed.name),
    successfulSources,
    total: finalItems.length,
    database: {
      connected: true,
      saved: databaseSaved,
      error: null
    },
    dailySelection: {
      date: today,
      mode: "AI精选",
      dailyLimit,
      selectedToday: todayFeatured.length,
      newlySelected,
      remaining: Math.max(0, dailyLimit - todayFeatured.length),
      selectionError
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
    featuredItems: todayFeatured,
    errors,
    items: finalItems
  }, finalItems.length > 0 ? 200 : 502);
}
