// AI assistant proxy: keeps your Anthropic key on the server.
import { cors, json, userFrom, env } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first", code: "not_granted" }, 401);
  try {
    const { messages, tools, system } = await req.json();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
        max_tokens: 1500,
        system: system || "You are the assistant inside the user's personal life app. Be brief and warm.",
        messages,
        ...(tools && tools.length ? { tools } : {}),
      }),
    });
    const body = await r.json();
    if (!r.ok) return json({ error: body?.error?.message || "AI error", code: r.status === 429 ? "rate_limited" : "upstream_error" }, 502);
    return json(body);
  } catch (e) {
    return json({ error: String(e?.message || e), code: "upstream_error" }, 500);
  }
});
