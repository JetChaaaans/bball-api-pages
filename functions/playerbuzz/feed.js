
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

  // AI每日精选：同时判断NBA球员的场内和场外新闻。
  async function selectDailyNews(candidates, remaining) {
    if (!context.env.AI) {
      throw new Error("没有找到 AI 绑定");
    }

    if (!candidates.length || remaining <= 0) {
      return [];
    }

    // 不再用关键词提前排除比赛、伤病、交易等新闻。
    // 所有候选新闻统一交由AI进行语义判断。
    const limitedCandidates = candidates.slice(0, 60);

    if (!limitedCandidates.length) {
      return [];
    }

    const compactCandidates = limitedCandidates.map((item, index) => ({
      index,
      title: String(item.title || "").slice(0, 220),
      description: String(item.content || "").slice(0, 450),
      source: item.source
    }));

    const systemPrompt = `You are the chief editor of NBA PLAYER BUZZ, an NBA player news service.

Your job is to select meaningful, genuine news about NBA PLAYERS.

IMPORTANT:
This is NOT an off-court-only gossip service.
You must consider BOTH ON-COURT basketball news AND OFF-COURT personal news.

A story can qualify if it is genuinely about an identifiable NBA player and reports a meaningful event, development, performance, or activity.

CATEGORY A - ON-COURT AND BASKETBALL NEWS:

Select meaningful player-related basketball news, including:
- Game performances, scoring, rebounds, assists, steals, blocks and other statistics.
- Outstanding performances, game-winning plays and important individual contributions.
- Career highs, records, milestones and historical achievements.
- Player performance analysis and significant changes in playing form.
- Injuries, medical updates, rehabilitation, recovery and return-to-play news.
- Suspensions, disciplinary actions and player-related incidents.
- Trades, transfer rumors, roster moves, contract extensions, free agency and salary developments.
- Player conflicts, rivalries and meaningful incidents during games.
- Significant statements by players about basketball, teammates, opponents or their teams.
- Individual player stories connected to important NBA events.

CATEGORY B - OFF-COURT AND PERSONAL NEWS:

Select meaningful personal or lifestyle news, including:
- Family, partners, marriage, relationships, children and personal life.
- Social media posts, online interactions, viral moments and public reactions.
- Controversies, disputes, arguments and incidents outside games.
- Charity, philanthropy, community activities and personal causes.
- Business ventures, investments, endorsements and personal brands.
- Fashion, hobbies, entertainment appearances and lifestyle activities.
- Legal or personal incidents involving a player, when supported by the article.

STRICTLY REJECT:

- General team news that does not focus on a specific NBA player.
- General league announcements without meaningful player-related information.
- Game schedules, routine previews and upcoming match listings.
- Generic team promotions, advertisements and sponsor announcements.
- Generic rankings, betting odds and fantasy basketball advice without meaningful player news.
- Pure opinion pieces that contain no concrete player-related development.
- Duplicate reports about the same event.
- Vague headlines or descriptions that do not provide enough information to understand the story.
- Articles that merely mention a player's name without making that player the actual subject.
- Non-NBA sports news or stories about people who are not NBA players.

EDITORIAL RULES:

1. Consider both the title and description together.
2. Identify the actual subject of each story. The main subject must be an NBA player.
3. Do not reject a story just because it concerns a game, injury, suspension, trade or contract. These are valid categories of NBA player news.
4. Do not select a story merely because it contains an NBA player's name.
5. Prefer concrete events, developments and meaningful information over routine updates.
6. If the description is too vague to establish what happened, reject it.
7. Avoid selecting multiple reports about the same event.
8. Select a balanced mix of on-court and off-court stories when good candidates are available. Do not force a balance when one category has no good news.
9. Quality is more important than quantity. Select fewer than the maximum when appropriate, including zero.
10. Never invent facts or add information that is not in the supplied title or description.
11. Preserve player names exactly as written in the original source.
12. Do not translate titles or descriptions.
13. Return only candidate index numbers, not titles or explanations.

Return valid JSON only, with no Markdown or extra text.
Required format: {"selected":[0,2,5]}`;

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

  let newlySelected = 0;
  let selectionError = null;
  let selectionReady = true;
  let aiCalled = false;
  let candidatesSentToAI = 0;
  let aiReturnedSelectionCount = 0;

  // 第一步：撤销今天尚未审核的旧精选资格。
  // 只处理 pending，不影响 approved 和 rejected。
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

    // 第二步：统计今天已经正式发布的AI精选新闻。
    // 已通过的新闻保留并计入每日20条上限。
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

  // 第三步：把所有普通待审核新闻交给AI判断。
  // 不再提前排除场内新闻或场外新闻。
  if (selectionReady && remaining > 0) {
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

        // 只处理普通待审核新闻。
        // 已通过、已拒绝的新闻绝不重新处理。
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

        // 自动发布：设置为 approved。
        // public.js 会读取 approved 新闻。
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

  // 返回英文原文，不调用AI翻译
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

  // 读取今天已经正式发布的AI精选新闻
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
    mode: "NBA Player News - On-Court & Off-Court - AI Selection - Auto Publish",
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
  }, finalItems.length > 0 ? 200 : 502);
}
