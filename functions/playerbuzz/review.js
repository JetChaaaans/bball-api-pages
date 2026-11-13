
export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password"
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

  if (!["GET", "POST"].includes(context.request.method)) {
    return json({ success: false, message: "不支持的请求方式" }, 405);
  }

  // 验证管理员密码
  const adminPassword = context.env.ADMIN_PASSWORD;
  const inputPassword = context.request.headers.get("X-Admin-Password");

  if (!adminPassword) {
    return json({
      success: false,
      message: "服务器未配置 ADMIN_PASSWORD"
    }, 500);
  }

  if (!inputPassword || inputPassword !== adminPassword) {
    return json({
      success: false,
      message: "管理员密码错误或未提供"
    }, 401);
  }

  const db = context.env.DB;

  if (!db) {
    return json({
      success: false,
      message: "数据库 DB 未绑定"
    }, 500);
  }

  try {
    // 获取审核列表
    if (context.request.method === "GET") {
      const url = new URL(context.request.url);
      const status = url.searchParams.get("status") || "pending";

      const allowedStatuses = ["pending", "approved", "rejected", "all"];

      if (!allowedStatuses.includes(status)) {
        return json({
          success: false,
          message: "status 参数无效"
        }, 400);
      }

      let result;

      if (status === "all") {
        result = await db.prepare(`
          SELECT * FROM playerbuzz_items
          ORDER BY published_at DESC
          LIMIT 100
        `).all();
      } else {
        result = await db.prepare(`
          SELECT * FROM playerbuzz_items
          WHERE review_status = ?
          ORDER BY published_at DESC
          LIMIT 100
        `).bind(status).all();
      }

      return json({
        success: true,
        total: result.results.length,
        items: result.results
      });
    }

    // 提交审核操作
    if (context.request.method === "POST") {
      let body;

      try {
        body = await context.request.json();
      } catch {
        return json({
          success: false,
          message: "请求内容不是有效的 JSON"
        }, 400);
      }

      const {
        id,
        action,
        chinese_title,
        chinese_content,
        player_name,
        category
      } = body;

      if (!id || !["approve", "reject"].includes(action)) {
        return json({
          success: false,
          message: "缺少新闻 ID 或审核操作无效"
        }, 400);
      }

      const existing = await db.prepare(`
        SELECT id FROM playerbuzz_items WHERE id = ?
      `).bind(String(id)).first();

      if (!existing) {
        return json({
          success: false,
          message: "没有找到这条新闻"
        }, 404);
      }

      if (action === "approve") {
        await db.prepare(`
          UPDATE playerbuzz_items
          SET
            chinese_title = COALESCE(?, chinese_title),
            chinese_content = COALESCE(?, chinese_content),
            player_name = COALESCE(?, player_name),
            category = COALESCE(?, category),
            review_status = 'approved',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          chinese_title ?? null,
          chinese_content ?? null,
          player_name ?? null,
          category ?? null,
          String(id)
        ).run();
      } else {
        await db.prepare(`
          UPDATE playerbuzz_items
          SET
            review_status = 'rejected',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(String(id)).run();
      }

      return json({
        success: true,
        message: action === "approve" ? "审核通过" : "已拒绝",
        id: String(id)
      });
    }

  } catch (error) {
    return json({
      success: false,
      message: error.message || "服务器处理失败"
    }, 500);
  }
}

