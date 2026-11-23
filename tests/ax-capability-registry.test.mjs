import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_KINDS,
  CAPABILITY_STATES,
  createCapabilityRegistry,
  defaultCapabilities,
  resolveCapabilityState
} from "../ax-capability-registry.mjs";

const base = {
  id: "test.capability",
  kind: "model",
  name: "Test capability",
  purpose: "Exercise the registry.",
  sideEffects: "read",
  state: "available",
  cost: { model: "none" }
};

test("the shipped catalog only uses known kinds and states", () => {
  const registry = createCapabilityRegistry({ env: {} });
  assert.ok(registry.capabilities.length >= 15);
  for (const capability of registry.capabilities) {
    assert.ok(CAPABILITY_KINDS.includes(capability.kind), capability.id);
    assert.ok(CAPABILITY_STATES.includes(capability.state), capability.id);
  }
  const summary = registry.summary();
  assert.equal(summary.count, registry.capabilities.length);
  assert.equal(Object.values(summary.byKind).reduce((a, b) => a + b, 0), summary.count);
  assert.ok(summary.approvalGated.includes("fulfillment.purchase"));
  assert.ok(summary.approvalGated.includes("treasury.transfer"));
});

test("a paid capability without approval is refused at construction", () => {
  assert.throws(
    () => createCapabilityRegistry({ env: {}, capabilities: [{ ...base, cost: { model: "paid", note: "billed" } }] }),
    /must require owner approval/
  );
  const gated = createCapabilityRegistry({
    env: {},
    capabilities: [{ ...base, cost: { model: "paid", note: "billed" }, requiresApproval: true }]
  });
  assert.equal(gated.get("test.capability").requiresApproval, true);
});

test("a capability that can spend, move money or publish must be approval gated", () => {
  for (const sideEffects of ["payment", "transfer", "payout", "external_publish", "oauth", "credentials", "install"]) {
    assert.throws(
      () => createCapabilityRegistry({ env: {}, capabilities: [{ ...base, sideEffects }] }),
      /must require owner approval/,
      sideEffects
    );
  }
});

test("policy-only capabilities always require approval and are never reported as available", () => {
  assert.throws(
    () => createCapabilityRegistry({ env: {}, capabilities: [{ ...base, state: "policy_only" }] }),
    /must require owner approval/
  );
  const registry = createCapabilityRegistry({ env: {} });
  for (const capability of registry.list({ state: "policy_only" })) {
    assert.equal(capability.requiresApproval, true, capability.id);
  }
  assert.equal(registry.get("fulfillment.purchase").state, "policy_only");
  assert.equal(registry.get("treasury.transfer").state, "policy_only");
});

test("missing configuration is reported by variable name and never by value", () => {
  const state = resolveCapabilityState({ state: "available", envKeys: ["SOME_PROVIDER_KEY"], detail: null }, {});
  assert.equal(state.state, "unconfigured");
  assert.match(state.detail, /SOME_PROVIDER_KEY/);

  const secret = "sk-live-should-never-be-echoed-1234567890";
  const registry = createCapabilityRegistry({
    env: { SOME_PROVIDER_KEY: secret },
    capabilities: [{ ...base, envKeys: ["SOME_PROVIDER_KEY"] }]
  });
  const serialized = JSON.stringify(registry.capabilities);
  assert.equal(serialized.includes(secret), false);
  assert.equal(registry.get("test.capability").state, "available");
});

test("an unknown capability fails closed on approval questions", () => {
  const registry = createCapabilityRegistry({ env: {} });
  const decision = registry.approvalRequiredFor("does.not.exist", "spend");
  assert.equal(decision.required, true);
  assert.equal(decision.known, false);
  assert.equal(registry.approvalRequiredFor("governance.approvals", "decide").required, false);
  assert.equal(registry.get("does.not.exist"), null);
});

test("the default catalog is stable and every entry declares its cost model", () => {
  const first = defaultCapabilities();
  const second = defaultCapabilities();
  assert.deepEqual(first.map(item => item.id), second.map(item => item.id));
  for (const capability of first) {
    assert.ok(capability.cost?.model, capability.id);
  }
  // The normalized registry entry always declares its free-first posture.
  for (const capability of createCapabilityRegistry({ env: {} }).capabilities) {
    assert.equal(capability.freeFirst, true, capability.id);
  }
});
