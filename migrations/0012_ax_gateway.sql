-- Authenticated integration gateway for ChatGPT/Ax → Habitat.
--
-- Additive and idempotent. Stores integration identities (token hashes only), single-use nonces and an
-- append-only request audit. No plaintext token is ever stored, so a database read cannot impersonate
-- a client.

CREATE TABLE IF NOT EXISTS habitat_ax_gateway_clients (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS habitat_ax_gateway_clients_token
  ON habitat_ax_gateway_clients(token_hash);

CREATE TABLE IF NOT EXISTS habitat_ax_gateway_nonces (
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, nonce)
);

CREATE TABLE IF NOT EXISTS habitat_ax_gateway_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL
);
