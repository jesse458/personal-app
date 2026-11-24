// Steps from iPhone (Apple Health) via an iOS Shortcut.
// - The app (signed in) calls { action: "token" } to get a private token for the Shortcut.
// - The Shortcut POSTs { steps, date? } with header "x-steps-token: <token>".
//   The count is saved to the app's `app/steps` document, and the app updates live.
import { cors, json, userFrom, admin, localNow } from "../_shared/util.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  const body = await req.json().catch(() => ({}));

  const token = req.headers.get("x-steps-token") || body.token;
  if (token) {
    const { data: t } = await db.from("step_tokens").select("user_id").eq("token", token).maybeSingle();
    if (!t) return json({ error: "Unknown token" }, 401);
    const steps = Math.round(Number(String(body.steps ?? "").replace(/[^\d.]/g, "")));
    if (!Number.isFinite(steps) || steps < 0 || steps > 200000) return json({ error: "Send a step count" }, 400);
    const { data: st } = await db.from("app_docs").select("data").eq("user_id", t.user_id).eq("path", "app/settings").maybeSingle();
    const tz = st?.data?.items?.tz || "America/Los_Angeles";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : localNow(tz).date;
    const { data: cur } = await db.from("app_docs").select("data").eq("user_id", t.user_id).eq("path", "app/steps").maybeSingle();
    const items = { ...(cur?.data?.items || {}) };
    // Never lower today's count from a stale run.
    items[date] = Math.max(Number(items[date]) || 0, steps);
    items._at = new Date().toISOString();
    items._src = "iPhone";
    await db.from("app_docs").upsert({ user_id: t.user_id, path: "app/steps", data: { items, at: Date.now() }, updated_at: new Date().toISOString() });
    return json({ ok: true, date, steps: items[date] });
  }

  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first", code: "not_granted" }, 401);
  if (body.action === "token") {
    const { data: t } = await db.from("step_tokens").select("token").eq("user_id", user.id).maybeSingle();
    if (t && !body.reset) return json({ token: t.token });
    const fresh = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await db.from("step_tokens").upsert({ user_id: user.id, token: fresh }, { onConflict: "user_id" });
    return json({ token: fresh });
  }
  return json({ error: "Unknown request", code: "bad_request" }, 400);
});
