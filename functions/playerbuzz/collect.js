
export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Collect-Secret",
    "Content-Type": "application/json; charset=utf-8"
  };

  function json(data, status = 200) {
    return new Response(JSON.stringify(data, null, 2), {
      status,
      headers: {
        ...cors,
        "Cache-Control": "no-store"
      }
    });
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  if (request.method !== "POST") {
    return json({
      success: false,
      message: "只支持 POST 请求"
    }, 405);
  }

  // 验证自动采集密钥
  const suppliedSecret = request.headers.get("X-Collect-Secret");

  if (
    !env.COLLECT_SECRET ||
    !suppliedSecret ||
    suppliedSecret !== env.COLLECT_SECRET
  ) {
    return json({
      success: false,
      message: "无权访问"
    }, 401);
  }

  if (!env.DB) {
    return json({
      success: false,
      message: "D1 数据库未绑定"
    }, 500);
  }

  if (!env.AI) {
    return json({
      success: false,
      message: "Workers AI 未绑定"
    }, 500);
  }

  const db = env.DB;

  const SOURCES = [
    {
      name: "ESPN",
      url: "https://www.espn.com/espn/rss/nba/news"
    },
    {
      name: "RotoWire",
      url: "https://www.rotowire.com/rss/news.php?sport=NBA"
    },
    {
      name: "Yahoo Sports",
      url: "https://sports.yahoo.com/nba/rss/"
    }
  ];

  // 每次定时任务最多处理8条新新闻
  const MAX_NEW_ITEMS_PER_RUN = 8;

  // 清理 HTML 和 RSS 特殊字符
  function cleanText(value = "") {
    return String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
      .replace(/<[^>]*>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&#(\d+);/g, (_, n) => {
        const number = Number(n);
        return number <= 1114111
          ? String.fromCodePoint(number)
          : "";
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
        String.fromCodePoint(parseInt(n, 16))
      )
      .replace(/\s+/g, " ")
      .trim();
  }

  // 提取 XML 标签
  function getTag(xml, tag) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const match = xml.match(
      new RegExp(
        "<" + escaped + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + escaped + "\\s*>",
        "i"
      )
    );

    return match ? cleanText(match[1]) : "";
  }

  // 生成稳定的新闻 ID
  async function makeId(source, link, title) {
    const raw = source + "|" + (link || title);

    const bytes = new TextEncoder().encode(raw);
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    const hex = Array.from(new Uint8Array(digest))
      .map(value => value.toString(16).padStart(2, "0"))
      .join("");

    return "nba_" + hex.slice(0, 32);
  }

  // 抓取一个 RSS 来源
  async function fetchRSS(source) {
    const response = await fetch(source.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 B-BALL-News-Reader/1.0",
        "Accept": "application/rss+xml, application/xml, text/xml, */*"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const xml = await response.text();

    const entries = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

    return entries.slice(0, 20).map(item => {
      const title = getTag(item, "title");

      const content =
        getTag(item, "description") ||
        getTag(item, "content:encoded");

      const link = getTag(item, "link");

      const guid = getTag(item, "guid");

      const publishedAt =
        getTag(item, "pubDate") ||
        getTag(item, "dc:date");

      return {
        source: source.name,
        title,
        content,
        link: link || guid,
        publishedAt
      };
    }).filter(item => item.title && (item.content || item.link));
  }

  // AI 生成中文新闻
  async function translateNews(item) {
    const prompt = `
你是专业的 NBA 中文体育新闻编辑。

请根据提供的英文新闻标题和原文内容，生成中文新闻。

必须遵守：
1. 球员姓名一律保留英文，例如 LeBron James、Stephen Curry。
2. 球队名称可以使用通用中文名称。
3. 准确翻译伤病、比赛、交易、阵容和数据等信息。
4. 不得编造比分、数据、比赛过程、球员发言或背景事实。
5. 不得把推测写成事实。
6. 中文内容分为「新闻事实」和「背景与影响」两个部分。
7. 背景与影响只能依据原文中明确提供的信息进行分析。
8. 如果原文信息不足，应明确说明目前公开信息有限，不要自行扩写事实。
9. 不得照搬或补写来源网站未提供的文章内容。
10. 只返回合法 JSON，不要使用 Markdown 代码块。

返回格式：
{
  "chinese_title": "中文标题",
  "chinese_content": "新闻事实：...\\n\\n背景与影响：...",
  "player_name": "英文球员姓名；无法确定时为空字符串",
  "category": "球员动态"
}

新闻来源：${item.source}

英文标题：
${item.title}

英文原文：
${item.content}
`;

    const result = await env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          {
            role: "system",
            content: "你是严谨的 NBA 新闻编辑。只输出符合要求的 JSON。"
          },
          {
            role: "user",
            content: prompt
          }
        ]
      }
    );

    let output = result.response || "";

    output = output
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("AI 返回内容不是有效 JSON");
    }

    const data = JSON.parse(output.slice(start, end + 1));

    if (
      !data.chinese_title ||
      !data.chinese_content
    ) {
      throw new Error("AI 缺少中文标题或新闻内容");
    }

    return {
      chinese_title: String(data.chinese_title).slice(0, 300),
      chinese_content: String(data.chinese_content).slice(0, 12000),
      player_name: String(data.player_name || "").slice(0, 150),
      category: String(data.category || "球员动态").slice(0, 100)
    };
  }

  const report = {
    success: true,
    service: "B-BALL Player Buzz Collector",
    sources: [],
    fetched: 0,
    inserted: 0,
    duplicated: 0,
    aiFailed: 0,
    errors: []
  };

  const candidates = [];

  // 第一阶段：抓取三个来源
  for (const source of SOURCES) {
    try {
      const items = await fetchRSS(source);

      report.fetched += items.length;

      report.sources.push({
        name: source.name,
        count: items.length,
        success: true
      });

      for (const item of items) {
        candidates.push(item);
      }
    } catch (error) {
      report.sources.push({
        name: source.name,
        count: 0,
        success: false,
        error: error.message
      });

      report.errors.push(
        source.name + " 抓取失败：" + error.message
      );
    }
  }

  // 第二阶段：去重、AI 处理和写入 D1
  for (const item of candidates) {
    if (report.inserted >= MAX_NEW_ITEMS_PER_RUN) {
      break;
    }

    try {
      const id = await makeId(
        item.source,
        item.link,
        item.title
      );

      // 同时检查 ID、原文链接和同来源标题
      const existing = await db.prepare(`
        SELECT id
        FROM playerbuzz_items
        WHERE id = ?
           OR (? != '' AND source_link = ?)
           OR (source = ? AND original_title = ?)
        LIMIT 1
      `).bind(
        id,
        item.link || "",
        item.link || "",
        item.source,
        item.title
      ).first();

      if (existing) {
        report.duplicated++;
        continue;
      }

      // AI 处理失败时不写入，留待下一轮重试
      let translated;

      try {
        translated = await translateNews(item);
      } catch (error) {
        report.aiFailed++;

        report.errors.push(
          item.source + " AI 处理失败：" +
          item.title + "：" + error.message
        );

        continue;
      }

      await db.prepare(`
        INSERT OR IGNORE INTO playerbuzz_items (
          id,
          source,
          source_link,
          original_title,
          original_content,
          chinese_title,
          chinese_content,
          player_name,
          category,
          published_at,
          review_status,
          ai_selected
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0)
      `).bind(
        id,
        item.source,
        item.link || "",
        item.title,
        item.content || "",
        translated.chinese_title,
        translated.chinese_content,
        translated.player_name,
        translated.category,
        item.publishedAt || ""
      ).run();

      report.inserted++;

    } catch (error) {
      report.errors.push(
        item.source + " 入库失败：" +
        item.title + "：" + error.message
      );
    }
  }

  report.message = "新闻采集任务执行完成";
  report.maxPerRun = MAX_NEW_ITEMS_PER_RUN;
  report.finishedAt = new Date().toISOString();

  return json(report);
}

