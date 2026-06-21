-- config/supabase_schema.sql
-- Run in Supabase SQL editor. Safe to re-run.

-- ── Token log ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_token_log (
  id            BIGSERIAL PRIMARY KEY,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  task          TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens  INTEGER NOT NULL,
  run_id        UUID
);
CREATE INDEX IF NOT EXISTS idx_token_log_created ON agent_token_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_log_task    ON agent_token_log(task);

-- ── Compressed memory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_memory (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  summary     TEXT NOT NULL,
  topics      TEXT[] DEFAULT '{}',
  run_id      UUID,
  raw_length  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_memory_created ON agent_memory(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_topics  ON agent_memory USING GIN(topics);

-- ── Result cache ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cache_expires ON agent_cache(expires_at);

-- ── Agent library ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_library (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  system_prompt TEXT NOT NULL,
  model         TEXT,
  task_type     TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  default_vars  JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_tags ON agent_library USING GIN(tags);

-- ── Skill library ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skill_library (
  name          TEXT PRIMARY KEY,
  description   TEXT,
  task          TEXT NOT NULL,
  task_type     TEXT NOT NULL,
  tags          TEXT[] DEFAULT '{}',
  default_vars  JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_skill_tags ON skill_library USING GIN(tags);

-- ── Agent task queue ──────────────────────────────────────────
-- New column (added 2026-06-13): stores the system_prompt_override so
-- task-poller can replay scheduling tasks with the correct prompt context.
-- ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS system_prompt_override TEXT;

-- ── Overnight report tracking (fleetops project) ─────────────
-- sa_accepted_estimates tracks when each Won estimate was first seen (added 2026-05-21)
-- sa_sent_estimates tracks when each Sent estimate was first seen (added 2026-06-20)
-- Both: upsert on estimate_id with ignoreDuplicates=true to preserve first_seen timestamps.
CREATE TABLE IF NOT EXISTS sa_sent_estimates (
  estimate_id        TEXT PRIMARY KEY,
  estimate_number    TEXT,
  client_name        TEXT,
  client_id          TEXT,
  address            TEXT,
  sales_rep          TEXT,
  service_type       TEXT,
  amount             NUMERIC,
  quote_date         DATE,
  first_seen_sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sa_sent_first_seen ON sa_sent_estimates(first_seen_sent_at DESC);

-- ── Views ─────────────────────────────────────────────────────
CREATE OR REPLACE VIEW agent_daily_token_spend AS
SELECT
  DATE(created_at)    AS day,
  model,
  SUM(input_tokens)   AS total_input,
  SUM(output_tokens)  AS total_output,
  SUM(total_tokens)   AS total_tokens,
  COUNT(*)            AS calls
FROM agent_token_log
GROUP BY DATE(created_at), model
ORDER BY day DESC, total_tokens DESC;

CREATE OR REPLACE VIEW agent_monthly_token_spend AS
SELECT
  TO_CHAR(created_at, 'YYYY-MM') AS month,
  model,
  SUM(total_tokens)              AS total_tokens,
  COUNT(*)                       AS calls,
  ROUND(SUM(input_tokens)  / 1000000.0 *
    CASE model
      WHEN 'claude-haiku-4-5-20251001' THEN 0.80
      WHEN 'claude-sonnet-4-6'         THEN 3.00
      ELSE 3.00
    END, 4)                      AS est_input_cost_usd,
  ROUND(SUM(output_tokens) / 1000000.0 *
    CASE model
      WHEN 'claude-haiku-4-5-20251001' THEN 4.00
      WHEN 'claude-sonnet-4-6'         THEN 15.00
      ELSE 15.00
    END, 4)                      AS est_output_cost_usd
FROM agent_token_log
GROUP BY TO_CHAR(created_at, 'YYYY-MM'), model
ORDER BY month DESC;
