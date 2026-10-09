export function buildCapabilityStatus({
  env = process.env,
  aiProviderConfigured = false,
  workerRegistered = false,
  androidStatus = "UNVERIFIED",
  memoryProbePassed = false,
  taskRepositoryConfigured = false,
  taskRepositoryReady = false
} = {}) {
  const d1CredentialsPresent = taskRepositoryConfigured || Boolean(
    String(env.CLOUDFLARE_ACCOUNT_ID || "").trim() &&
    String(env.HABITAT_D1_DATABASE_ID || "").trim() &&
    String(env.HABITAT_D1_API_TOKEN || "").trim()
  );

  const worker = aiProviderConfigured && workerRegistered
    ? { status: "configured_unverified", detail: "Worker is registered and an AI provider is configured; this endpoint does not prove a live inference succeeded." }
    : { status: "blocked", detail: "Worker execution requires a registered worker and a configured AI provider." };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    policy: "Configuration is not proof of execution. Publishing must remain approval-gated.",
    capabilities: {
      backend: { status: "ready", detail: "HTTP server is responding to this request." },
      aiInference: aiProviderConfigured
        ? { status: "configured_unverified", detail: "At least one provider credential is configured; use /system-check to verify a live inference." }
        : { status: "blocked", detail: "No supported AI provider credential is configured." },
      aiWorker: worker,
      taskExecution: taskRepositoryReady
        ? { status: "available_durable_task_routes", detail: "Task routes are wired to D1 and startup recovery loaded persisted task records. Content jobs and TikTok OAuth state still use separate in-memory stores." }
        : { status: "available_memory_only", detail: "Task routes are available, but task records currently live in process memory and can be lost on restart." },
      taskPersistence: {
        status: taskRepositoryReady ? "ready" : "blocked",
        adapter: taskRepositoryReady ? "cloudflare-d1" : "in-memory",
        durable: taskRepositoryReady,
        d1CredentialsPresent: d1CredentialsPresent,
        d1Integrated: true,
        restartRecovery: taskRepositoryReady,
        detail: taskRepositoryReady
          ? "D1 credentials, schema initialization, and startup task restoration succeeded."
          : d1CredentialsPresent
            ? "D1 repository is wired but not ready. If configured credentials fail, startup should fail closed rather than silently use memory."
            : "D1 repository is wired, but durable task storage is not active. Configure account ID, database ID, and a least-privilege D1 API token." 
      },
      contentJobPersistence: {
        status: "memory_only",
        durable: false,
        detail: "Content pipeline jobs, TikTok OAuth state, and OAuth tokens are separate in-memory stores and are not made durable by task-route D1 integration."
      },
      androidDevice: androidStatus === "PASS"
        ? { status: "verified_recent_heartbeat", detail: "A recent Android heartbeat is registered." }
        : { status: "unverified", detail: "No recent Android heartbeat is currently verified." },
      externalPublishing: { status: "approval_gated_unverified", detail: "This status does not establish TikTok authorization or publication capability. Never report a post as published without a confirming platform response and user approval." },
      contentQualityGates: { status: "unverified", detail: "A capability listing is not proof that a specific media artifact passed scene, caption, dimension, duration, and audio QA." }
    },
    secretsExposed: false
  };
}
