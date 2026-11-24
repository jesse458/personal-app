// Strava: connect once (OAuth), then list recent activities (Whoop workouts show up here too).
import { cors, json, userFrom, admin, env } from "../_shared/util.ts";

const self = () => `${env("SUPABASE_URL")}/functions/v1/strava`;
const PACE = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike", "Wheelchair"]);

async function token(userId: string) {
  const db = admin();
  const { data: row } = await db.from("integrations").select("*").eq("user_id", userId).eq("provider", "strava").maybeSingle();
  if (!row) return null;
  if (row.access_token && new Date(row.expires_at).getTime() > Date.now() + 60_000) return { at: row.access_token, row };
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("STRAVA_CLIENT_ID"), client_secret: env("STRAVA_CLIENT_SECRET"), grant_type: "refresh_token", refresh_token: row.refresh_token }),
  }).then((x) => x.json());
  if (!r.access_token) return null;
  await db.from("integrations").update({ access_token: r.access_token, refresh_token: r.refresh_token, expires_at: new Date(r.expires_at * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId).eq("provider", "strava");
  return { at: r.access_token, row };
}

const mi = (m: number) => Math.round((m / 1609.344) * 100) / 100;
const paceDisp = (secPerMile: number) => `${Math.floor(secPerMile / 60)}:${String(Math.round(secPerMile % 60)).padStart(2, "0")} /mi`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const db = admin();

  if (action === "connect") {
    const user = await userFrom(req, url.searchParams.get("token"));
    if (!user) return new Response("Sign in to the app first.", { status: 401 });
    const state = crypto.randomUUID();
    await db.from("oauth_states").insert({ state, user_id: user.id, provider: "strava", back: url.searchParams.get("back") });
    const s = new URL("https://www.strava.com/oauth/authorize");
    s.search = new URLSearchParams({ client_id: env("STRAVA_CLIENT_ID"), redirect_uri: `${self()}?action=callback`, response_type: "code", scope: "read,activity:read_all", approval_prompt: "auto", state }).toString();
    return Response.redirect(s.toString(), 302);
  }
  if (action === "callback") {
    const state = url.searchParams.get("state") || "";
    const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
    if (!st) return new Response("This link expired — try Connect again.", { status: 400 });
    await db.from("oauth_states").delete().eq("state", state);
    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: env("STRAVA_CLIENT_ID"), client_secret: env("STRAVA_CLIENT_SECRET"), code: url.searchParams.get("code"), grant_type: "authorization_code" }),
    }).then((x) => x.json());
    if (!r.access_token) return new Response("Strava didn't grant access. Try Connect again.", { status: 400 });
    await db.from("integrations").upsert({ user_id: st.user_id, provider: "strava", access_token: r.access_token, refresh_token: r.refresh_token, expires_at: new Date(r.expires_at * 1000).toISOString(), meta: { desc: {} }, updated_at: new Date().toISOString() });
    return Response.redirect(`${st.back || "/"}?connected=strava#settings`, 302);
  }

  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first", code: "not_granted" }, 401);
  const t = await token(user.id);
  if (!t) return json({ error: "Strava isn't connected", code: "not_connected" }, 400);
  try {
    const { tool, input = {} } = await req.json();
    if (tool !== "list_activities") return json({ error: "Unknown Strava request", code: "bad_request" }, 400);
    const per = Math.min(100, input.first || 30);
    const list = await fetch(`https://www.strava.com/api/v3/athlete/activities?per_page=${per}`, { headers: { Authorization: `Bearer ${t.at}` } }).then((x) => x.json());
    if (!Array.isArray(list)) return json({ error: list?.message || "Strava error", code: "tool_error" }, 502);
    // Descriptions (where Whoop writes strain) need a detail call; cache them, fetch at most 8 new per refresh.
    const desc: Record<string, string> = (t.row.meta && t.row.meta.desc) || {};
    let fetched = 0;
    for (const a of list.slice(0, 15)) {
      const id = String(a.id);
      if (desc[id] === undefined && fetched < 8) {
        fetched++;
        const d = await fetch(`https://www.strava.com/api/v3/activities/${id}`, { headers: { Authorization: `Bearer ${t.at}` } }).then((x) => x.json()).catch(() => null);
        desc[id] = (d && d.description) || "";
        if (d && d.calories) (a as any)._cal = d.calories;
      }
    }
    if (fetched) await db.from("integrations").update({ meta: { ...(t.row.meta || {}), desc } }).eq("user_id", user.id).eq("provider", "strava");
    const activities = list.map((a: any) => {
      const miles = mi(a.distance || 0);
      const s: any = { distance: miles, moving_time: a.moving_time, elapsed_time: a.elapsed_time, elevation_gain: Math.round((a.total_elevation_gain || 0) * 3.28084) };
      if (miles) s.distance_display = `${miles.toFixed(2)} mi`;
      if (PACE.has(a.sport_type) && miles > 0.1) s.avg_pace_display = paceDisp(a.moving_time / miles);
      if (a._cal) s.total_calories = a._cal; else if (a.kilojoules) s.total_calories = Math.round(a.kilojoules);
      return { id: String(a.id), name: a.name, description: desc[String(a.id)] || "", sport_type: a.sport_type, start_local: String(a.start_date_local || "").replace("Z", ""), summary: s };
    });
    return json({ activities });
  } catch (e) {
    return json({ error: String(e?.message || e), code: "upstream_error" }, 500);
  }
});
