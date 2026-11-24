import test from "node:test";
import assert from "node:assert/strict";
import { createProjectRegistry, PROJECT_IDS, projectScopeAllows } from "../ax-projects.mjs";
import { createObjectiveService } from "../ax-objectives.mjs";
import { createMemoryObjectiveRepository } from "../ax-objective-repository.mjs";

test("three projects are listed with explicit boundaries and approval requirements", async () => {
  const registry = createProjectRegistry();
  const listed = await registry.list();
  assert.deepEqual(listed.projects.map(item => item.id), [...PROJECT_IDS]);
  for (const project of listed.projects) {
    assert.ok(project.requiredApprovals.length > 0);
    assert.ok(project.boundaries.length > 0);
    assert.equal(project.scope.crossProjectActions, "denied");
    assert.ok(project.integrations.every(integration => integration.state === "not_checked"));
  }
});

test("project detail only includes objectives created under that project", async () => {
  const objectives = createObjectiveService({ repository: createMemoryObjectiveRepository() });
  const droppilot = await objectives.create({
    objective: "Draft a supplier comparison for a product",
    criteria: ["Sources are recorded", "No purchase is made"],
    key: "droppilot-work",
    project: "droppilot"
  });
  await objectives.create({
    objective: "Inspect the scheduler contract",
    criteria: ["A check exits zero", "Evidence is recorded"],
    key: "habitat-work",
    project: "habitat"
  });
  const registry = createProjectRegistry({ objectives });
  const listed = await registry.list();
  const drop = listed.projects.find(item => item.id === "droppilot");
  assert.equal(drop.objectives.total, 1);
  assert.equal(drop.objectives.recent[0].id, droppilot.objective.id);
  const habitat = listed.projects.find(item => item.id === "habitat");
  assert.equal(habitat.objectives.total, 1);
  assert.notEqual(habitat.objectives.recent[0].id, droppilot.objective.id);
});

test("one project's scope never authorizes another", () => {
  assert.equal(projectScopeAllows("droppilot", "droppilot"), true);
  assert.equal(projectScopeAllows("droppilot", "vice-city-files"), false);
  assert.equal(projectScopeAllows("Habitat", "droppilot"), false);
  assert.equal(projectScopeAllows(null, "habitat"), false);
  assert.equal(projectScopeAllows("unknown", "unknown"), false);
});

test("an unknown project has no detail and no fallback record", async () => {
  const registry = createProjectRegistry();
  await assert.doesNotReject(async () => {
    assert.equal(await registry.detail("not-a-project"), null);
  });
});
