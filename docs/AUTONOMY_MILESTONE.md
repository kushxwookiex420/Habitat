# Next autonomy milestone — prepared, not activated

Status: **prepared only**. Activation is gated on the real ChatGPT ↔ Habitat acceptance in
`docs/STAGING_EVIDENCE.md` plus explicit owner approval. Nothing in this milestone is enabled by this
change; all flags remain off by default.

## Entry gate

Do not start until all are true:

1. The staging commit is deployed and `/health` reports it.
2. `/system/status` shows gateway, heartbeat and MCP enabled and encryption configured.
3. A real ChatGPT client has completed initialize, discovery, subscription, a signed delivery and a
   mission round-trip.
4. The D1 restore point and encryption keys are backed up.
5. The owner has named who may approve high-impact work.

## Scope by capability

| Capability | Prepared mechanism | Guardrail |
| --- | --- | --- |
| Persistent mission execution | `habitat_ax_missions`, mission runtime, recovery leases | bounded attempts, explicit stop, resumable checkpoints |
| Independent browser | sandboxed engineering runner | isolated checkout, no host secrets, allowlisted egress |
| Specialized AI workforce | worker adapters and registry | capability-scoped dispatch, audited results |
| Provider-independent model routing | provider abstraction | no hidden paid provider; cost ledger per task |
| Memory and continuity | memory revisions with export/import | signed export, owner-scoped retention |
| Authorized phone operations | device bridge with owner attestation | per-device tokens, approval for destructive actions |
| Monitoring and proactive reporting | heartbeat + incidents | rate-limited notifications; no unattended spend |
| Controlled self-improvement | improvement engine findings | proposals only; owner applies changes |
| Revenue workflows | treasury/revenue tables exist | **not activated**; any spend, payout or publishing requires owner approval |

## Hard boundaries

- No agent approves its own high-impact action; approvals require the owner verifier.
- No production deployment, migration or runtime flag is changed by an autonomous agent.
- No purchases, plan upgrades, financial transactions or publishing without explicit approval.
- Every high-impact action produces an audit record with a request id and verified outcome.
- Secrets never enter prompts, logs, memory exports, commits or chat.

## Activation order

1. Prove staging communication and restart persistence.
2. Enable persistent missions for a harmless workload; verify recovery and audit.
3. Add the independent browser in its sandbox; prove escape and egress tests still fail closed.
4. Add monitoring/reporting; keep notifications owner-visible.
5. Only after those pass, review any revenue workflow proposal. Preparation is not permission.

Owner approval is required at every numbered step. This document is a plan, not an authorization.
