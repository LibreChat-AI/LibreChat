import { Gauge, Counter, Histogram } from 'prom-client';
import {
  mediaApiSchema,
  mediaOperationSchema,
  mediaJobPhaseSchema,
  mediaErrorCodeSchema,
} from 'librechat-data-provider';
import type { MediaBacklogMetrics } from '@librechat/data-schemas';
import type { Registry } from 'prom-client';
import type { MediaMetricEvent } from './telemetry';

export function createMediaLifecycleMetrics(registry: Registry): (event: MediaMetricEvent) => void {
  const workerState = new Gauge({
    name: 'media_worker_state',
    help: 'Current process media worker state',
    labelNames: ['state'],
    registers: [registry],
  });
  const workerFailures = new Gauge({
    name: 'media_worker_consecutive_scan_failures',
    help: 'Consecutive failed scans in this process',
    registers: [registry],
  });
  const shared = ['result', 'api', 'operation', 'execution_owner'] as const;
  const longBuckets = [0.01, 0.1, 1, 5, 15, 60, 300, 900, 3600];
  const shortBuckets = [0.001, 0.01, 0.1, 1, 5, 15, 30];
  const attempts = new Counter({
    name: 'media_attempts_total',
    help: 'Media execution attempt observations',
    labelNames: shared,
    registers: [registry],
  });
  const attemptDuration = new Histogram({
    name: 'media_attempt_duration_seconds',
    help: 'Elapsed execution attempt time',
    labelNames: shared,
    buckets: longBuckets,
    registers: [registry],
  });
  const transitions = new Counter({
    name: 'media_transitions_total',
    help: 'Durable media phase changes',
    labelNames: ['from_phase', 'to_phase', 'api', 'operation'],
    registers: [registry],
  });
  const phaseDuration = new Histogram({
    name: 'media_phase_duration_seconds',
    help: 'Elapsed time in the phase exited by a durable transition',
    labelNames: ['phase', 'api', 'operation'],
    buckets: longBuckets,
    registers: [registry],
  });
  const settlements = new Counter({
    name: 'media_settlements_total',
    help: 'Media accounting settlement observations',
    labelNames: shared,
    registers: [registry],
  });
  const settlementDuration = new Histogram({
    name: 'media_settlement_duration_seconds',
    help: 'Elapsed media accounting settlement time',
    labelNames: shared,
    buckets: shortBuckets,
    registers: [registry],
  });
  const cancellations = new Counter({
    name: 'media_cancellations_total',
    help: 'Media cancellation observations',
    labelNames: shared,
    registers: [registry],
  });
  const cleanup = new Counter({
    name: 'media_cleanup_operations_total',
    help: 'Media maintenance results by task',
    labelNames: ['task', 'result'],
    registers: [registry],
  });
  const cleanupDuration = new Histogram({
    name: 'media_cleanup_duration_seconds',
    help: 'Elapsed media maintenance time by task',
    labelNames: ['task', 'result'],
    buckets: shortBuckets,
    registers: [registry],
  });
  const failures = new Counter({
    name: 'media_failures_total',
    help: 'Media failures by bounded public error code',
    labelNames: ['code', 'api'],
    registers: [registry],
  });
  const queueWait = new Histogram({
    name: 'media_queue_wait_seconds',
    help: 'Elapsed queue age when a media job is claimed',
    labelNames: ['api', 'operation'],
    buckets: longBuckets,
    registers: [registry],
  });
  const cleanupTasks = new Set([
    'account_deletion',
    'asset_write',
    'expired_asset',
    'retirement',
    'native',
    'consumers',
    'permits',
    'accounting',
    'staging',
  ]);
  return (event) => {
    if (!['started', 'completed', 'failed', 'interrupted'].includes(event.result)) return;
    const api = mediaApiSchema.safeParse(event.api).data ?? 'none';
    const operation = mediaOperationSchema.safeParse(event.operation).data ?? 'none';
    const labels = {
      result: event.result,
      api,
      operation,
      execution_owner:
        event.executionOwner === 'chat' || event.executionOwner === 'media'
          ? event.executionOwner
          : 'none',
    };
    const duration =
      event.durationMs != null && Number.isFinite(event.durationMs) && event.durationMs >= 0
        ? event.durationMs / 1000
        : undefined;
    switch (event.kind) {
      case 'worker':
        if (event.worker) {
          for (const state of ['starting', 'armed', 'draining', 'unavailable'])
            workerState.set({ state }, event.worker.state === state ? 1 : 0);
          workerFailures.set(event.worker.consecutiveScanFailures);
        }
        return;
      case 'attempt':
        attempts.inc(labels);
        if (duration !== undefined) attemptDuration.observe(labels, duration);
        break;
      case 'transition': {
        const from = mediaJobPhaseSchema.safeParse(event.previousPhase).data;
        const to = mediaJobPhaseSchema.safeParse(event.phase).data;
        if (from && to && from !== to) {
          transitions.inc({ from_phase: from, to_phase: to, api, operation });
          if (duration !== undefined)
            phaseDuration.observe({ phase: from, api, operation }, duration);
        }
        break;
      }
      case 'settlement':
        settlements.inc(labels);
        if (duration !== undefined) settlementDuration.observe(labels, duration);
        break;
      case 'cancellation':
        cancellations.inc(labels);
        break;
      case 'cleanup':
        if (event.task && cleanupTasks.has(event.task)) {
          const cleanupLabels = { task: event.task, result: event.result };
          cleanup.inc(cleanupLabels);
          if (duration !== undefined) cleanupDuration.observe(cleanupLabels, duration);
        }
        break;
      default:
        return;
    }
    if (event.failureCode && mediaErrorCodeSchema.safeParse(event.failureCode).success)
      failures.inc({ code: event.failureCode, api });
    if (event.queueWaitMs != null && Number.isFinite(event.queueWaitMs) && event.queueWaitMs >= 0)
      queueWait.observe({ api, operation }, event.queueWaitMs / 1000);
  };
}

/** One cached repository snapshot serves all gauges in a scrape. */
export function createMediaBacklogGauges({
  registry,
  load,
  cacheMs,
  now = Date.now,
}: {
  registry: Registry;
  load?: () => Promise<MediaBacklogMetrics>;
  cacheMs: number;
  now?: () => number;
}): void {
  if (!load) return;
  let cached: { value: MediaBacklogMetrics; expires: number } | undefined;
  let pending: Promise<MediaBacklogMetrics> | undefined;
  const snapshot = () => {
    if (cached && cached.expires > now()) return Promise.resolve(cached.value);
    pending ??= load()
      .then((value) => {
        cached = { value, expires: now() + cacheMs };
        return value;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  const fields: Array<[keyof MediaBacklogMetrics, string, string]> = [
    ['queued', 'media_queue_depth', 'Accepted media jobs waiting for dispatch'],
    [
      'activeJobs',
      'media_active_jobs',
      'Accepted media jobs executing or awaiting provider reconciliation',
    ],
    [
      'oldestQueuedAgeSeconds',
      'media_oldest_queued_seconds',
      'Age of the oldest accepted queued media job',
    ],
    ['requiresAttention', 'media_requires_attention', 'Media jobs requiring operator recovery'],
    ['activePermits', 'media_permits_in_use', 'Held deployment media execution permits'],
    [
      'oldestExpiredLeaseSeconds',
      'media_oldest_expired_lease_seconds',
      'Age of the oldest expired media job lease',
    ],
    [
      'pendingAccountDeletions',
      'media_account_deletions_pending',
      'Media account deletions awaiting reconciliation',
    ],
  ];
  for (const [field, name, help] of fields) {
    new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        const value = (await snapshot())[field];
        this.set(Number.isFinite(value) ? Math.max(0, value) : 0);
      },
    });
  }
}
