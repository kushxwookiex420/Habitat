-- P1 additive schema: fulfillment catalog, channel eligibility rules and treasury reporting.
--
-- Every statement is CREATE ... IF NOT EXISTS. Nothing existing is dropped, renamed or altered.
--
-- Order, shipment, return and financial-link tables are deliberately absent. P1 is read-only against
-- every external provider, so those tables would have no writer; they arrive with the P2 execution
-- work that can actually create an order. Declaring empty tables now would suggest a capability this
-- deployment does not have.

CREATE TABLE IF NOT EXISTS habitat_ax_suppliers (
  id TEXT PRIMARY KEY NOT NULL,
  layer TEXT NOT NULL,
  order_model TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_suppliers_layer
  ON habitat_ax_suppliers(layer, status);
CREATE INDEX IF NOT EXISTS habitat_ax_suppliers_order_model
  ON habitat_ax_suppliers(order_model);

CREATE TABLE IF NOT EXISTS habitat_ax_supplier_offers (
  id TEXT PRIMARY KEY NOT NULL,
  supplier_id TEXT NOT NULL,
  sku TEXT,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_supplier_offers_supplier
  ON habitat_ax_supplier_offers(supplier_id, status);

CREATE TABLE IF NOT EXISTS habitat_ax_channel_rules (
  id TEXT PRIMARY KEY NOT NULL,
  channel TEXT NOT NULL,
  decision TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_channel_rules_channel
  ON habitat_ax_channel_rules(channel, decision);

CREATE TABLE IF NOT EXISTS habitat_ax_revenue_events (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_revenue_events_state
  ON habitat_ax_revenue_events(state, occurred_at DESC);
CREATE INDEX IF NOT EXISTS habitat_ax_revenue_events_currency
  ON habitat_ax_revenue_events(currency, occurred_at DESC);

CREATE TABLE IF NOT EXISTS habitat_ax_payouts (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_payouts_state
  ON habitat_ax_payouts(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS habitat_ax_treasury_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  record_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS habitat_ax_treasury_accounts_kind
  ON habitat_ax_treasury_accounts(kind, status);
