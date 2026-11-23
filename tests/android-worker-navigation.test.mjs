import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const overlay = await readFile(new URL("../app/src/main/java/com/habitat/HabitatOverlay.kt", import.meta.url), "utf8");
const brain = await readFile(new URL("../app/src/main/java/com/habitat/BrainAdapter.kt", import.meta.url), "utf8");
const activity = await readFile(new URL("../app/src/main/java/com/habitat/MainActivity.kt", import.meta.url), "utf8");

test("worker rows are hit-tested before the generic panel-close rule", () => {
  const workerHit = overlay.indexOf("WORKERS rows: real hit targets");
  const genericClose = overlay.indexOf("if (panel && e.y < height * .70f) {\n            panel = false");
  assert.ok(workerHit > 0, "worker hit-test block must exist");
  assert.ok(genericClose > 0, "generic close block must exist");
  assert.ok(workerHit < genericClose, "worker taps must be resolved before closing the panel");
  for (const id of ["product-scout", "listing-opt", "growth-ops"]) {
    assert.equal(overlay.includes(`"${id}"`), true, id + " row must be addressable");
  }
});

test("the hit rectangles use exactly the row positions the canvas draws", () => {
  // drawPanel places rows at top + .150/.245/.340/.435 of the panel height, each .070 tall.
  for (const [hit, drawn] of [[".150f", ".15f"], [".245f", ".245f"], [".340f", ".34f"], [".435f", ".435f"]]) {
    assert.equal(overlay.includes(`panelTop + height * ${hit}`), true, "hit row " + hit);
    assert.equal(overlay.includes(`top + height * ${drawn}`), true, "drawn row " + drawn);
  }
  assert.equal(overlay.includes("e.y <= rowTop + height * .070f"), true, "row height must match");
  assert.equal(overlay.includes("panel && selected == 1"), true, "only the WORKERS tab owns these rows");
});

test("the detail view replaces the mesh and BACK restores it", () => {
  assert.equal(overlay.includes("if (workerPanel != null) drawWorkerPanel(c) else if (panel) drawPanel(c)"), true);
  assert.equal(overlay.includes("onWorkerAction?.invoke(\"refresh\")"), true);
  assert.equal(overlay.includes("if (e.x in backLeft..backRight) { workerPanel = null; invalidate(); return true }"), true);
});

test("worker detail is a real view with callbacks, not decorative text", () => {
  assert.equal(overlay.includes("var onWorkerSelected"), true);
  assert.equal(overlay.includes("var onWorkerAction"), true);
  assert.equal(overlay.includes("fun openWorker("), true);
  assert.equal(overlay.includes("fun setWorkerDetail("), true);
  assert.equal(overlay.includes("private fun drawWorkerPanel("), true);
  assert.equal(overlay.includes("RETRY JOB"), true);
  assert.equal(overlay.includes("RUN CHECK"), true);
  assert.equal(overlay.includes("EXECUTION LOG"), false, "logs are rendered from server lines, not hardcoded");
});

test("the Activity wires selection to the worker detail endpoint and retry", () => {
  assert.equal(activity.includes("ui.onWorkerSelected = { id -> loadWorker(id) }"), true);
  assert.equal(activity.includes("brain.fetchWorkerDetail(id)"), true);
  assert.equal(activity.includes("brain.retryWorkerTask(activeRetryTaskId)"), true);
  assert.equal(activity.includes("ui.setWorkerDetail("), true);
});

test("system-check reporting cannot print a JSON null worker error", () => {
  assert.equal(brain.includes("private fun optText("), true, "null-safe text helper must exist");
  assert.equal(brain.includes('if (value == "null" || value == "undefined") ""'), true);
  assert.equal(brain.includes('optText(task, "error")'), true);
  assert.equal(brain.includes("BLOCKED BECAUSE:"), true);
  assert.equal(brain.includes("CHECK DETAIL:"), true);
  // The raw org.json call that produced the literal "null" must be gone from this path.
  assert.equal(/val error\s*=\s*task\.optString\("error"/.test(brain), false);
});
