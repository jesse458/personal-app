# Personal App

A personal life app (home calendar, to-dos, events & birthdays, habits, goals, health, shopping, notes with a locked section) with an AI assistant, voice commands and push notifications. Installable as a PWA.

## How it's put together
- `web/` — the app (static files, hosted on Netlify). `platform.js` connects the app to Supabase: sign-in, data, AI, weather, Google Calendar, Strava, voice and push.
- `supabase/migrations/` — database tables (row level security on everything).
- `supabase/functions/` — server functions:
  - `ai` — talks to Claude with your Anthropic key (secret `ANTHROPIC_API_KEY`).
  - `weather` — Open-Meteo forecast, air quality and US weather alerts (free, no key).
  - `gcal` — Google Calendar connect + read/add events (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
  - `strava` — Strava connect + activities (`STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`).
  - `notify` — push notifications every 15 minutes (reminders, appointments, morning brief, Sunday workout check). Push keys are generated and stored by the server.

## Install on iPhone
Open the site in Safari → Share → Add to Home Screen → open it from the icon → Settings → Turn on notifications.
