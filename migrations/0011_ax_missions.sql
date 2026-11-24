-- Durable missions: intake, plan, task state, approvals and an append-only event log.
--
-- Additive and idempotent only. Missions are a separate aggregate from objectives: an objective is a
-- NEXUS execution record with its own lifecycle, while a mission owns requirements, acceptance
-- criteria, approvals and dependency-aware tasks executed by the workforce. Keeping them apart means
-- neither lifecycle can corrupt the other.
--
-- `version` is the compare-and-swap token: two schedulers cannot both persist a transition.

CREATE TABLE IF NOT EXISTS habitat_ax_missions (
  id TEXT PRIMARY KEY NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_missions_status
  ON habitat_ax_missions(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS habitat_ax_mission_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_mission_events_mission
  ON habitat_ax_mission_events(mission_id, seq);
