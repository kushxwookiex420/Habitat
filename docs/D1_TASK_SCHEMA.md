# D1 Task Storage Schema

The runtime task repository needs durable storage before tasks can survive Render restarts. The initial schema should use a stable task ID, serialized task record, indexed status, and updated timestamp. Use a Cloudflare D1 database with least-privilege credentials held only in Render environment settings. Do not mark storage healthy until a real restart-and-hydration test passes.
