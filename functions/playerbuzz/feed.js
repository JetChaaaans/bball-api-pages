
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

  function getAIText(result) {
    const message = result?.choices?.[0]?.message;
    let content = message?.content;

    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (Array.isArray(content)) {
      const textParts = content
        .map(part => {
          if (typeof part === "string") return part;
          return part?.text || part?.content || "";
        })
        .filter(Boolean);

      if (textParts.length) {
        return textParts.join("\n").trim();
      }
    }

    if (typeof result?.response === "string" && result.response.trim()) {
      return result.response.trim();
    }

    if (typeof result?.output_text === "string" && result.output_text.trim()) {
      return result.output_text.trim();
    }

    if (content && typeof content === "object") {
      return JSON.stringify(content);
    }

    throw new Error("AI没有返回可读取的内容");
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
      throw new Error(
        "AI返回内容不是有效JSON：" + cleaned.slice(0, 200)
      );
    }
  }

  // 只允许明确的场外新闻进入精选
  function isPotentialOffCourtNews(item) {
    const text = (
      String(item.title || "") + " " +
      String(item.content || "")
    ).toLowerCase();

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

  // AI每日精选
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

    const systemPrompt = `You are the chief editor of an NBA off-court news service.

Select only genuinely interesting NBA player off-court stories.

ALLOWED:
1. Players' personal lives, family, partners and children.
2. Social media posts, interactions and viral topics.
3. Off-court stories, relationships, conflicts and public controversies.
4. Charity, business, personal brands and lifestyle.
5. Fashion, collections, hobbies and entertainment.
6. Significant off-court incidents involving players.
7. Non-game controversies directly involving players.

STRICTLY EXCLUDE:
1. Game recaps, previews, scores and results.
2. Points, rebounds, assists and other game statistics.
3. Ordinary game performance reviews and postgame interviews.
4. Routine injuries, surgery, recovery and return-to-play news.
5. Team tactics, practice, lineups and ordinary team news.
6. Trade rumors, contracts and free agency.
7. Betting, fantasy basketball, predictions and schedules.
8. Stories that merely mention a player's name without an off-court event.
9. Headlines that do not describe a specific event in the description.
10. Duplicate, low-value or unverified speculation.

IMPORTANT:
- Do not select a story just because it involves a famous player.
- The story must contain a clear off-court event or topic.
- Do not guess information missing from the description.
- Keep all player names exactly as written in the source.
- Select only one story for each event.
- Prefer different players and different events.
- Quality is more important than quantity.
- Select no more than the specified maximum.
- Return an empty array if nothing qualifies.
- Return only the original candidate index numbers.

Return valid JSON only, without Markdown or explanation.

Required format:
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

    const rawText = getAIText(result);
    const parsed = parseAIJson(rawText);

    let selectedValues = null;

    if (Array.isArray(parsed)) {
      selectedValues = parsed;
    } else if (Array.isArray(parsed?.selected)) {
      selectedValues = parsed.selected;
    } else if (Array.isArray(parsed?.output?.selected)) {
      selectedValues = parsed.output.selected;
    } else if (typeof parsed?.selected === "string") {
      try {
        const nested = JSON.parse(parsed.selected);
        if (Array.isArray(nested)) {
          selectedValues = nested;
        }
      } catch (error) {
        // 保留下面的格式错误提示
      }
    }

    if (!Array.isArray(selectedValues)) {
      throw new Error(
        "AI精选结果格式不正确，返回内容：" + rawText.slice(0, 250)
      );
    }

    const indexes = [];
    const seen = new Set();

    for (const value of selectedValues) {
      const index = Number(value);

      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < limitedCandidates.length &&
        !seen.has(index)
      ) {
        seen.add(index);

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

  if (repairMode) {
    return json({
      success: true,
      mode: "english_only",
      message: "当前已切换为英文原文模式，不需要翻译修复",
      translationEnabled: false
    });
  }

  // 采集RSS
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

  // 保存RSS原文，不覆盖已有记录
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

  const today = getBeijingDate();
  const dailyLimit = 20;
  const selectedIds = new Set();

  // 统计今日已经精选的新闻，包括已自动发布和人工通过的新闻
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
          SELECT
            id,
            review_status,
            original_title,
            original_content,
            chinese_title,
            chinese_content
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(String(item.id)).first();

        // 只处理普通待审核新闻，不碰已通过或已拒绝的新闻
        if (!existing || existing.review_status !== "pending") {
          continue;
        }

        if (!isPotentialOffCourtNews(item)) {
          continue;
        }

        candidates.push({
          ...item,
          title: existing.original_title || item.title || "",
          content: existing.original_content || item.content || ""
        });
      }

      const selectedItems = await selectDailyNews(
        candidates,
        remaining
      );

      for (const item of selectedItems) {
        // 自动发布前，必须确保英文原文标题和摘要均完整
        const originalTitle = String(item.title || "").trim();
        const originalContent = String(item.content || "").trim();

        if (!originalTitle || !originalContent) {
          continue;
        }

        const result = await db.prepare(`
          UPDATE playerbuzz_items
          SET
            ai_selected = 1,
            selection_date = ?,
            chinese_title = ?,
            chinese_content = ?,
            review_status = 'approved',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND ai_selected = 0
            AND review_status = 'pending'
            AND TRIM(COALESCE(original_title, '')) != ''
            AND TRIM(COALESCE(original_content, '')) != ''
        `).bind(
          today,
          originalTitle,
          originalContent,
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

  // 精选新闻优先返回
  const orderedItems = [...finalItems].sort((a, b) => {
    const aSelected = selectedIds.has(String(a.id)) ? 1 : 0;
    const bSelected = selectedIds.has(String(b.id)) ? 1 : 0;

    return bSelected - aSelected;
  });

  // 返回英文原文，不再调用AI翻译
  const outputItems = [];

  for (const item of orderedItems) {
    const itemId = String(item.id);

    const existing = await db.prepare(`
      SELECT original_title, original_content
      FROM playerbuzz_items
      WHERE id = ?
    `).bind(itemId).first();

    const englishTitle = existing?.original_title || item.title || "";
    const englishContent = existing?.original_content || item.content || "";

    outputItems.push({
      ...item,
      title: englishTitle,
      content: englishContent,
      chineseTitle: englishTitle,
      chineseContent: englishContent,
      chinese_title: englishTitle,
      chinese_content: englishContent,
      translationStatus: "not_required"
    });
  }

  // 读取今日精选，包括自动发布的新闻
  let todayFeatured = [];

  try {
    const featuredResult = await db.prepare(`
      SELECT
        id,
        source,
        original_title,
        original_content,
        player_name,
        category,
        published_at,
        review_status
      FROM playerbuzz_items
      WHERE ai_selected = 1
        AND selection_date = ?
        AND review_status = 'approved'
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT 20
    `).bind(today).all();

    todayFeatured = (featuredResult.results || []).map(row => ({
      ...row,
      title: row.original_title || "",
      content: row.original_content || "",
      chineseTitle: row.original_title || "",
      chineseContent: row.original_content || "",
      chinese_title: row.original_title || "",
      chinese_content: row.original_content || "",
      translationStatus: "not_required"
    }));
  } catch (error) {
    errors.push("读取今日精选列表失败：" + error.message);
  }

  return json({
    success: finalItems.length > 0,
    service: "B-BALL Player Buzz",
    mode: "English Original - Auto Publish",
    translationEnabled: false,
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
      mode: "AI精选后自动发布（英文原文）",
      dailyLimit,
      selectedToday: todayFeatured.length,
      newlySelected,
      remaining: Math.max(0, dailyLimit - todayFeatured.length),
      selectionError
    },
    translation: {
      enabled: false,
      mode: "英文原文，不翻译",
      translated: 0,
      alreadyTranslated: 0,
      failed: 0,
      waiting: 0
    },
    pendingReview: finalItems.length,
    featuredItems: todayFeatured,
    errors,
    items: outputItems
  }, finalItems.length > 0 ? 200 : 502);
}
