-- Ax connection monitor: Habitat's own heartbeat, a durable event queue and delivery history.
--
-- Additive and idempotent. The heartbeat is independent of any integration: it keeps beating when
-- ChatGPT is absent. Events carry a dedupe key so repeated beats cannot spam a conversation, and
-- delivery attempts are recorded so "sent", "delivered" and "acknowledged" stay distinguishable.

CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_state (
  integration TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  last_beat_at TEXT,
  last_seen_at TEXT,
  last_delivery_at TEXT,
  last_ack_at TEXT,
  missed_beats INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_events (
  id TEXT PRIMARY KEY NOT NULL,
  integration TEXT NOT NULL,
  kind TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  priority INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  acknowledged_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_heartbeat_events_dedupe
  ON habitat_ax_heartbeat_events(dedupe_key);

CREATE INDEX IF NOT EXISTS habitat_ax_heartbeat_events_pending
  ON habitat_ax_heartbeat_events(status, priority, created_at);

CREATE TABLE IF NOT EXISTS habitat_ax_heartbeat_deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  at TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
