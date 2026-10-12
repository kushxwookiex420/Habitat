const PROVIDER_FAILURE_STATES = new Set(["error", "failed", "rejected", "blocked"]);
const PROVIDER_READY_STATES = new Set(["ready", "accepted", "scheduled"]);

function hold(reason, details = {}) {
  return { ok: false, decision: "HOLD", reason, ...details };
}

/**
 * Evaluate a scheduled social post using evidence already collected elsewhere.
 * This is a fail-closed policy gate, not a publisher and not a substitute for
 * querying the platform's live status.
 */
export function evaluateScheduledPost({
  postId,
  network,
  providerStatus,
  draft,
  autoPublish,
  mediaPreflight,
  explicitApproval,
  approvedPostId,
  approvalRecordedAt
} = {}) {
  const id = String(postId || "").trim();
  const target = String(network || "").trim().toLowerCase();
  if (!id) return hold("post_id_missing");
  if (!target) return hold("target_network_missing");

  const status = String(providerStatus || "").trim().toLowerCase();
  if (!status) return hold("provider_status_unknown");
  if (PROVIDER_FAILURE_STATES.has(status)) {
    return hold("provider_reports_failure", { providerStatus: status });
  }
  if (!PROVIDER_READY_STATES.has(status)) {
    return hold("provider_status_not_confirmed_ready", { providerStatus: status });
  }

  if (draft !== false) return hold("post_is_still_a_draft");
  if (mediaPreflight?.ok !== true || mediaPreflight?.decision !== "PASS") {
    return hold("media_preflight_not_passed", {
      mediaReason: mediaPreflight?.reason || "media_preflight_missing_or_unverified"
    });
  }
  if (String(mediaPreflight.network || "").toLowerCase() !== target) {
    return hold("media_preflight_network_mismatch");
  }

  const approvalTime = Date.parse(String(approvalRecordedAt || ""));
  if (explicitApproval !== true || String(approvedPostId || "").trim() !== id ||
      !Number.isFinite(approvalTime) || approvalTime > Date.now()) {
    return hold("explicit_post_approval_required");
  }

  return {
    ok: true,
    decision: "READY_FOR_HUMAN_REVIEW",
    postId: id,
    network: target,
    providerStatus: status,
    autoPublishRequested: autoPublish === true,
    requiresHumanReview: true,
    publisherInvoked: false,
    sideEffectsPerformed: false,
    checkedAt: new Date().toISOString(),
    note: "Readiness evidence only. This gate does not schedule, publish, or verify final platform acceptance."
  };
}
