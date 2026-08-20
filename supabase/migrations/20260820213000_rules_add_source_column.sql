-- tools/impl/feedback-capture.js has inserted `source` on every write to
-- `rules` since it was built 2026-08-10, but the column never existed --
-- every insert has been silently 400ing since that day. Net effect: the
-- live Teams-bot-driven agent has received zero new standing rules since
-- 2026-05-09 (all of Michael's Teams/email corrections since then only
-- landed in the local Claude Code memory file, never in the production
-- system prompt). Additive fix: add the missing column rather than drop
-- the intended source-tracking feature from the code.
alter table public.rules add column if not exists source text;
