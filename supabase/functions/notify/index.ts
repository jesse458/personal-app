// Notifications. Runs every 15 minutes (pg_cron) and sends web-push messages:
//  - reminders when they come due
//  - booked appointments 1 hour before
//  - the morning brief at your chosen time (weather, today, upkeep due, birthdays, gifts)
//  - Sunday 6:45pm workout-plan check
// Also answers the app: { test: true } sends a test push; { status: true } reports connected accounts.
import webpush from "npm:web-push@3.6.7";
import { cors, json, userFrom, admin, localNow } from "../_shared/util.ts";

// Keys for web push and the cron secret live in a private table, created on first use.
async function cfg() {
  const db = admin();
  const { data } = await db.from("app_config").select("key,value");
  const c: Record<string, string> = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
  if (!c.vapid_public || !c.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    await db.from("app_config").upsert([{ key: "vapid_public", value: k.publicKey }, { key: "vapid_private", value: k.privateKey }]);
    c.vapid_public = k.publicKey; c.vapid_private = k.privateKey;
  }
  return c;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;
const dnum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const daysBetween = (a: string, b: string) => Math.round((dnum(b) - dnum(a)) / DAY);
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const mins = (hhmm: string) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
function nextYearly(today: string, month: string, day: number) {
  const y = +today.slice(0, 4), m = MONTHS.indexOf(month);
  let d = ymd(Date.UTC(y, m, day));
  if (d < today) d = ymd(Date.UTC(y + 1, m, day));
  return d;
}
const fmt = (d: string) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const wdName = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

async function docs(userId: string) {
  const { data } = await admin().from("app_docs").select("path,data").eq("user_id", userId);
  const o: Record<string, any> = {};
  for (const r of data || []) o[r.path.replace(/^app\//, "")] = r.data?.items;
  return o;
}

async function sendTo(userId: string, msg: { title: string; body: string; url?: string; tag?: string }) {
  const db = admin();
  const { data: subs } = await db.from("push_subs").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(msg), { TTL: 3600 });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subs").delete().eq("endpoint", s.endpoint);
    }
  }
  return sent;
}

// Send once per key.
async function once(userId: string, key: string, msg: { title: string; body: string; url?: string; tag?: string }) {
  const db = admin();
  const { error } = await db.from("notif_log").insert({ user_id: userId, key });
  if (error) return false; // already sent
  await sendTo(userId, msg);
  return true;
}

async function weatherLine(city: string) {
  try {
    let lat: number, lon: number;
    const m = city.match(/^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$/);
    if (m) { lat = +m[1]; lon = +m[2]; } else {
      const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city.split(",")[0])}`).then((x) => x.json());
      if (!g.results?.length) return "";
      lat = g.results[0].latitude; lon = g.results[0].longitude;
    }
    const f = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1&temperature_unit=fahrenheit&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max`).then((x) => x.json());
    const al = await fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, { headers: { "User-Agent": "PersonalApp (personal use)" } }).then((x) => x.ok ? x.json() : null).catch(() => null);
    const alert = al?.features?.[0]?.properties?.event;
    return `${Math.round(f.daily.temperature_2m_max[0])}°/${Math.round(f.daily.temperature_2m_min[0])}°, ${f.daily.precipitation_probability_max[0] ?? 0}% rain${alert ? ` · ${alert}` : ""}`;
  } catch { return ""; }
}

async function runFor(userId: string, tz: string) {
  const D = await docs(userId);
  const S = D.settings || {};
  tz = S.tz || tz || "America/Los_Angeles";
  const { date: today, time } = localNow(tz);
  const nowM = mins(time);
  const out: string[] = [];

  // Reminders: due within the last 15 minutes (or overdue and never sent).
  for (const r of D.reminders || []) {
    const w = String(r.when || "");
    if (!w) continue;
    const d = w.slice(0, 10), m = mins(w.slice(11, 16) || "00:00");
    if (d < today || (d === today && m <= nowM)) {
      if (await once(userId, `rem:${r.id}:${w}`, { title: "Reminder", body: r.title, url: "./#todos", tag: `rem-${r.id}` })) out.push("rem");
    }
  }
  // Booked appointments: one hour before (or at the brief if all-day).
  for (const a of D.appts || []) {
    if (a.status === "Needs scheduling" || a.date !== today || !a.time) continue;
    const m = mins(a.time);
    if (m - nowM <= 60 && m - nowM > -15) await once(userId, `appt:${a.id}:${a.date}`, { title: a.title, body: `Today at ${a.time}${a.where ? " · " + a.where : ""}`, url: "./#home" });
  }

  // Morning brief.
  const bt = mins(S.briefTime || "07:00");
  if (nowM >= bt && nowM < bt + 60) {
    const lines: string[] = [];
    const w = await weatherLine(S.city === "Current location" ? (S.wxKey || "Santa Barbara") : (S.city || "Santa Barbara, CA"));
    if (w) lines.push(`☀︎ ${w}`.replace("☀︎ ", ""));
    const appts = (D.appts || []).filter((a: any) => a.status !== "Needs scheduling" && a.date === today);
    if (appts.length) lines.push("Today: " + appts.map((a: any) => `${a.title}${a.time ? " " + a.time : ""}`).join(", "));
    const due = (D.todos || []).filter((t: any) => !t.done && t.due && t.due <= today);
    if (due.length) lines.push(`${due.length} to-do${due.length > 1 ? "s" : ""} due: ${due.slice(0, 3).map((t: any) => t.title).join(", ")}`);
    const wd = new Date(today + "T12:00:00Z").getUTCDay();
    const reg = (D.regimen || {})[wd];
    if (reg?.name && wd >= 1 && wd <= 5) lines.push(`Workout: ${reg.name}`);
    for (const p of D.people || []) {
      if (p.nobday) continue;
      const n = daysBetween(today, nextYearly(today, p.month, +p.day));
      if (n === 0) lines.push(`🎂 It's ${p.name}'s birthday — text them${p.phone ? " (" + p.phone + ")" : ""}`);
      if (n === 7) lines.push(`${p.name}'s birthday is next ${wdName(nextYearly(today, p.month, +p.day))}${(p.gifts || []).filter((g: any) => !g.bought).length ? " · gift ideas saved" : ""}`);
    }
    for (const x of D.dates || []) {
      const n = daysBetween(today, nextYearly(today, x.month, +x.day));
      if (n === 0) lines.push(`Today: ${x.title}`); else if (n === 7) lines.push(`${x.title} is in a week`);
    }
    for (const a of D.appts || []) {
      if (a.status !== "Needs scheduling" || !a.by) continue;
      const n = daysBetween(today, a.by);
      if (n === 14 || n === 3 || n === 0) lines.push(`${a.title} due ${fmt(a.by)} — want to book it?`);
    }
    if (lines.length) await once(userId, `brief:${today}`, { title: "Good morning", body: lines.join("\n").slice(0, 900), url: "./#home", tag: "brief" });
  }

  // Sunday evening workout plan check.
  const wdNow = new Date(today + "T12:00:00Z").getUTCDay();
  if (wdNow === 0 && nowM >= mins("18:45") && nowM < mins("19:45")) {
    const R = D.regimen || {};
    const plan = [1, 2, 3, 4, 5].map((d) => `${["", "Mon", "Tue", "Wed", "Thu", "Fri"][d]}: ${R[d]?.name || "—"}`).join(" · ");
    await once(userId, `sunday:${today}`, { title: "Plan this week's workouts", body: plan, url: "./#health" });
  }
  return out.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const body = await req.json().catch(() => ({}));
  const c = await cfg();
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com", c.vapid_public, c.vapid_private);
  if (body.vapid) return json({ key: c.vapid_public });

  // Scheduled run (from pg_cron) — protected by a shared secret.
  if (req.headers.get("x-cron-secret")) {
    if (!c.cron_secret || req.headers.get("x-cron-secret") !== c.cron_secret) return json({ error: "nope" }, 401);
    const { data: subs } = await admin().from("push_subs").select("user_id,tz");
    const users = new Map<string, string>();
    for (const s of subs || []) users.set(s.user_id, s.tz || "America/Los_Angeles");
    let n = 0;
    for (const [u, tz] of users) n += await runFor(u, tz).catch(() => 0);
    return json({ ok: true, users: users.size, n });
  }

  // App requests (signed in).
  const user = await userFrom(req);
  if (!user) return json({ error: "Sign in first", code: "not_granted" }, 401);
  if (body.test) {
    const n = await sendTo(user.id, { title: "It works", body: "Notifications are on for this device.", url: "./#home" });
    return n ? json({ ok: true, sent: n }) : json({ error: "No device is set up for notifications yet", code: "tool_error" }, 400);
  }
  if (body.status) {
    const { data } = await admin().from("integrations").select("provider").eq("user_id", user.id);
    const s: Record<string, boolean> = {};
    for (const r of data || []) s[r.provider] = true;
    return json(s);
  }
  return json({ error: "Unknown request", code: "bad_request" }, 400);
});
