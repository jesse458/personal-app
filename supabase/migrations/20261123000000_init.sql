-- Personal App: core schema
-- Every row belongs to one signed-in user; row level security keeps each user to their own rows.

create table if not exists public.app_docs (
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,                      -- e.g. 'app/todos'
  data jsonb not null,                     -- { items: ..., at: ... }
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

create table if not exists public.push_subs (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  ua text,
  tz text,
  created_at timestamptz not null default now()
);

-- OAuth tokens for Google Calendar / Strava. Only server functions (service role) read these.
create table if not exists public.integrations (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,                  -- 'gcal' | 'strava'
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- Short-lived OAuth "state" values to tie a callback to the user who started it.
create table if not exists public.oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  back text,
  created_at timestamptz not null default now()
);

-- Which notifications were already sent (so nothing repeats).
create table if not exists public.notif_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  sent_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.app_docs enable row level security;
alter table public.push_subs enable row level security;
alter table public.integrations enable row level security;
alter table public.oauth_states enable row level security;
alter table public.notif_log enable row level security;

create policy "own docs" on public.app_docs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own push subs" on public.push_subs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- integrations / oauth_states / notif_log: no client policies => only the service role can touch them.

-- Live updates for the app (weather written by the server, edits from another device).
alter publication supabase_realtime add table public.app_docs;
