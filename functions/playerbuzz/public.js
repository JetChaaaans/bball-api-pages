
export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return Response.json({
        success: false,
        message: "数据库未连接"
      }, { status: 500 });
    }

    const url = new URL(context.request.url);
    const id = url.searchParams.get("id");

    const selectFields = `
      id,
      source,
      COALESCE(NULLIF(original_title, ''), chinese_title) AS title,
      COALESCE(NULLIF(original_content, ''), chinese_content) AS content,
      original_title,
      original_content,
      player_name,
      category,
      published_at
    `;

    // 新闻详情接口：保持原有逻辑。
    if (id) {
      const result = await db.prepare(`
        SELECT ${selectFields}
        FROM playerbuzz_items
        WHERE id = ?
          AND review_status = 'approved'
        LIMIT 1
      `).bind(id).first();

      if (!result) {
        return Response.json({
          success: false,
          message: "未找到这条新闻"
        }, { status: 404 });
      }

      return Response.json({
        success: true,
        item: result
      });
    }

    // 新闻列表：同时读取创建时间，作为发布时间异常时的备用时间。
    const queryResult = await db.prepare(`
      SELECT
        ${selectFields},
        created_at
      FROM playerbuzz_items
      WHERE review_status = 'approved'
        AND COALESCE(NULLIF(original_title, ''), chinese_title) IS NOT NULL
        AND COALESCE(NULLIF(original_content, ''), chinese_content) IS NOT NULL
    `).all();

    const items = queryResult.results || [];

    // 常见英文时区缩写对应的 UTC 分钟偏移。
    const timezoneOffsets = {
      UTC: 0,
      GMT: 0,
      EST: -300,
      EDT: -240,
      CST: -360,
      CDT: -300,
      MST: -420,
      MDT: -360,
      PST: -480,
      PDT: -420,
      CET: 60,
      CEST: 120,
      BST: 60
    };

    const monthNumbers = {
      JAN: 0,
      FEB: 1,
      MAR: 2,
      APR: 3,
      MAY: 4,
      JUN: 5,
      JUL: 6,
      AUG: 7,
      SEP: 8,
      OCT: 9,
      NOV: 10,
      DEC: 11
    };

    // 将不同格式的 RSS 日期转换成统一时间戳。
    function parseRssDate(value) {
      if (!value) {
        return null;
      }

      const text = String(value).trim();

      // 优先处理常见的英文 RSS 日期格式。
      const match = text.match(
        /^(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5})?$/i
      );

      if (match) {
        const day = Number(match[1]);
        const month = monthNumbers[match[2].toUpperCase()];
        const year = Number(match[3]);

        let hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6] || 0);

        const ampm = (match[7] || "").toUpperCase();
        const timezone = (match[8] || "UTC").toUpperCase();

        if (month === undefined) {
          return null;
        }

        // 处理 AM / PM。
        if (ampm === "AM" && hour === 12) {
          hour = 0;
        } else if (ampm === "PM" && hour !== 12) {
          hour += 12;
        }

        // 先按 UTC 构造时间。
        let timestamp = Date.UTC(
          year,
          month,
          day,
          hour,
          minute,
          second
        );

        let offset = 0;

        // 处理 +0000、-0500、+08:00 等数字时区。
        if (/^[+-]\d{2}:?\d{2}$/.test(timezone)) {
          const sign = timezone[0] === "+" ? 1 : -1;
          const digits = timezone.slice(1).replace(":", "");
          const offsetHour = Number(digits.slice(0, 2));
          const offsetMinute = Number(digits.slice(2, 4));

          offset = sign * (
            offsetHour * 60 + offsetMinute
          );
        } else if (timezone === "Z") {
          offset = 0;
        } else if (
          Object.prototype.hasOwnProperty.call(
            timezoneOffsets,
            timezone
          )
        ) {
          offset = timezoneOffsets[timezone];
        } else {
          return null;
        }

        // 将当地时间换算成 UTC 时间。
        timestamp -= offset * 60 * 1000;

        return Number.isFinite(timestamp) ? timestamp : null;
      }

      // 其他日期格式交给 JavaScript 解析。
      const parsed = Date.parse(text);

      return Number.isFinite(parsed) ? parsed : null;
    }

    // 获取新闻真实发布时间；异常时使用数据库创建时间。
    function getNewsTimestamp(item) {
      const publishedTimestamp = parseRssDate(
        item.published_at
      );

      if (publishedTimestamp !== null) {
        return publishedTimestamp;
      }

      const createdTimestamp = Date.parse(
        item.created_at || ""
      );

      if (Number.isFinite(createdTimestamp)) {
        return createdTimestamp;
      }

      return 0;
    }

    // 按真实时间戳降序排列：最新新闻在最前面。
    items.sort((a, b) => {
      return getNewsTimestamp(b) - getNewsTimestamp(a);
    });

    // 只返回最新的 50 条新闻。
    const latestItems = items.slice(0, 50).map(item => {
      const { created_at, ...news } = item;
      return news;
    });

    return Response.json({
      success: true,
      total: latestItems.length,
      items: latestItems
    });

  } catch (error) {
    return Response.json({
      success: false,
      message: error.message
    }, { status: 500 });
  }
}
