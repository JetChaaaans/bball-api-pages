
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

  // 规范化新闻链接，去除常见追踪参数。
  function normalizeUrl(value) {
    if (!value) return "";

    try {
      const parsed = new URL(value);
      parsed.hash = "";

      const removeParams = [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_content",
        "utm_term",
        "guccounter",
        "guce_referrer",
        "guce_referrer_sig"
      ];

      for (const key of removeParams) {
        parsed.searchParams.delete(key);
      }

      return parsed.toString().replace(/\/$/, "").toLowerCase();
    } catch {
      return String(value).trim().toLowerCase();
    }
  }

  // 判断是否为RotoWire新闻源。
  function isRotoWireSource(value) {
    return String(value || "").trim().toLowerCase() === "rotowire";
  }

  // 新闻标题标准化。
  function normalizeTitle(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&amp;/g, "&")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 移除常见无意义词，减少媒体标题格式差异的影响。
  function getTitleTokens(value) {
    const stopWords = new Set([
      "the", "a", "an", "and", "or", "but", "for", "to",
      "of", "in", "on", "at", "by", "with", "from", "after",
      "before", "over", "as", "is", "are", "was", "were",
      "has", "have", "had", "will", "would", "could",
      "nba", "report", "reports", "reported", "update",
      "updates", "latest"
    ]);

    return new Set(
      normalizeTitle(value)
        .split(" ")
        .filter(word => word.length > 1 && !stopWords.has(word))
    );
  }

  // 计算标题相似度。只用于高置信度去重，不做宽松猜测。
  function titleSimilarity(first, second) {
    const a = normalizeTitle(first);
    const b = normalizeTitle(second);

    if (!a || !b) return 0;
    if (a === b) return 1;

    const tokensA = getTitleTokens(a);
    const tokensB = getTitleTokens(b);

    if (!tokensA.size || !tokensB.size) return 0;

    let intersection = 0;

    for (const token of tokensA) {
      if (tokensB.has(token)) intersection++;
    }

    const union = new Set([...tokensA, ...tokensB]).size;
    const jaccard = intersection / union;
    const overlap = intersection / Math.min(tokensA.size, tokensB.size);

    return Math.max(jaccard, overlap * 0.9);
  }

  function isCloseInTime(first, second) {
    const a = Date.parse(first || "");
    const b = Date.parse(second || "");

    // 如果两边都有时间，要求相差不超过5天。
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return Math.abs(a - b) <= 5 * 24 * 60 * 60 * 1000;
    }

    // 时间缺失时，不使用模糊标题匹配。
    return false;
  }

  function isDuplicateNews(item, previousItems) {
    const currentUrl = normalizeUrl(item.sourceLink);
    const currentTitle = normalizeTitle(item.title);
    const currentIsRotoWire = isRotoWireSource(item.source);

    for (const previous of previousItems) {
      const previousRawUrl =
        previous.source_link || previous.sourceLink || "";

      const previousUrl = normalizeUrl(previousRawUrl);
      const previousIsRotoWire = isRotoWireSource(previous.source);

      // ESPN和Yahoo继续使用链接判重。
      // 只要当前新闻或历史新闻来自RotoWire，
      // 就跳过URL判重，避免球员资料页造成误删。
      if (
        !currentIsRotoWire &&
        !previousIsRotoWire &&
        currentUrl &&
        previousUrl &&
        currentUrl === previousUrl
      ) {
        return {
          duplicate: true,
          reason: "相同新闻链接",
          matchedId: previous.id
        };
      }

      const previousTitle = normalizeTitle(
        previous.original_title || previous.title
      );

      if (!currentTitle || !previousTitle) continue;

      // 标题完全相同：直接判定重复。
      if (currentTitle === previousTitle) {
        return {
          duplicate: true,
          reason: "标题完全相同",
          matchedId: previous.id
        };
      }

      // 标题高度相似，并且发布时间接近，才判定重复。
      if (
        isCloseInTime(
          item.publishedAt,
          previous.published_at || previous.publishedAt
        ) &&
        titleSimilarity(currentTitle, previousTitle) >= 0.88
      ) {
        return {
          duplicate: true,
          reason: "标题高度相似且发布时间接近",
          matchedId: previous.id
        };
      }
    }

    return {
      duplicate: false,
      reason: "",
      matchedId: null
    };
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
    } catch {
      throw new Error(
        "AI返回内容不是有效JSON：" + cleaned.slice(0, 200)
      );
    }
  }

  async function selectDailyNews(candidates, remaining) {
    if (!context.env.AI) {
      throw new Error("没有找到 AI 绑定");
    }

    if (!candidates.length || remaining <= 0) {
      return [];
    }

    const limitedCandidates = candidates.slice(0, 60);

    const compactCandidates = limitedCandidates.map((item, index) => ({
      index,
      title: String(item.title || "").slice(0, 220),
      description: String(item.content || "").slice(0, 450),
      source: item.source
    }));

    const systemPrompt = `You are the chief editor of NBA PLAYER BUZZ, an NBA player news service.

Your job is to select meaningful, genuine news about NBA PLAYERS.

Consider BOTH ON-COURT basketball news AND OFF-COURT personal news.

QUALIFY:
- Game performances, records, milestones and statistics.
- Injuries, recovery and return-to-play news.
- Trades, contracts, free agency and roster moves.
- Suspensions, disciplinary actions and meaningful player incidents.
- Player statements and significant basketball developments.
- Family, relationships, personal life and social media activity.
- Controversies, charity, business ventures, fashion and hobbies.
- Other meaningful events specifically about identifiable NBA players.

REJECT:
- General team or league news without a specific player focus.
- Schedules, routine previews and upcoming match listings.
- Generic promotions and advertisements.
- Betting odds and fantasy advice.
- Pure opinion without a concrete development.
- Duplicate reports about the same event.
- Vague stories without enough information.
- Stories that merely mention a player's name.
- Non-NBA sports news.

EDITORIAL RULES:
1. Consider title and description together.
2. The main subject must be an NBA player.
3. Do not reject meaningful game, injury, trade or contract news.
4. Prefer concrete developments.
5. Do not invent facts.
6. Preserve player names exactly as written.
7. Do not translate titles or descriptions.
8. Avoid multiple reports about the same event.
9. Quality is more important than quantity.
10. Return only candidate index numbers.

Return valid JSON only:
{"selected":[0,2,5]}`;

    const result = await context.env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              requiredMaximum: remaining,
              candidates: compactCandidates
            })
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
        if (Array.isArray(nested)) selectedValues = nested;
      } catch {
        // 保留格式错误提示
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
        indexes.push(index);
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

  // 第一步：采集RSS。
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

  // 第二步：同一轮RSS内部先去重。
  const batchItems = [];
  const batchDuplicates = [];

  for (const item of items) {
    const duplicate = isDuplicateNews(item, batchItems);

    if (duplicate.duplicate) {
      batchDuplicates.push({
        id: item.id,
        title: item.title,
        source: item.source,
        reason: duplicate.reason,
        matchedId: duplicate.matchedId
      });
    } else {
      batchItems.push(item);
    }
  }

  batchItems.sort((a, b) =>
    (Date.parse(b.publishedAt) || 0) -
    (Date.parse(a.publishedAt) || 0)
  );

  // 第三步：读取数据库最近新闻，用于跨批次去重。
  let existingNews = [];

  try {
    const existingResult = await db.prepare(`
      SELECT
        id,
        source,
        source_link,
        original_title,
        published_at,
        review_status
      FROM playerbuzz_items
      ORDER BY COALESCE(published_at, created_at) DESC
      LIMIT 500
    `).all();

    existingNews = existingResult.results || [];
  } catch (error) {
    return json({
      success: false,
      message: "读取已有新闻失败，已停止写入，避免重复保存",
      error: error.message || "数据库读取失败"
    }, 500);
  }

  // 第四步：与数据库中已有新闻比较。
  const finalItems = [];
  const databaseDuplicates = [];

  for (const item of batchItems) {
    const duplicate = isDuplicateNews(item, existingNews);

    if (duplicate.duplicate) {
      databaseDuplicates.push({
        id: item.id,
        title: item.title,
        source: item.source,
        reason: duplicate.reason,
        matchedId: duplicate.matchedId
      });
    } else {
      finalItems.push(item);
    }
  }

  // 第五步：只插入没有重复的新闻。
  // INSERT OR IGNORE 保留原有ID冲突保护。
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

      const changes = insertResult.meta?.changes || 0;
      databaseSaved += changes;
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
        connected: true,
        saved: databaseSaved,
        error: databaseError
      },
      deduplication: {
        collected: items.length,
        removedInFeedBatch: batchDuplicates.length,
        removedAgainstDatabase: databaseDuplicates.length
      },
      errors
    }, 500);
  }

  const today = getBeijingDate();
  const dailyLimit = 20;
  const selectedIds = new Set();

  let newlySelected = 0;
  let selectionError = null;
  let selectionReady = true;
  let aiCalled = false;
  let candidatesSentToAI = 0;
  let aiReturnedSelectionCount = 0;

  // 只撤销今天尚未审核的旧精选资格。
  // 已通过和已拒绝新闻不受影响。
  try {
    await db.prepare(`
      UPDATE playerbuzz_items
      SET
        ai_selected = 0,
        selection_date = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE ai_selected = 1
        AND selection_date = ?
        AND review_status = 'pending'
    `).bind(today).run();

    const selectedResult = await db.prepare(`
      SELECT id
      FROM playerbuzz_items
      WHERE ai_selected = 1
        AND selection_date = ?
        AND review_status = 'approved'
    `).bind(today).all();

    for (const row of selectedResult.results || []) {
      selectedIds.add(String(row.id));
    }

  } catch (error) {
    selectionReady = false;
    selectionError = "重置旧精选或读取已发布精选失败：" +
      (error.message || "数据库操作失败");
    errors.push("AI每日精选：" + selectionError);
  }

  let selectedToday = selectedIds.size;
  const remaining = Math.max(0, dailyLimit - selectedToday);

  // 使用本轮去重后的 finalItems 作为AI候选来源。
  // 只要新闻仍然是 pending 状态，就可以继续参与AI精选。
  // approved 和 rejected 新闻不会进入候选池。
  if (selectionReady && remaining > 0 && finalItems.length > 0) {
    try {
      const candidates = [];

      for (const item of finalItems) {
        const existing = await db.prepare(`
          SELECT
            id,
            review_status,
            original_title,
            original_content
          FROM playerbuzz_items
          WHERE id = ?
        `).bind(String(item.id)).first();

        if (!existing || existing.review_status !== "pending") {
          continue;
        }

        candidates.push({
          ...item,
          title: existing.original_title || item.title || "",
          content: existing.original_content || item.content || ""
        });
      }

      candidatesSentToAI = candidates.length;
      aiCalled = candidatesSentToAI > 0;

      const selectedItems = await selectDailyNews(
        candidates,
        remaining
      );

      aiReturnedSelectionCount = selectedItems.length;

      for (const item of selectedItems) {
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

  // 精选新闻优先返回本轮去重后的全部新闻。
  const orderedItems = [...finalItems].sort((a, b) => {
    const aSelected = selectedIds.has(String(a.id)) ? 1 : 0;
    const bSelected = selectedIds.has(String(b.id)) ? 1 : 0;

    return bSelected - aSelected;
  });

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

  // 读取今天已正式发布的AI精选新闻。
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
    success: true,
    service: "B-BALL Player Buzz",
    mode: "NBA Player News - Deduplication - AI Selection - Auto Publish",
    translationEnabled: false,
    dataSource: feeds.map(feed => feed.name),
    successfulSources,
    total: finalItems.length,
    database: {
      connected: true,
      saved: databaseSaved,
      error: null
    },
    deduplication: {
      collected: items.length,
      removedInFeedBatch: batchDuplicates.length,
      removedAgainstDatabase: databaseDuplicates.length,
      savedNewRecords: databaseSaved,
      batchDuplicateDetails: batchDuplicates,
      databaseDuplicateDetails: databaseDuplicates
    },
    dailySelection: {
      date: today,
      mode: "NBA球员场内及场外动态AI精选后自动发布（英文原文）",
      dailyLimit,
      selectedToday: todayFeatured.length,
      newlySelected,
      candidatesSentToAI,
      aiCalled,
      aiReturnedSelectionCount,
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
  }, 200);
}
