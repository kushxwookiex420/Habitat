# Habitat free-first resources and continuity options

Reviewed: 2026-10-09. Verify official pricing pages before relying on any quota; free offers can change.

## Best durable no-subscription foundation

### 1. GitHub repository checkpoints (already available)
- Source of truth: https://github.com/kushxwookiex420/Habitat
- Project handoff: `AX_CONTINUITY.md`
- Git history is durable while the repository remains available and is not tied to a model conversation's context window.
- Keep it free of secrets, access tokens, private customer details, and sensitive store data.
- This is the first-line way for a fresh Ax conversation to recover the goal, last verified results, known failures, and next action.

### 2. Open-source local memory (software does not require a paid subscription)
These are candidates, not installed integrations. Test on a separate branch before adopting:
- Engram: https://github.com/HBarefoot/engram — MIT-licensed, local SQLite memory, local embeddings, MCP integration. Fits a Node-oriented toolchain, but it still needs a persistent host filesystem and an agent host that can call MCP.
- Alice Memory: https://github.com/samrusani/AliceMemory — MIT-licensed local-first SQLite memory with explicit decisions, open loops, and resumption briefs. It runs locally and does not provide a hosted service; integrating it into Render requires deliberate architecture.
- Cross-Session Memory / AgentBook: https://github.com/NovasPlace/CSM — designed around checkpoints, events, and session re-entry; supports SQLite core mode and PostgreSQL for more features. Evaluate runtime/dependency size and licensing before integration.

**Important:** A local SQLite file on a laptop or phone is not automatically available to Habitat's Render backend. Render's ordinary ephemeral filesystem is not durable across deploys/restarts. Never claim persistence until a restart/redeploy test proves it.

## Hosted free allocations (useful, but not guaranteed forever)

### Cloudflare Workers AI
Official pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- The official page currently lists 10,000 Neurons per day on the Workers Free plan; limits reset daily at 00:00 UTC and excess usage requires a paid plan.
- Habitat previously logged a successful Cloudflare inference using `@cf/meta/llama-3.2-1b-instruct`.
- Keep daily quota and model access errors visible. Do not assume the allocation is unlimited or a lifetime promise.

### Cloudflare storage products
Official overview: https://developers.cloudflare.com/workers/platform/storage-options/
- Cloudflare lists D1 for relational application data, R2 for objects, KV for cache-like key/value data, and Durable Objects for coordinated state.
- Current free limits and the exact account entitlement must be checked before use. Paid Workers features can start at a monthly charge; do not enable paid plans or resources without explicit approval.
- A proper durable job system needs transactional job state, leases/locking, idempotency, recovery, and secure token storage—not just a place to write logs.

### GitHub Actions
Official billing guide: https://github.com/github/docs/blob/main/content/billing/concepts/product-billing/github-actions.md
- Standard GitHub-hosted runners for public repositories are currently free under GitHub's published policy.
- Keep builds bounded, avoid triggering full video renders on ordinary commits, and avoid relying on short-lived workflow artifacts as the only copy of important state.

## Recommended implementation order

1. Use `AX_CONTINUITY.md` and the `/continuity` endpoint as the durable session handoff.
2. Verify the existing free provider on real inference and handle quota exhaustion safely.
3. Inventory existing storage accounts before provisioning anything new.
4. Implement persistent job state only after confirming a truly free, available storage path and its limits.
5. Keep a restart/redeploy recovery test in CI. A successful health endpoint alone is not proof of durable storage.
6. Keep OAuth credentials server-side and encrypted at rest; never commit tokens into the repository checkpoint.

## No misleading “free forever” claims
Open-source licenses can allow continued self-hosting without a subscription, but hosting, APIs, quotas, accounts, and free tiers can change. Habitat should favor portable data formats and self-hostable components, and must disclose when a capability depends on a third-party free allocation.
