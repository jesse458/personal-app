// Weather: free Open-Meteo forecast + air quality + US National Weather Service alerts.
// Returns the same shapes the app's weather panel already reads (current / hourly / 10-day / alerts).
import { cors, json, userFrom } from "../_shared/util.ts";

const WMO: Record<number, [string, number]> = { // code -> [phrase, icon]
  0: ["Sunny", 1], 1: ["Mostly sunny", 2], 2: ["Partly cloudy", 3], 3: ["Cloudy", 7], 45: ["Fog", 11], 48: ["Fog", 11],
  51: ["Light drizzle", 12], 53: ["Drizzle", 12], 55: ["Drizzle", 12], 56: ["Freezing drizzle", 26], 57: ["Freezing drizzle", 26],
  61: ["Light rain", 18], 63: ["Rain", 18], 65: ["Heavy rain", 18], 66: ["Freezing rain", 26], 67: ["Freezing rain", 26],
  71: ["Light snow", 22], 73: ["Snow", 22], 75: ["Heavy snow", 22], 77: ["Snow grains", 22],
  80: ["Showers", 12], 81: ["Showers", 12], 82: ["Heavy showers", 12], 85: ["Snow showers", 22], 86: ["Snow showers", 22],
  95: ["Thunderstorms", 15], 96: ["Thunderstorms", 15], 99: ["Thunderstorms", 15],
};
const NIGHT: Record<number, number> = { 1: 33, 2: 34, 3: 35, 12: 39, 18: 40, 15: 41, 22: 44 };
const look = (code: number, day = true) => { const [p, i] = WMO[code] ?? ["—", 7]; return { phrase: day ? p : p.replace("Sunny", "Clear").replace("Mostly sunny", "Mostly clear"), icon: day ? i : (NIGHT[i] ?? i) }; };
const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compass = (deg: number) => dirs[Math.round(((deg % 360) / 22.5)) % 16];
const uvCat = (u: number) => (u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme");
const aqiCat = (a: number) => (a <= 50 ? "Good" : a <= 100 ? "Fair" : a <= 150 ? "Unhealthy for some" : a <= 200 ? "Unhealthy" : "Very unhealthy");
const hourLabel = (iso: string) => { const h = +iso.slice(11, 13); return `${(h + 11) % 12 + 1} ${h < 12 ? "AM" : "PM"}`; };
const dayLabel = (d: string) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

async function search(query: string) {
  const [name, region] = query.split(",").map((s) => s.trim());
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=10&language=en&format=json&name=${encodeURIComponent(name)}`).then((x) => x.json());
  let res = r.results || [];
  if (region) {
    const reg = region.toLowerCase();
    const pick = res.filter((x: any) => (x.admin1 || "").toLowerCase().startsWith(reg) || (x.admin1_code || "").toLowerCase() === reg || (x.country_code || "").toLowerCase() === reg || STATES[reg.toUpperCase()] === x.admin1);
    if (pick.length) res = pick;
  }
  return { results: res.slice(0, 5).map((x: any) => ({ locationKey: `${x.latitude.toFixed(3)},${x.longitude.toFixed(3)}`, name: [x.name, x.admin1].filter(Boolean).join(", ") })) };
}

async function forecast(key: string) {
  const [lat, lon] = key.split(",").map(Number);
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=10&temperature_unit=fahrenheit&wind_speed_unit=mph` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,is_day,uv_index` +
    `&hourly=temperature_2m,precipitation_probability,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`;
  const [f, aq, al, place] = await Promise.all([
    fetch(url).then((x) => x.json()),
    fetch(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=us_aqi`).then((x) => x.json()).catch(() => null),
    fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`, { headers: { "User-Agent": "PersonalApp (personal use)", Accept: "application/geo+json" } }).then((x) => x.ok ? x.json() : null).catch(() => null),
    fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`).then((x) => x.json()).catch(() => null),
  ]);
  const tz = f.timezone || "UTC";
  const alerts = ((al && al.features) || []).map((a: any) => {
    const end = a.properties.ends || a.properties.expires;
    const d = end ? new Date(end) : null;
    return { name: a.properties.event, endDate: d ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: tz }) : "", endTime: d ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "" };
  });
  const c = f.current, l = look(c.weather_code, !!c.is_day);
  const location = { localizedName: (place && (place.city || place.locality)) || "Your location" };
  const cur = {
    currentConditions: {
      temperatureValue: Math.round(c.temperature_2m), phrase: l.phrase, iconCode: l.icon, realFeel: `${Math.round(c.apparent_temperature)}°`,
      extended: { wind: `${compass(c.wind_direction_10m)} ${Math.round(c.wind_speed_10m)} mph`, humidity: `${c.relative_humidity_2m}%`, uv: { category: uvCat(c.uv_index || 0) } },
    },
    currentAirQuality: aq && aq.current ? { category: aqiCat(aq.current.us_aqi) } : null,
    location, alerts,
  };
  const nowIdx = Math.max(0, f.hourly.time.findIndex((t: string) => t >= c.time.slice(0, 13)));
  const hr = {
    hourlyForecast: f.hourly.time.slice(nowIdx, nowIdx + 12).map((t: string, i: number) => {
      const k = nowIdx + i, lk = look(f.hourly.weather_code[k], !!f.hourly.is_day[k]);
      return { dateTime: hourLabel(t), icon: lk.icon, temperatureValue: Math.round(f.hourly.temperature_2m[k]), precip: `${f.hourly.precipitation_probability[k] ?? 0}%`, phrase: lk.phrase };
    }), location, alerts,
  };
  const day = {
    dailyForecast: f.daily.time.map((d: string, i: number) => {
      const lk = look(f.daily.weather_code[i]);
      return { longDisplayDate: dayLabel(d), day: { temperature: Math.round(f.daily.temperature_2m_max[i]), icon: lk.icon, phrase: lk.phrase, precip: `${f.daily.precipitation_probability_max[i] ?? 0}%` }, night: { temperature: Math.round(f.daily.temperature_2m_min[i]) } };
    }), location, alerts,
  };
  return { cur, hr, day };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!(await userFrom(req))) return json({ error: "Sign in first", code: "not_granted" }, 401);
  try {
    const { tool, input } = await req.json();
    const q = (input && input.queryParams) || {};
    if (tool === "widgets-search-claude") return json(await search(String(q.query || "")));
    const all = await forecast(String(q.locationKey));
    if (tool === "widgets-current-claude") return json(all.cur);
    if (tool === "widgets-hourly-claude") return json(all.hr);
    if (tool === "widgets-daily-claude") return json(all.day);
    return json({ error: "Unknown weather request", code: "bad_request" }, 400);
  } catch (e) {
    return json({ error: "Weather unavailable right now", code: "server_unavailable" }, 502);
  }
});

const STATES: Record<string, string> = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming" };
