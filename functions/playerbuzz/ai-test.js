
export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

  if (context.request.method !== "POST") {
    return json({
      success: false,
      message: "只支持 POST 请求"
    }, 405);
  }

  const adminPassword = context.env.ADMIN_PASSWORD;
  const inputPassword = context.request.headers.get("X-Admin-Password");

  if (!adminPassword || !inputPassword || inputPassword !== adminPassword) {
    return json({
      success: false,
      message: "管理员密码错误或未提供"
    }, 401);
  }

  if (!context.env.AI) {
    return json({
      success: false,
      message: "没有找到 AI 绑定"
    }, 500);
  }

  try {
    const body = await context.request.json();
    const text = String(body.text || "").trim();

    if (!text || text.length > 1000) {
      return json({
        success: false,
        message: "测试文本不能为空，且不能超过1000个字符"
      }, 400);
    }

    const result = await context.env.AI.run(
      "@cf/zai-org/glm-4.7-flash",
      {
        messages: [
          {
            role: "system",
            content: "你是一名专业的NBA篮球新闻翻译。请将英文准确翻译成自然流畅的简体中文。保留球员姓名、球队名称和篮球专业术语。只输出最终中文译文，不要展示分析过程，不要解释，不要添加原文没有的信息。"
          },
          {
            role: "user",
            content: text
          }
        ],
        chat_template_kwargs: {
          enable_thinking: false,
          clear_thinking: true
        },
        max_completion_tokens: 500,
        temperature: 0.2
      }
    );

    const translatedText =
      result?.choices?.[0]?.message?.content ||
      result?.response ||
      result?.output_text ||
      "";

    if (typeof translatedText !== "string" || !translatedText.trim()) {
      return json({
        success: false,
        message: "AI 已响应，但没有返回中文译文。",
        rawResult: result
      }, 502);
    }

    return json({
      success: true,
      model: "@cf/zai-org/glm-4.7-flash",
      originalText: text,
      translatedText: translatedText.trim()
    });

  } catch (error) {
    return json({
      success: false,
      message: error.message || "AI 翻译测试失败"
    }, 500);
  }
}
