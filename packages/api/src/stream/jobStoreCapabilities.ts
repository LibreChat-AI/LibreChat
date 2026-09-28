import type { IJobStore, IJobStoreV2 } from './interfaces/IJobStore';

/**
 * Methods added by the v2 generation-store contract.
 *
 * Keep this list in lockstep with {@link IJobStoreV2}: it is the runtime
 * boundary that lets the public {@link IJobStore} type remain source-compatible
 * while rejecting an implementation that cannot provide the atomic guarantees
 * required by the current generation manager.
 */
export const JOB_STORE_V2_REQUIRED_METHODS = [
  'acknowledgeReplacedJobs',
  'markProviderExecutionDrained',
  'beginProviderExecution',
  'getCleanupBlockingJobIdsByUser',
  'finalizeTerminalPersistence',
  'transitionStatusAndDrainSteers',
  'takeoverIdempotencyKey',
  'markIdempotencyKeyStarted',
  'adoptIdempotencyKeyForJob',
  'enqueueSteerVersioned',
  'enqueueSteerWithReceipt',
  'getSteerReceipt',
  'restoreClaimedSteers',
  'admitTerminalSteers',
  'peekClaimedSteers',
  'armSteer',
  'armSteerVersioned',
  'downgradeSteerPreempts',
  'claimParkedSteersDetailed',
  'consumeParkedSteer',
  'discardSteerLeftover',
  'settleEarlyBufferRecovery',
  'finalizeEarlyBufferOverflow',
  'hasSubscriberAttached',
  'claimFirstSubscriber',
  'detachSubscriber',
  'hasActiveSubscriber',
] as const satisfies ReadonlyArray<keyof IJobStoreV2>;

export type JobStoreV2RequiredMethod = (typeof JOB_STORE_V2_REQUIRED_METHODS)[number];

type MethodKeys<T> = {
  [Key in keyof T]-?: NonNullable<T[Key]> extends (...args: never[]) => unknown ? Key : never;
}[keyof T];
type V2OnlyMethod = Exclude<MethodKeys<IJobStoreV2>, keyof IJobStore>;
type SameUnion<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertTrue<Value extends true> = Value;
/** Compile-time tripwire: adding a v2-only method requires updating the runtime assertion. */
type _AllV2MethodsHaveRuntimeChecks = AssertTrue<SameUnion<V2OnlyMethod, JobStoreV2RequiredMethod>>;

/** Return the v2 capabilities absent from a legacy-compatible store. */
export function getMissingJobStoreV2Methods(store: IJobStore): JobStoreV2RequiredMethod[] {
  const candidate = store as unknown as Record<string, unknown>;
  return JOB_STORE_V2_REQUIRED_METHODS.filter((method) => typeof candidate[method] !== 'function');
}

/**
 * Narrow a public/legacy store to the contract the current runtime requires.
 * Throws before the manager mutates any configuration when capabilities are
 * missing, so a custom-store upgrade fails loudly and deterministically.
 */
export function assertJobStoreV2(store: IJobStore): asserts store is IJobStoreV2 {
  const missing = getMissingJobStoreV2Methods(store);
  if (missing.length === 0) {
    return;
  }

  throw new TypeError(
    `Invalid generation job store: missing required IJobStoreV2 method(s): ${missing.join(', ')}`,
  );
}
