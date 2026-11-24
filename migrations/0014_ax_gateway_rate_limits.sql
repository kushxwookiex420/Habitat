-- Shared gateway rate limiting.
--
-- The in-memory limiter is per process. This table makes the fixed window durable and shared, so two
-- gateway instances behind a load balancer enforce one combined budget per client. Still a fixed
-- window, not a sliding one; the limit remains a safety valve, not a billing meter.

CREATE TABLE IF NOT EXISTS habitat_ax_gateway_rate_limits (
  client_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (client_id, window_start)
);
