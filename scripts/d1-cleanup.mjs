/**
 * Cleanup helper for the isolated D1 live test. Kept separate so the failure path can be tested
 * without requiring live Cloudflare credentials.
 */
export async function cleanupIsolatedRows(query, ids, log = console) {
  let failed = false;
  for (const id of ids) {
    try {
      await query("DELETE FROM habitat_command_tasks WHERE id = ?", [id]);
    } catch (error) {
      failed = true;
      log.error("CLEANUP FAILED (only prefixed test ids are targeted):", String(error?.message || error));
    }
  }
  if (failed) {
    process.exitCode = 1;
    return false;
  }
  log.log("Cleaned up " + ids.length + " isolated test record(s).");
  return true;
}
