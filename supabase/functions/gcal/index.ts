// Google Calendar: connect once (OAuth), then list today's/this week's events and add events.
import { cors, json, userFrom, admin, env, zoned } from "../_shared/util.ts";

const SCOPES = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const self = () => `${env("SUPABASE_URL")}/functions/v1/gcal`;

async function token(userId: string) {
  const db = admin();
  const { data: row } = await db.from("integrations").select("*").eq("user_id", userId).eq("provider", "gcal").maybeSingle();
  if (!row) return null;
  if (row.access_token && row.expires_at && new Date(row.expires_at).getTime() > Date.now() + 60_000) return row.access_token;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), refresh_token: row.refresh_token, grant_type: "refresh_token" }),
  }).then((x) => x.json());
  if (!r.access_token) return null;
  await db.from("integrations").update({ access_token: r.access_token, expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("user_id", userId).eq("provider", "gcal");
  return r.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const db = admin();

  // 1) Start connecting: /gcal?action=connect&token=<session>&back=<app url>
  if (action === "connect") {
    const user = await userFrom(req, url.searchParams.get("token"));
    if (!user) return new Response("Sign in to the app first.", { status: 401 });
    const state = crypto.randomUUID();
    await db.from("oauth_states").insert({ state, user_id: user.id, provider: "gcal", back: url.searchParams.get("back") });
    const g = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    g.search = new URLSearchParams({ client_id: env("GOOGLE_CLIENT_ID"), redirect_uri: `${self()}?action=callback`, response_type: "code", scope: SCOPES, access_type: "offline", prompt: "consent", state }).toString();
    return Response.redirect(g.toString(), 302);
  }
  // 2) Google sends the user back here.
  if (action === "callback") {
    const state = url.searchParams.get("state") || "";
    const { data: st } = await db.from("oauth_states").select("*").eq("state", state).maybeSingle();
    if (!st) return new Response("This link expired — try Connect again.", { status: 400 });
    await db.from("oauth_states").delete().eq("state", state);
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env("GOOGLE_CLIENT_ID"), client_secret: env("GOOGLE_CLIENT_SECRET"), redirect_uri: `${self()}?action=callback`, grant_type: "authorization_code" }),
    }).then((x) => x.json());
    if (!r.refresh_token) return new Response("Google didn't grant calendar access. Try Connect again.", { status: 400 });
    await db.from("integrations").upsert({ user_id: st.user_id, provider: "gcal", access_token: r.access_token, refresh_token: r.refresh_token, expires_at: new Date(Date.now() + r.expires_in * 1000).toISOString(), updated_at: new Date().toISOString() });
    return Response.redirect(`${st.back || "/"}?connected=gcal#settings`, 302);
  }

  // 3) App calls (POST, signed in)
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first", code: "not_granted" }, 401);
  const at = await token(user.id);
  if (!at) return json({ error: "Google Calendar isn't connected", code: "not_connected" }, 400);
  try {
    const { tool, input = {} } = await req.json();
    const tz = input.timeZone || "America/Los_Angeles";
    const cal = encodeURIComponent(input.calendarId || "primary");
    if (tool === "list_events") {
      const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", maxResults: String(input.pageSize || 250), timeZone: tz });
      if (input.startTime) q.set("timeMin", zoned(input.startTime, tz));
      if (input.endTime) q.set("timeMax", zoned(input.endTime, tz));
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events?${q}`, { headers: { Authorization: `Bearer ${at}` } }).then((x) => x.json());
      if (r.error) return json({ error: r.error.message, code: "tool_error" }, 502);
      return json({ events: (r.items || []).map((e: any) => ({ id: e.id, status: e.status, summary: e.summary, location: e.location, htmlLink: e.htmlLink, start: e.start, end: e.end })) });
    }
    if (tool === "create_event") {
      const body: any = { summary: input.summary, location: input.location, description: input.description };
      if (input.allDay) { body.start = { date: input.startTime.slice(0, 10) }; body.end = { date: input.endTime.slice(0, 10) }; }
      else { body.start = { dateTime: input.startTime, timeZone: tz }; body.end = { dateTime: input.endTime, timeZone: tz }; }
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${cal}/events`, { method: "POST", headers: { Authorization: `Bearer ${at}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
      if (r.error) return json({ error: r.error.message, code: "tool_error" }, 502);
      return json({ id: r.id, htmlLink: r.htmlLink });
    }
    return json({ error: "Unknown calendar request", code: "bad_request" }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e), code: "upstream_error" }, 500);
  }
});
