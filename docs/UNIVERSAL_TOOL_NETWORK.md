# Universal Tool Network — architecture requirement

Status: **requirement and design only. Nothing in this document is implemented, connected, purchased
or deployed.** It records what the next approved phase must build, and the invariants it must keep.

## 1. Requirement

Habitat/Ax must be able to use the legitimate digital tools a business actually needs: the public
web, approved browser automation, APIs, connected plugins, development environments, AI models,
commerce integrations, analytics platforms, and whatever replaces them next year.

The network exists so that adding a capability is a **registry operation, not a rebuild**. A provider
is discovered, researched, evaluated, trialled and registered; business logic refers to a capability
id, never to a vendor. Replacing a vendor is a registry change plus a re-trial, not a rewrite.

The long-term objective is continuous, self-directed adoption: Habitat keeps discovering useful tools
so it can research, build and operate legitimate digital businesses across as many profitable
industries as practical.

## 2. Non-negotiable invariants

These are refusal rules, not preferences. Each maps to an enforcement point in §5.

1. **Free and open-source first.** A paid provider is never selected while an eligible free one meets
   the requirement.
2. **No access-control bypass.** No CAPTCHA, MFA, rate-limit, paywall, robots or ToS circumvention;
   no credential sharing; no scraper that defeats a block.
3. **No private-data harvesting.** Only data the owner is entitled to, from sources that permit it.
4. **No charge without owner approval.** Every subscription, credit purchase, overage and per-call
   cost is approval-gated, bound to an exact amount and quote.
5. **No silent activation.** Discovering or researching a provider never enables it. Activation is a
   separate, owner-approved transition.
6. **No unreviewed side effect.** A tool that writes, publishes, sends, pays or deletes is trialled in
   a sandbox and activated explicitly.
7. **Everything is attributable.** Who discovered, who researched, who trialled, who approved.
8. **Everything is reversible.** A provider can be disabled and its data exported without touching
   another provider's records.

## 3. Lifecycle

```
discover → research → register → trial → select → activate → monitor → retire
   ↑                                                          |
   └──────────────── continuous re-evaluation ─────────────────┘
```

| Stage | Input | Output | Gate |
| --- | --- | --- | --- |
| **Discover** | Industry, task, observed gap | Candidate providers with a source URL | Owner allowlist or an approved research objective |
| **Research** | Candidate | Evidence record: official docs URL, API surface, auth model, terms, pricing, free-tier limits, rate limits, data handling, known limitations | Source must be the provider's own documentation, quoted, with a retrieval date |
| **Register** | Evidence | Capability + provider + adapter descriptor, state `unconfigured` | Registration is inert: no credential, no call |
| **Trial** | Registered provider | Test report from a sandbox with mocked or free-tier calls | Sandbox only; no production data; no spend |
| **Select** | Eligible providers | Ranked, explainable choice | Hard eligibility filter first, then scoring |
| **Activate** | Chosen provider | State `available`, credential bound server-side | **Owner approval**, per provider and per scope |
| **Monitor** | Live usage | Reliability, latency, error rate, cost, business outcome | Automatic; degradation produces findings |
| **Retire** | Provider | State `disabled`, data exported, dependent capabilities repointed | Owner approval if a live business depends on it |

## 4. What the registry records

Per **capability** (what the business needs): a stable id, kind, purpose, required permissions, side
-effect class, whether approval is mandatory, and the abstract adapter contract.

Per **provider** (who supplies it): slug, vendor, official docs URL, API base, auth model, terms
version and retrieval date, pricing model, free-tier limits, rate limits, data-retention statement,
jurisdiction, support channel, deprecation risk.

Per **evidence item**: source URL, quoted excerpt, retrieved-at timestamp, and the claim it supports.
A price or limit with no evidence is stored as `unverified`, never as a number.

Per **trial**: environment, dataset used, calls made, cost incurred (normally zero), pass/fail per
assertion, and the artefact path.

Per **metric**: task count, success count, error classes, p50/p95 latency, cost per successful task,
and the business result (revenue, time saved, defect rate) measured against a named baseline.

## 5. Enforcement points

| Invariant | Enforced by |
| --- | --- |
| Free-first | Selection policy ranks by cost after eligibility; a paid provider needs an explicit owner override recorded on the decision |
| No bypass | Trial harness refuses a provider flagged `bypass_required`; the flag is set during research, not by the caller |
| No private data | Trial datasets are synthetic or owner-supplied; production data is never used in a trial |
| No charge | The existing approval gate; a paid capability is `policy_only` until approved |
| No silent activation | Registry state machine: `registered → trialled → approved → available`; a transition to `available` requires an owner actor |
| No unreviewed side effect | Side-effect class drives gating; gated classes are never `available` without approval |
| Attribution | Existing security-event chain, one event per transition |
| Reversibility | Provider rows are keyed by slug; disabling one cannot mutate another |

## 6. Reuse, not new infrastructure

| Need | Existing component |
| --- | --- |
| Task lifecycle | `universal-command-engine.mjs` (`submit → plan → checkpoint → approve → complete`) |
| Periodic discovery and health | `ax-scheduler.mjs` (lease, findings, dead-letter) |
| Audit | `ax-security-events.mjs` hash chain |
| Spend control | `ax-cost-governor.mjs` + `habitat_ax_cost_ledger` |
| Secrets | `d1-secret-vault.mjs`; credentials never enter a capability record |
| Human decision | `ax-approval-gate.mjs` (owner device, single use, exact binding) |
| Capability catalog | `ax-capability-registry.mjs` (P1 seed) |
| Durable storage | `ax-network-repository.mjs` pattern over `createD1Query` |

No second task engine, no second scheduler, no second approval table, no second credential store.

## 7. Selection policy

Selection is deterministic and explainable:

1. **Eligibility filter (hard).** Remove anything unverified, unapproved, blocked by terms, over the
   free-tier limit, missing a required permission, or classified as bypass/private-data risk.
2. **Score the remainder.** Reliability (success rate), cost (free beats paid), latency, fit to the
   task class, and integration depth.
3. **Explain.** The decision record names every provider considered, every one excluded and why, and
   the measurements behind the winner. With no measurements, the record says `unmeasured` and the
   choice is a default, not a claim.
4. **Fail closed.** Empty eligible set means the task stops with a named blocker; it never falls back
   to an unvetted provider.

Selection never activates anything. It proposes; the owner approves.

## 8. Provider-agnostic adapter contract

An adapter declares what it can do, not who provides it:

```
capabilityId      e.g. "web.search", "commerce.list_products", "analytics.read"
providerSlug      e.g. "searxng", "shopify", "plausible"
authModel         none | api_key | oauth2 | device_token
sideEffects       none | read | write | external_publish | payment
limits            freeTier, rateLimit, maxPayload
inputSchema       JSON Schema, provider-neutral
outputSchema      JSON Schema, normalised
failureClasses    retryable | auth | quota | permanent
```

Business logic depends on `capabilityId` and the normalised schema only. Swapping `providerSlug` must
not change a caller. A provider that cannot produce the normalised shape is not eligible, however
good its marketing.

## 9. Discovery sources and hygiene

Permitted: provider documentation sites, official API references, status pages, changelogs, package
registries, open-source licence metadata, published pricing pages, and the owner's own requests.

Refused: scraping behind authentication, bypassing a paywall or robots directive, harvesting
personal data, reselling a provider's data against its terms, and using a trial to evade a paid plan.

Every discovery candidate is recorded with the page it came from and the date. A candidate with no
source is discarded, not queued.

## 10. What is explicitly not authorized here

- No discovery run, provider signup, OAuth connection or API key.
- No paid plan, credit purchase or trial that requires a card.
- No production activation, deploy or merge.
- No change to Bridge signing, installation or pairing.
- No `NEXUS_RUNTIME_ENABLED`.

## 11. Acceptance criteria for the next approved phase

The phase is complete when, with owner approval at each gate:

1. A capability and provider schema extends `habitat_ax_capabilities` without altering existing rows,
   and a rollback restores the previous schema with pre-existing data intact.
2. Research produces evidence records where every price, limit and permission carries a source URL
   and retrieval date, or is stored as `unverified`.
3. A sandbox trial runs at least one real provider with zero production data and zero spend, and its
   report names every assertion and its result.
4. Selection produces an explainable decision record, including for the empty-eligible-set case.
5. Activation requires an owner device decision and is refused for the command token — proven by test.
6. Disabling a provider leaves every other provider's data and every dependent capability readable.
7. Metrics are derived from recorded events, and no metric is reported without a stated window.
8. The registry reports `unverified` rather than a guessed number wherever evidence is missing.

Until those hold, Habitat may *describe* a tool but must not *use* it.
