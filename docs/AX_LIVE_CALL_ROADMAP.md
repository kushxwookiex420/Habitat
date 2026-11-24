# AX Live Call and the holographic command centre

This is a roadmap, not a capability claim. Nothing in this document runs today.

## The experience the owner described

A persistent humanoid Ax in a dynamic command centre who can pull up displays, brief the operator,
converse naturally, and operate Habitat through its authenticated runtime.

Read as four separable requirements, because they have very different bottlenecks:

1. **Persistent presence** — Ax is there when the operator opens the surface, not re-created per
   request. Needs a long-lived session object with conversation state, not a stateless request.
2. **Voice conversation** — natural speech in and out, with interruption (barge-in).
3. **Command centre** — displays Ax can summon: status, workers, tasks, revenue, incidents. These
   are *renders of real data*, so each must read an existing authenticated endpoint (`/system/status`,
   `/workers`, `/ax/command/*`) rather than invent a view model.
4. **Operating Habitat** — the same authenticated command path that exists today (`ax:` intents →
   durable task → worker claim → verified result). The avatar must never get a private, unaudited
   path to act.

## Why the runtime already constrains the design

- Every action goes through the command authorisation gate and the approval gate. A voice command is
  still a command: it must carry the owner or paired-device credential, and anything needing approval
  must land in the approval queue, not execute.
- Spend is capped by the cost ledger, so a live call cannot become an unbounded token stream. A
  real-time session needs a per-session ceiling before it is shown to anyone.
- Notifications are an inbox record, not a push promise. "Ax calls you" is not implementable with the
  current channel and must not be demoed as if it were.

## Phased plan

**Phase 1 — presence without a model (no new service).**
A command-centre page that renders the real status payloads, with a persistent session id held in D1.
Ax's "briefing" is generated from `/system/status` + the improvement engine's top findings, so its
words are derived from verified fields. No speech, no avatar. This is achievable with the current
runtime and is the honest first increment.

**Phase 2 — conversation.**
Text conversation over the live-call session, using the existing provider planner with a per-session
spend ceiling from the cost governor. Every tool call the model requests resolves to an existing
authenticated command; the model never gets a credential of its own.

**Phase 3 — voice.**
Speech-to-text and text-to-speech are third-party services with per-minute cost and latency, and they
must run in the browser or on a media server, neither of which exists here. This phase needs an
explicit service choice and budget approval before any code is written.

**Phase 4 — the humanoid.**
A 3D avatar with lip-sync and idle motion is a rendering project (WebGL/Three.js or a media server).
It must not gate the earlier phases: a talking avatar in front of a command path that cannot execute
would be the most expensive possible way to misrepresent the system.

## Anti-goals

- No simulated "Ax is thinking" that hides a failure.
- No avatar claiming a capability the status endpoint does not report.
- No ambient microphone capture without an explicit owner action per session.
- No autonomous outward communication (calls, messages) — those stay behind approval permanently.
