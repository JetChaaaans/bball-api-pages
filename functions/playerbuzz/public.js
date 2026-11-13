
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

    let result;

    if (id) {
      result = await db.prepare(`
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

    const queryResult = await db.prepare(`
      SELECT ${selectFields}
      FROM playerbuzz_items
      WHERE review_status = 'approved'
        AND COALESCE(NULLIF(original_title, ''), chinese_title) IS NOT NULL
        AND COALESCE(NULLIF(original_content, ''), chinese_content) IS NOT NULL
      ORDER BY
        COALESCE(published_at, created_at) DESC
      LIMIT 50
    `).all();

    const items = queryResult.results || [];

    return Response.json({
      success: true,
      total: items.length,
      items: items
    });

  } catch (error) {
    return Response.json({
      success: false,
      message: error.message
    }, { status: 500 });
  }
}
