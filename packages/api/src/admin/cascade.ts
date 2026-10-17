import { logger } from '@librechat/data-schemas';
import { getSafeErrorMetadata } from '~/utils/errors';

/** One removal in a delete cascade, with the way to put back what it removed. */
export interface CascadeStep {
  name: string;
  /** Reads the dependents before they are removed. When supplied, a removal that
   * rejects (it may still have committed) is restored from it immediately. It is also
   * what `restore` receives later when the removal returned nothing. */
  snapshot?: () => Promise<unknown>;
  /** Removes the dependents and returns whatever is needed to restore them. */
  remove: () => Promise<unknown>;
  /** Re-creates the removed dependents; omitted when the step cannot be undone. */
  restore?: (removed: unknown) => Promise<void>;
}

export interface CascadeOutcome {
  /** Names of the steps whose removal threw. */
  failed: string[];
  /** Each fulfilled step's `remove` result, by step name. */
  removed: Record<string, unknown>;
  /** Best-effort restore of every fulfilled step; failures are logged, never thrown. */
  compensate: () => Promise<void>;
}

/** Builds a typed step; `restore` receives the snapshot when one is given, else what `remove` returned. */
export function cascadeStep<T, S = T>(
  name: string,
  remove: () => Promise<T>,
  restore?: (restoreFrom: S) => Promise<void>,
  snapshot?: () => Promise<S>,
): CascadeStep {
  return {
    name,
    snapshot,
    remove,
    restore: restore ? (restoreFrom) => restore(restoreFrom as S) : undefined,
  };
}

/**
 * Runs the removals concurrently and reports which failed. When the caller cannot
 * finish the delete (a step failed, or the parent record could not be deleted), it
 * calls `compensate` so the dependents are put back instead of orphaning a parent
 * that still exists.
 */
export async function runCascade(steps: CascadeStep[], logPrefix: string): Promise<CascadeOutcome> {
  const restoreArgs: Record<string, unknown> = {};

  /** Steps whose immediate restore failed; `compensate` tries them again. */
  const unrestored: Array<{ step: CascadeStep; arg: unknown }> = [];

  async function restoreStep(step: CascadeStep, arg: unknown): Promise<boolean> {
    if (!step.restore) {
      return true;
    }
    try {
      await step.restore(arg);
      return true;
    } catch (error) {
      logger.error(
        `${logPrefix} cascade restore failed: ${step.name}`,
        getSafeErrorMetadata(error),
      );
      return false;
    }
  }

  async function run(step: CascadeStep): Promise<unknown> {
    const snapshot = step.snapshot ? await step.snapshot() : undefined;
    let value: unknown;
    try {
      value = await step.remove();
    } catch (error) {
      /** The removal may have committed before it rejected; put the snapshot back. */
      if (step.snapshot && !(await restoreStep(step, snapshot))) {
        unrestored.push({ step, arg: snapshot });
      }
      throw error;
    }
    /** What the removal actually returned beats the earlier snapshot, which may predate a
     * concurrent write; the snapshot covers steps that return nothing. */
    restoreArgs[step.name] = value !== undefined ? value : snapshot;
    return value;
  }

  const settled = await Promise.allSettled(steps.map(run));
  const failed: string[] = [];
  const removed: Record<string, unknown> = {};
  settled.forEach((result, index) => {
    const { name } = steps[index];
    if (result.status === 'rejected') {
      failed.push(name);
      logger.error(
        `${logPrefix} cascade step failed: ${name}`,
        getSafeErrorMetadata(result.reason),
      );
      return;
    }
    removed[name] = result.value;
  });

  async function compensate(): Promise<void> {
    for (const { step, arg } of unrestored) {
      await restoreStep(step, arg);
    }
    for (const step of steps) {
      if (step.name in removed) {
        await restoreStep(step, restoreArgs[step.name]);
      }
    }
  }

  return { failed, removed, compensate };
}
