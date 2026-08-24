-- Maps a Teams sender's AAD object id to a known employee. Lazily populated
-- the first time someone other than Michael messages the bot (see
-- teams/identity.js's resolveSender) -- empty today since only Michael uses
-- the bot, but needed the moment a second real person does.
create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  aad_object_id text not null unique,
  email text,
  name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
