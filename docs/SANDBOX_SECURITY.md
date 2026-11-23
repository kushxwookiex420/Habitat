# NEXUS sandbox security

The `repo.test` adapter runs untrusted code. It is allowed to run only inside a Linux
user/mount/pid/net namespace with a chroot checkout, dropped capabilities, `no_new_privs`, rlimits and
a host-side process-group supervisor. This document states exactly which guarantee is tested where, so
a green suite is never mistaken for proof of isolation.

Run `npm run sandbox:check` to get this machine's verdict as one JSON line
(`{ available, reason, missing, tools, limits, coverage }`). `npm run sandbox:check -- --require`
exits `2` when the host cannot run the sandbox.

## Tiers

**Tier 1 — every CI runner (portable).** No privilege, no namespaces. Proves the contract: detection
returns a typed fail-closed verdict, a missing primitive is named, the adapter refuses instead of
falling back to host execution, no process evidence is invented, limits are concrete, and every skip
in Tier 2 states its missing capability and the alternative path.
File: `tests/sandbox-security-contract.test.mjs`. Also asserted by the `nexus-sandbox.test.mjs`
case "repo.test fails closed when the sandbox backend is unavailable".

**Tier 2 — needs unprivileged user namespaces (`unshare -r`).** Proves the kernel actually enforces
the boundary. File: `tests/nexus-sandbox.test.mjs` and `tests/nexus-adapters.test.mjs`. When the host
blocks namespaces (GitHub-hosted runners do), the 14 isolation cases and the 6 sandbox-dependent
adapter cases are skipped with a reason such as
`sandbox backend unavailable: namespace probe failed: namespace probe exited 1 | missing capability: unprivileged user namespaces (unshare -r) | alternative: npm run sandbox:check on a namespace-capable Linux host…`.

**Tier 3 — dedicated security host.** Everything in Tier 2 plus attack cases that need a host you may
deliberately damage or observe from outside: kernel-level network capture, mount-namespace escape
attempts, cgroup-level accounting under sustained load, and a real egress probe. There is no
GitHub-hosted runner with these properties, and this repository does not weaken a runner
(`sysctl`, AppArmor, `--privileged`) to simulate them. Run `npm run sandbox:check` on such a host and
the same suites cover Tier 2; Tier 3 items are listed here as **not yet automated**.

## Guarantee → test map

| Required guarantee | Tier | Test |
| --- | --- | --- |
| Host filesystem isolation | 2 | `nexus-sandbox`: "host filesystem and parent directories are not visible" |
| Checkout boundary enforcement | 1 + 2 | `nexus-sandbox`: "production configuration and non-allowlisted files are not copied", "the host checkout cannot be modified by the test"; `nexus-adapters`: "repo.inspect rejects traversal, absolute paths, disallowed prefixes and symlink escapes" |
| Secret and environment-variable isolation | 2 | `nexus-sandbox`: "inherited environment secrets are absent"; `nexus-adapters`: "repo.test does not leak service secrets into the child environment" |
| Network isolation | 2 | `nexus-sandbox`: "outbound network access is unavailable" |
| Symlink and path-traversal protection | 2 | `nexus-sandbox`: "symlinks and traversal cannot escape the checkout" |
| Child-process containment | 2 | `nexus-sandbox`: "detached child processes do not outlive the sandbox" |
| CPU / memory / file-size / process limits | 2 | `nexus-sandbox`: "excessive process creation is capped by the host process-group supervisor", "memory exhaustion is contained by RLIMIT_AS", "writes outside the isolated checkout are refused and /work stays writable" |
| Capability dropping and `no_new_privs` | 2 | `nexus-sandbox`: "capabilities are dropped and no_new_privs is set" |
| Timeout and process-tree termination | 2 | `nexus-sandbox`: "a hung test is killed with its process tree on timeout"; `nexus-adapters`: "repo.test kills a hung command and reports the timeout" |
| Output redaction and secret leakage prevention | 2 | `nexus-sandbox`: "recognizable secret output never leaves the sandbox"; `nexus-adapters`: "repo.test never echoes command output that could contain a secret" |
| Failure-closed when prerequisites are missing | 1 | `sandbox-security-contract`: "a host without chroot is reported unavailable…", "the adapter refuses rather than falling back to host execution…", "runSandboxed refuses with a typed code…"; `nexus-sandbox`: "repo.test fails closed when the sandbox backend is unavailable" |
| Exit code and duration fidelity | 2 | `nexus-sandbox`: "exit codes and duration are preserved exactly"; `nexus-adapters`: "repo.test runs an allowlisted command and reports the real exit code and evidence" |
| No leftover sandbox state | 2 | `nexus-sandbox`: "no sandbox working directories are left behind" |

## Current status (recorded honestly)

- On this VM (namespace-capable): the full Tier 2 suite passes with no skips. See
  `docs/NEXUS_MISSION_08.md` for the run.
- On GitHub-hosted `ubuntu-latest`: Tier 1 passes, Tier 2 is **skipped** because the runner blocks
  unprivileged user namespaces (`namespace probe failed: namespace probe exited 1`). The
  `NEXUS Sandbox Security` workflow writes that verdict into the job summary and emits a warning —
  it does not present a skipped run as proven isolation.
- Tier 3 is documented but not automated.

## How to verify in a dedicated environment

```bash
npm ci
npm run sandbox:check -- --require    # exit 2 means the host cannot run the sandbox
node --test tests/nexus-sandbox.test.mjs tests/nexus-adapters.test.mjs tests/sandbox-security-contract.test.mjs
```

A host that cannot run the sandbox is still a valid host for Tier 1: the refusal itself is the
assertion.
