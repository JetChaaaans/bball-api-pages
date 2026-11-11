export async function onRequest(context) {
  return new Response(
    JSON.stringify({
      success: true,
      service: "B-BALL API",
      dataSource: "API Ninjas",
      message: "篮球数据接口运行正常"
    }),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*"
      }
    }
  );
}
