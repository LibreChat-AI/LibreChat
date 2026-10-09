import { AsyncLocalStorage } from 'node:async_hooks';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';

/**
 * Detached subagents outlive the parent turn that launched them. This
 * request-local collector lets the shared SDK usage sink recognize those
 * calls without retaining a request object or changing the SDK task-store
 * contract. AsyncLocalStorage follows the detached executor's promise chain
 * and naturally isolates concurrent child tasks.
 */
const detachedUsageStorage = new AsyncLocalStorage<UsageMetadata[]>();

export function runWithDetachedSubagentUsage<T>(
  usage: UsageMetadata[],
  run: () => Promise<T>,
): Promise<T> {
  return detachedUsageStorage.run(usage, run);
}

/** Records one detached usage item and reports whether a task context owned it. */
export function collectDetachedSubagentUsage(usage: UsageMetadata): boolean {
  const collector = detachedUsageStorage.getStore();
  if (collector == null) {
    return false;
  }
  collector.push(usage);
  return true;
}
