-- OpenAI MCP Events integration: subscriptions, callback verification cache, retained events and
-- per-subscription delivery state.
--
-- Signing secrets are stored because delivery must sign with them; they are never returned by any
-- endpoint, never logged and never included in audit detail. Event rows are retained so a subscription
-- cursor can replay work that was queued while ChatGPT was disconnected.

CREATE TABLE IF NOT EXISTS habitat_ax_mcp_subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  principal TEXT NOT NULL,
  name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  args_canonical TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  previous_secret TEXT,
  secret_grace_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  refresh_before TEXT,
  revoked_at TEXT,
  last_cursor INTEGER,
  verified_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_subscriptions_identity
  ON habitat_ax_mcp_subscriptions(principal, name, args_canonical, url);

CREATE TABLE IF NOT EXISTS habitat_ax_mcp_verifications (
  principal TEXT NOT NULL,
  url TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (principal, url)
);

CREATE TABLE IF NOT EXISTS habitat_ax_mcp_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_events_event_id
  ON habitat_ax_mcp_events(event_id);

CREATE INDEX IF NOT EXISTS habitat_ax_mcp_events_name_seq
  ON habitat_ax_mcp_events(name, seq);

CREATE TABLE IF NOT EXISTS habitat_ax_mcp_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_mcp_deliveries_identity
  ON habitat_ax_mcp_deliveries(subscription_id, event_id);

CREATE INDEX IF NOT EXISTS habitat_ax_mcp_deliveries_due
  ON habitat_ax_mcp_deliveries(status, next_attempt_at);
