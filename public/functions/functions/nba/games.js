
export async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }

  const apiKey = context.env.API_NINJAS_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "API_NINJAS_KEY is missing"
      }),
      {
        status: 500,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      }
    );
  }

  const requestUrl = new URL(context.request.url);
  const apiUrl = new URL(
    "https://api.api-ninjas.com/v1/basketballgames"
  );

  apiUrl.searchParams.set("league", "nba");

  for (const key of ["date", "season", "team"]) {
    const value = requestUrl.searchParams.get(key);
    if (value) apiUrl.searchParams.set(key, value);
  }

  try {
    const response = await fetch(apiUrl.toString(), {
      headers: {
        "X-Api-Key": apiKey
      }
    });

    const body = await response.text();

    return new Response(body, {
      status: response.status,
      headers: {
        ...cors,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        message: "API request failed"
      }),
      {
        status: 502,
        headers: {
          ...cors,
          "Content-Type": "application/json"
        }
      }
    );
  }
}
