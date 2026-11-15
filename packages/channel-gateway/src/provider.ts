import type {
  ChannelArtifact,
  ChannelDeliveryPart,
  ChannelDeliveryPlan,
  ChannelDeliveryReceipt,
  ChannelRunView,
} from 'librechat-data-provider';
import type { ChannelBundle } from './types';

export type ProviderWriteFailure = {
  outcome: 'permanent' | 'retryable' | 'unknown';
  retryAfterMs?: number;
};
type ProviderFailureReceipt = Pick<ChannelDeliveryReceipt, 'attempts' | 'retryAt'> & {
  outcome: 'unknown' | 'retryable' | 'permanent_failure';
  errorCode: string;
};
export type ProviderWriteReceipt = { externalMessageKey: string };
export type ProviderArtifactResult =
  | { outcome: 'confirmed'; externalFileId: string; externalMessageKey?: string }
  | { outcome: 'unknown' | 'retryable' | 'permanent_failure'; errorCode: string; retryAt?: number };
export interface ProviderArtifactRequest {
  run: ChannelRunView;
  part: ChannelDeliveryPart;
  artifact: ChannelArtifact;
  bytes: Buffer;
  bundle: ChannelBundle;
  attempts: number;
  signal: AbortSignal;
  check: () => void;
  /** Persistence failures propagate; no further transport effect may follow a failed checkpoint. */
  checkpoint: (upload: NonNullable<ChannelDeliveryReceipt['upload']>) => Promise<void>;
}

/** Platform effects only. Leases, execution, plans and receipts remain owned by ChannelWorker. */
export interface WorkerProvider {
  progressRenderer: string;
  maxProgressLength: number;
  validateAddress(run: ChannelRunView): void;
  assertBinding(run: ChannelRunView, bundle: ChannelBundle): void;
  progressText(run: ChannelRunView): string;
  makePlan(run: ChannelRunView, bundle: ChannelBundle): ChannelDeliveryPlan;
  supportsRenderer(version: string): boolean;
  /** Validate persisted presentation before delivery/begin, then write only after it is durable. */
  preparePart(
    part: ChannelDeliveryPart,
    renderer: string,
    bundle: ChannelBundle,
  ): (run: ChannelRunView, signal: AbortSignal) => Promise<ProviderWriteReceipt>;
  writeProgress(
    run: ChannelRunView,
    bundle: ChannelBundle,
    signal: AbortSignal,
  ): Promise<ProviderWriteReceipt>;
  deleteProgress(run: ChannelRunView, bundle: ChannelBundle, signal: AbortSignal): Promise<void>;
  deliverArtifact(request: ProviderArtifactRequest): Promise<ProviderArtifactResult>;
  classifyError(error: unknown): ProviderWriteFailure;
  recoveryEvent(error: unknown): string | undefined;
  setSessionStatus?(
    run: ChannelRunView,
    bundle: ChannelBundle,
    status: 'active' | 'suspended' | 'processing',
    signal: AbortSignal,
  ): Promise<void>;
  lifecycle?(
    run: ChannelRunView,
    bundle: ChannelBundle,
    phase: 'started' | 'completed' | 'failed',
    signal: AbortSignal,
  ): Promise<void>;
}

export function terminalSnapshot(run: ChannelRunView): boolean {
  return !!run.snapshot && ['completed', 'failed', 'cancelled'].includes(run.snapshot.status);
}

export function pendingReview(run: ChannelRunView): boolean {
  const pending = run.snapshot?.pendingAction;
  return (
    !run.snapshot?.recovery &&
    run.snapshot?.status === 'requires_action' &&
    !!pending?.actionId &&
    pending.expiresAt > Date.now() &&
    ['tool_approval', 'ask_user_question', 'oauth'].includes(pending.kind)
  );
}

export function failedWrite(
  failure: ProviderWriteFailure,
  attempts: number,
): ProviderFailureReceipt {
  if (failure.outcome === 'permanent')
    return { attempts, outcome: 'permanent_failure', errorCode: 'transport_rejected' };
  if (failure.outcome === 'retryable')
    return {
      attempts,
      outcome: 'retryable',
      errorCode: 'transport_retryable',
      retryAt: Date.now() + Math.max(1000, failure.retryAfterMs ?? 0),
    };
  return { attempts, outcome: 'unknown', errorCode: 'transport_uncertain' };
}
