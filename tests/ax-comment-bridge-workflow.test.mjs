import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Validation for .github/workflows/ax-comment-bridge.yml.
 *
 * The workflow is the only place the dry-run decision lives, so these tests read the shipped file:
 * the YAML is parsed for real (PyYAML), and the `should_dry_run` function is extracted and executed
 * by bash exactly as written. No copy of the logic is asserted here, so the test cannot drift from
 * what Actions will run.
 */

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKFLOW_PATH = path.join(ROOT, ".github/workflows/ax-comment-bridge.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

function parseWorkflow() {
  const json = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding='utf-8'))))", WORKFLOW_PATH],
    { encoding: "utf8" }
  );
  return JSON.parse(json);
}

function extractDryRunFunction() {
  const start = WORKFLOW.indexOf("should_dry_run() {");
  assert.notEqual(start, -1, "the workflow must define should_dry_run()");
  const tail = WORKFLOW.slice(start);
  const end = tail.indexOf("\n          }");
  assert.notEqual(end, -1, "should_dry_run() must close at the step's own indentation");
  return tail.slice(0, end + "\n          }".length);
}

/** Run the shipped function under bash: "dry" means the bridge would be started with --dry-run. */
function decide(eventName, inputDryRun) {
  const script = [
    extractDryRunFunction(),
    `if should_dry_run "${eventName}" "${inputDryRun}"; then echo dry; else echo real; fi`
  ].join("\n");
  return execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim();
}

test("the workflow is valid YAML and declares exactly the two intended triggers", () => {
  const parsed = parseWorkflow();
  // YAML 1.1 parses the unquoted key `on` as boolean true.
  const triggers = parsed.on ?? parsed[true];
  assert.ok(triggers, "the workflow must declare triggers");
  assert.ok(triggers.issue_comment, "issue_comment must be a trigger");
  assert.deepEqual(triggers.issue_comment.types, ["created"]);
  assert.ok(triggers.workflow_dispatch, "workflow_dispatch must be a trigger");
  assert.equal(triggers.workflow_dispatch.inputs.dry_run.default, true, "manual dispatch stays dry by default");
});

test("an issue_comment event runs for real, even though inputs.dry_run is absent", () => {
  assert.equal(decide("issue_comment", ""), "real");
  assert.equal(decide("issue_comment", "true"), "real", "a stray input never silences the event path");
});

test("workflow_dispatch keeps the safe dry-run default", () => {
  assert.equal(decide("workflow_dispatch", ""), "dry", "absent input must not write");
  assert.equal(decide("workflow_dispatch", "true"), "dry");
  assert.equal(decide("workflow_dispatch", "false"), "real", "an explicit false is the only way to write");
});

test("an unknown trigger stays dry rather than guessing", () => {
  assert.equal(decide("push", ""), "dry");
  assert.equal(decide("", ""), "dry");
});

test("the regression that defaulted issue_comment to dry-run is gone", () => {
  assert.equal(WORKFLOW.includes('"${INPUT_DRY_RUN:-true}" == "true"'), false);
  assert.match(WORKFLOW, /if should_dry_run "\$EVENT_NAME"/);
});

test("the workflow still carries its safety rails", () => {
  const parsed = parseWorkflow();
  const job = parsed.jobs.respond;
  assert.match(job.if, /github\.event\.comment\.user\.login == github\.repository_owner/);
  assert.match(job.if, /github\.event\.comment\.user\.type != 'Bot'/);
  assert.match(job.if, /github\.event\.issue\.number == 93/);
  assert.match(job.if, /!github\.event\.comment\.pull_request_review_id/);
  assert.deepEqual(parsed.permissions, { contents: "read", issues: "write", "pull-requests": "write" });
  const step = job.steps.find(item => item.id === "bridge");
  assert.equal(step.env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(step.env.INPUT_DRY_RUN, "${{ inputs.dry_run }}");
  assert.equal(step.env.GITHUB_TOKEN, "${{ secrets.GITHUB_TOKEN }}");
});
