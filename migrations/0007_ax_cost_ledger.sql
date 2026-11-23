-- Mission 21: durable model-call cost accounting.
--
-- One row per UTC day. `state_json` holds the daily totals and the per-task reservations; writes are
-- compare-and-swap on that exact string, so two service instances cannot both spend the last of the
-- day's budget. Additive only: no existing table is changed.
CREATE TABLE IF NOT EXISTS habitat_ax_cost_ledger (
  day TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_cost_ledger_updated_at
  ON habitat_ax_cost_ledger(updated_at DESC);
