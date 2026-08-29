-- Caches SA per-client phone fields (HomePhone/CellPhone/WorkPhone/OtherPhone/
-- PreferredPhoneID) fetched via GetClientInfo (ClientEditOverlayWs.asmx).
-- Confirmed exhaustively in PR #361 (tools/impl/serviceautopilot.js's own
-- comments): phone data exists ONLY on this per-client endpoint -- never on
-- any bulk/list SA endpoint -- so findDuplicateClient()'s phone-only dedup
-- path had to fall back to a bounded live scan of the 50 most-recently-created
-- accounts instead of checking the full ~10,300-account population. This
-- table lets a one-time backfill (tools/impl/sa-phone-cache.js) + a
-- going-forward incremental cron populate a queryable cache so phone-only
-- dedup can match against every client SA has, not just the newest 50.
--
-- client_id is the SA ClientID GUID (primary key -- one row per client,
-- upserted on every (re)fetch). fetched_at drives the backfill/incremental
-- cron's staleness check (see PHONE_CACHE_TTL_DAYS in sa-phone-cache.js).
create table if not exists public.sa_client_phone_cache (
  client_id           text primary key,
  client_name         text,
  home_phone          text,
  cell_phone          text,
  work_phone          text,
  other_phone         text,
  preferred_phone_id  text,
  fetched_at          timestamptz not null default now()
);

-- The phone-only dedup path normalizes an incoming phone to digits-only (see
-- findDuplicateClient's normalizePhoneDigits) and needs to find every cached
-- row matching any of the four phone columns -- an index on each column
-- keeps that a fast lookup instead of a full-table scan against ~10,300 rows.
-- Columns store SA's raw (unnormalized) phone strings; the query side
-- normalizes both sides at lookup time (see findPhoneMatchesInCache), so
-- these are plain btree indexes, not functional/expression indexes.
create index if not exists sa_client_phone_cache_home_phone_idx  on public.sa_client_phone_cache (home_phone);
create index if not exists sa_client_phone_cache_cell_phone_idx  on public.sa_client_phone_cache (cell_phone);
create index if not exists sa_client_phone_cache_work_phone_idx  on public.sa_client_phone_cache (work_phone);
create index if not exists sa_client_phone_cache_other_phone_idx on public.sa_client_phone_cache (other_phone);

-- RLS enabled with no explicit policies, matching every other table in this
-- project (rules, conversation_turns, calendar_delta_state, etc.) -- all
-- access goes through SUPABASE_SERVICE_KEY, which bypasses RLS entirely, so
-- this is a pure deny-all for anon/authenticated with no functional impact.
alter table public.sa_client_phone_cache enable row level security;
