import { Registry } from 'prom-client';
import { createMediaBacklogGauges, createMediaLifecycleMetrics } from './metrics';

test('exposes only the current process worker state and consecutive scan failures', async () => {
  const registry = new Registry();
  const record = createMediaLifecycleMetrics(registry);
  record({
    kind: 'worker',
    result: 'failed',
    worker: { state: 'unavailable', consecutiveScanFailures: 3 },
  });
  expect(await registry.metrics()).toContain('media_worker_state{state="unavailable"} 1');
  record({
    kind: 'worker',
    result: 'completed',
    worker: { state: 'armed', consecutiveScanFailures: 0 },
  });
  const output = await registry.metrics();
  expect(output).toContain('media_worker_state{state="unavailable"} 0');
  expect(output).toContain('media_worker_state{state="armed"} 1');
  expect(output).toContain('media_worker_consecutive_scan_failures 0');
});

test('separates attempts, phase time, settlement and cleanup with bounded labels', async () => {
  const registry = new Registry();
  const record = createMediaLifecycleMetrics(registry);
  record({
    kind: 'attempt',
    result: 'completed',
    api: 'openai.images',
    operation: 'image.generate',
    durationMs: 1000,
  });
  record({
    kind: 'transition',
    result: 'completed',
    api: 'openai.images',
    operation: 'image.generate',
    previousPhase: 'running',
    phase: 'ingesting',
    durationMs: 4000,
  });
  record({
    kind: 'settlement',
    result: 'completed',
    api: 'openai.images',
    operation: 'image.generate',
    durationMs: 200,
  });
  record({
    kind: 'cleanup',
    result: 'failed',
    task: 'account_deletion',
    failureCode: 'storage_failed',
    durationMs: 50,
  });
  const output = await registry.metrics();
  expect(output).toContain(
    'media_phase_duration_seconds_sum{phase="running",api="openai.images",operation="image.generate"} 4',
  );
  expect(output).not.toContain('media_phase_duration_seconds_sum{phase="ingesting"');
  expect(output).toContain(
    'media_cleanup_operations_total{task="account_deletion",result="failed"} 1',
  );
  expect(output).toContain('media_failures_total{code="storage_failed",api="none"} 1');
  expect(output).toContain(
    'media_settlement_duration_seconds_sum{result="completed",api="openai.images",operation="image.generate",execution_owner="none"} 0.2',
  );
  expect(output).not.toContain('media_lifecycle_');
});

test('shares a bounded-time snapshot across every backlog gauge and refreshes on expiry', async () => {
  const registry = new Registry();
  let clock = 100;
  const load = jest.fn(async () => ({
    queued: 3,
    activeJobs: 2,
    oldestQueuedAgeSeconds: 60,
    requiresAttention: 2,
    activePermits: 1,
    oldestExpiredLeaseSeconds: 10,
    pendingAccountDeletions: 4,
  }));
  createMediaBacklogGauges({ registry, load, cacheMs: 1000, now: () => clock });
  const first = await registry.metrics();
  expect(first).toContain('media_queue_depth 3');
  expect(first).toContain('media_active_jobs 2');
  expect(first).toContain('media_oldest_queued_seconds 60');
  expect(first).toContain('media_account_deletions_pending 4');
  expect(first).toContain('media_oldest_expired_lease_seconds 10');
  await registry.metrics();
  expect(load).toHaveBeenCalledTimes(1);
  clock += 1001;
  await registry.metrics();
  expect(load).toHaveBeenCalledTimes(2);
});
