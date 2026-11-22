/**
 * Hard cost limits for NEXUS model calls.
 *
 * A call must reserve before it starts: the estimate is checked against both the per-task ceiling and
 * the remaining daily ceiling, then held in the ledger so two concurrent missions cannot both spend
 * the last of the day's budget. When the call finishes, `settle` replaces the reservation with the
 * actual cost. A failure is still settled: a provider that timed out may already have billed tokens.
 *
 * `freeOnly` is the default. It refuses any call whose provider/model is not explicitly free, before
 * any request is made. There is no code path that "upgrades" a free-only call to a paid one.
 *
 * The ledger is process-local by default. That is a real limit: a restart starts a new daily total.
 * Pass a durable store implementing `{ read(day), write(day, value) }` to keep the daily figure
 * across restarts; the enforcement logic is unchanged.
 */

export const COST_LIMITS = Object.freeze({
  taskUsd: 0.02,
  dailyUsd: 0.25,
  estimateUsd: 0.006
});

function money(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function dayKey(now = new Date()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function resolveCostLimits(env = process.env) {
  const freeOnly = String(env.NEXUS_FREE_ONLY ?? "true").trim().toLowerCase() !== "false";
  return {
    taskUsd: money(env.NEXUS_TASK_COST_LIMIT_USD, COST_LIMITS.taskUsd),
    dailyUsd: money(env.NEXUS_DAILY_COST_LIMIT_USD, COST_LIMITS.dailyUsd),
    estimateUsd: money(env.NEXUS_MODEL_ESTIMATE_USD, COST_LIMITS.estimateUsd),
    freeOnly
  };
}

export function createMemoryCostStore() {
  const days = new Map();
  return {
    async read(day) {
      const value = days.get(day);
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
    async write(day, value) {
      days.set(day, JSON.parse(JSON.stringify(value)));
      return true;
    },
    snapshot() {
      return [...days.entries()].map(([day, value]) => ({ day, ...value }));
    }
  };
}

function emptyDay(day) {
  return { day, spentUsd: 0, reservedUsd: 0, calls: 0, refused: 0, tasks: {} };
}

export function createCostGovernor({
  limits = {},
  store = createMemoryCostStore(),
  freeOnly = true,
  now = () => new Date()
} = {}) {
  const config = {
    taskUsd: money(limits.taskUsd, COST_LIMITS.taskUsd),
    dailyUsd: money(limits.dailyUsd, COST_LIMITS.dailyUsd),
    estimateUsd: money(limits.estimateUsd, COST_LIMITS.estimateUsd)
  };
  let queue = Promise.resolve();

  /** Serialize ledger writes so a read-modify-write cannot lose a concurrent reservation. */
  function locked(work) {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function readDay() {
    const day = dayKey(now());
    const value = (await store.read(day)) || emptyDay(day);
    return { ...emptyDay(day), ...value, day, tasks: { ...(value.tasks || {}) } };
  }

  async function writeDay(value) {
    await store.write(value.day, value);
    return value;
  }

  function summary(value, event = null) {
    const taskSpent = Object.values(value.tasks || {}).reduce((total, entry) => total + money(entry?.spentUsd), 0);
    return {
      ok: event === null,
      code: event,
      day: value.day,
      spentUsd: Number(value.spentUsd.toFixed(6)),
      reservedUsd: Number(value.reservedUsd.toFixed(6)),
      taskSpentUsd: Number(taskSpent.toFixed(6)),
      remainingDailyUsd: Number(Math.max(0, config.dailyUsd - value.spentUsd - value.reservedUsd).toFixed(6)),
      remainingTaskUsd: Number(Math.max(0, config.taskUsd - taskSpent).toFixed(6)),
      taskUsd: config.taskUsd,
      dailyUsd: config.dailyUsd,
      freeOnly,
      calls: value.calls,
      refused: value.refused
    };
  }

  async function reserve({ taskId, estimateUsd = config.estimateUsd, free = null, provider = null, model = null } = {}) {
    const id = String(taskId || "").trim().slice(0, 160);
    if (!id) return { ok: false, code: "task_id_required" };
    if (freeOnly && free !== true) {
      return locked(async () => {
        const value = await readDay();
        value.refused += 1;
        await writeDay(value);
        return { ...summary(value, "free_only_refused"), taskId: id, provider, model };
      });
    }
    const amount = money(estimateUsd, config.estimateUsd);
    return locked(async () => {
      const value = await readDay();
      const taskSpent = money(value.tasks[id]?.spentUsd);
      if (taskSpent + amount > config.taskUsd) {
        value.refused += 1;
        await writeDay(value);
        return { ...summary(value, "task_budget_exceeded"), taskId: id, requestedUsd: amount };
      }
      if (value.spentUsd + value.reservedUsd + amount > config.dailyUsd) {
        value.refused += 1;
        await writeDay(value);
        return { ...summary(value, "daily_budget_exceeded"), taskId: id, requestedUsd: amount };
      }
      value.reservedUsd = money(value.reservedUsd) + amount;
      value.tasks[id] = {
        reservedUsd: money(value.tasks[id]?.reservedUsd) + amount,
        spentUsd: taskSpent,
        calls: money(value.tasks[id]?.calls)
      };
      await writeDay(value);
      return { ...summary(value), taskId: id, reservedUsdForCall: amount };
    });
  }

  async function settle({ taskId, estimateUsd = config.estimateUsd, costUsd = 0, ok = true } = {}) {
    const id = String(taskId || "").trim().slice(0, 160);
    if (!id) return { ok: false, code: "task_id_required" };
    const reserved = money(estimateUsd, config.estimateUsd);
    const actual = money(costUsd, 0);
    return locked(async () => {
      const value = await readDay();
      const task = value.tasks[id] || { reservedUsd: 0, spentUsd: 0, calls: 0 };
      value.reservedUsd = Math.max(0, money(value.reservedUsd) - Math.min(reserved, money(task.reservedUsd)));
      value.spentUsd = money(value.spentUsd) + actual;
      value.calls += ok ? 1 : 0;
      value.tasks[id] = {
        reservedUsd: Math.max(0, money(task.reservedUsd) - reserved),
        spentUsd: money(task.spentUsd) + actual,
        calls: money(task.calls) + (ok ? 1 : 0)
      };
      if (value.tasks[id].reservedUsd === 0 && value.tasks[id].spentUsd === 0) delete value.tasks[id];
      await writeDay(value);
      return {
        ...summary(value, actual > config.taskUsd ? "task_limit_exceeded_after_settlement" : null),
        ok: actual <= config.taskUsd,
        taskId: id,
        chargedUsd: actual
      };
    });
  }

  async function release({ taskId, estimateUsd = config.estimateUsd } = {}) {
    return settle({ taskId, estimateUsd, costUsd: 0, ok: false });
  }

  async function status() {
    return locked(async () => summary(await readDay()));
  }

  return Object.freeze({
    reserve,
    settle,
    release,
    status,
    limits: Object.freeze({ ...config, freeOnly }),
    store
  });
}
