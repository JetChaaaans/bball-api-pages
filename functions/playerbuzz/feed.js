
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

    // 读取全部已审核通过的新闻。
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

    // 英文月份对应数字。
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3,
      may: 4, jun: 5, jul: 6, aug: 7,
      sep: 8, oct: 9, nov: 10, dec: 11
    };

    // 常见 RSS 时区缩写对应 UTC 偏移（分钟）。
    const timeZones = {
      UTC: 0,
      GMT: 0,
      EST: -300,
      EDT: -240,
      CST: -360,
      CDT: -300,
      MST: -420,
      MDT: -360,
      PST: -480,
      PDT: -420
    };

    // 解析 RSS 发布时间。
    function parseRssDate(value) {
      if (!value) return NaN;

      const text = String(value).trim();

      // 兼容：Tue, 24 Nov 2026 00:35:43 +0000
      // 兼容：Thu, 12 Nov 2026 9:29:00 PM PST
      const match = text.match(
        /^(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*(Z|[+-]\d{2}:?\d{2}|[A-Za-z]{2,5})?$/i
      );

      if (match) {
        const day = Number(match[1]);
        const monthName = match[2].toLowerCase();
        const year = Number(match[3]);
        let hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6] || 0);
        const ampm = (match[7] || "").toUpperCase();
        const zone = (match[8] || "UTC").toUpperCase();

        const month = months[monthName];

        if (month === undefined) return NaN;

        // 转换 12 小时制。
        if (ampm === "PM" && hour < 12) {
          hour += 12;
        } else if (ampm === "AM" && hour === 12) {
          hour = 0;
        }

        // 先按 UTC 构造时间。
        const localAsUtc = Date.UTC(
          year,
          month,
          day,
          hour,
          minute,
          second
        );

        let offsetMinutes = 0;

        if (zone === "Z") {
          offsetMinutes = 0;
        } else if (/^[+-]\d{2}:?\d{2}$/.test(zone)) {
          const sign = zone[0] === "+" ? 1 : -1;
          const digits = zone.slice(1).replace(":", "");
          const offsetHours = Number(digits.slice(0, 2));
          const offsetMins = Number(digits.slice(2, 4));

          offsetMinutes = sign * (
            offsetHours * 60 + offsetMins
          );
        } else if (
          Object.prototype.hasOwnProperty.call(timeZones, zone)
        ) {
          offsetMinutes = timeZones[zone];
        } else {
          return NaN;
        }

        // 当地时间减去时区偏移，得到 UTC 时间。
        return localAsUtc - offsetMinutes * 60 * 1000;
      }

      // 兼容 ISO 日期及其他标准日期格式。
      const fallback = Date.parse(text);

      return Number.isFinite(fallback) ? fallback : NaN;
    }

    // 取得新闻排序时间。
    function getNewsTimestamp(item) {
      const publishedTime = parseRssDate(item.published_at);

      if (Number.isFinite(publishedTime)) {
        return publishedTime;
      }

      // 发布时间无法解析时，使用数据库创建时间。
      const createdTime = Date.parse(item.created_at || "");

      if (Number.isFinite(createdTime)) {
        return createdTime;
      }

      return 0;
    }

    // 最新新闻排在最前面。
    items.sort((a, b) => {
      return getNewsTimestamp(b) - getNewsTimestamp(a);
    });

    // 只返回最新的50条新闻。
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
