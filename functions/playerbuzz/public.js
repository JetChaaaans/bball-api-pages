
export async function onRequestGet(context) {
  try {
    const db = context.env.DB;

    if (!db) {
      return Response.json({
        success: false,
        message: "数据库未连接"
      }, { status: 500 });
    }

    const result = await db.prepare(`
      SELECT
        id,
        source,
        chinese_title,
        chinese_content,
        player_name,
        category,
        published_at
      FROM playerbuzz_items
      WHERE review_status = 'approved'
        AND chinese_title IS NOT NULL
        AND chinese_content IS NOT NULL
      ORDER BY
        COALESCE(published_at, created_at) DESC
      LIMIT 50
    `).all();

    const items = result.results || [];

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

