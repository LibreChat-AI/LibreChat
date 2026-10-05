import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import { collectModelUsage } from './collection';

/**
 * Detached subagents outlive the parent turn that launched them. This
 * request-local collector lets the shared SDK usage sink recognize those
 * calls without retaining a request object or changing the SDK task-store
 * contract. AsyncLocalStorage follows the detached executor's promise chain
 * and naturally isolates concurrent child tasks.
 */
const detachedUsageStorage = new AsyncLocalStorage<{
  usage: UsageMetadata[];
  recordings: Map<string, Promise<void>>;
}>();

export function runWithDetachedSubagentUsage<T>(
  usage: UsageMetadata[],
  run: () => Promise<T>,
): Promise<T> {
  return detachedUsageStorage.run({ usage, recordings: new Map() }, run);
}

/** Retain consumption before billing; duplicate completion/failure signals await the same write. */
export function collectDetachedSubagentUsage(
  usage: UsageMetadata,
  recordUsage: (usage: UsageMetadata) => void | Promise<void>,
): Promise<void> | undefined {
  const collector = detachedUsageStorage.getStore();
  if (collector == null) {
    return undefined;
  }
  collectModelUsage(collector.usage, usage);
  const existing = usage.modelRunId ? collector.recordings.get(usage.modelRunId) : undefined;
  if (existing) return existing;
  const recording = Promise.resolve().then(() => recordUsage(usage));
  if (usage.modelRunId) collector.recordings.set(usage.modelRunId, recording);
  return recording;
}
