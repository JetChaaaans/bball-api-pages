
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

    // 详情接口：保持原有逻辑不变。
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

    // 公开列表：读取发布时间和创建时间。
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

    // 将RSS英文日期转换为真实时间戳进行排序。
    function getNewsTimestamp(item) {
      const publishedTime = Date.parse(item.published_at || "");

      if (Number.isFinite(publishedTime)) {
        return publishedTime;
      }

      const createdTime = Date.parse(item.created_at || "");

      if (Number.isFinite(createdTime)) {
        return createdTime;
      }

      return 0;
    }

    // 最新发布时间排在最前面。
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
