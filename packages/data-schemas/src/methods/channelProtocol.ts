import { createHash } from 'node:crypto';
import type {
  ChannelRunAdmission,
  ChannelRunPrincipal,
  ChannelRunSnapshot,
  ChannelDeliveryPlan,
  ChannelDeliveryReceipt,
} from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';

export interface ChannelLaneScope {
  tenantId: string;
  channelId: string;
  agentId: string;
  principal: ChannelRunPrincipal;
  admission: Pick<ChannelRunAdmission, 'actor' | 'externalChannelId' | 'externalThreadKey'>;
}

export interface ChannelRunEnrollment extends ChannelLaneScope {
  admission: ChannelRunAdmission;
}

export class ChannelRunConflict extends Error {
  constructor(
    readonly code: 'event_conflict' | 'stale_fence' | 'invalid_transition' | 'delivery_incomplete',
  ) {
    super(code);
    this.name = 'ChannelRunConflict';
  }
}

export const digest = (value: object): string =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item: unknown) =>
        item != null && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => {
                if (a === b) return 0;
                return a < b ? -1 : 1;
              }),
            )
          : item,
      ),
    )
    .digest('hex');
export function laneKey(scope: ChannelLaneScope): string {
  return digest({
    tenantId: scope.tenantId,
    channelId: scope.channelId,
    agentId: scope.agentId,
    thread: scope.admission.externalThreadKey,
    externalChannelId: scope.admission.externalChannelId,
    actor: scope.admission.actor,
    userId: scope.principal.userId,
    revision: scope.principal.channelRevision,
    linkRevision: scope.principal.linkRevision ?? null,
    linkId: scope.principal.linkId ?? null,
  });
}
export const activeStates: string[] = [
  'queued',
  'executing',
  'requires_action',
  'delivering',
  'blocked',
];

/** A projection cannot grant a different response authority to the next actor-lane turn. */
export function assertSnapshotBinding(run: ChannelRunRecord, snapshot: ChannelRunSnapshot): void {
  if (
    (snapshot.status === 'completed' && !snapshot.responseId) ||
    (snapshot.responseId != null && snapshot.responseId !== run.execution?.responseId)
  )
    throw new ChannelRunConflict('invalid_transition');
}

/** Confirm the provider identity appropriate to the immutable plan, on every confirmation path. */
export function assertDeliveryEvidence(
  run: ChannelRunRecord,
  receipt: ChannelDeliveryReceipt,
  previous: ChannelDeliveryReceipt | undefined,
): void {
  const part = run.plan?.parts.find((item) => item.operationId === receipt.operationId);
  if (
    !part ||
    (part.kind === 'artifact' &&
      (!part.artifactId ||
        !run.snapshot?.artifacts?.some((artifact) => artifact.artifactId === part.artifactId))) ||
    !previous ||
    (previous.externalMessageKey != null &&
      receipt.externalMessageKey != null &&
      previous.externalMessageKey !== receipt.externalMessageKey) ||
    (previous.externalFileId != null &&
      receipt.externalFileId != null &&
      previous.externalFileId !== receipt.externalFileId) ||
    (receipt.upload != null && digest(receipt.upload) !== digest(previous.upload ?? {})) ||
    (receipt.externalFileId != null &&
      previous.upload != null &&
      previous.upload.fileId !== receipt.externalFileId) ||
    (receipt.outcome === 'confirmed' &&
      ((part.kind === 'message' && !receipt.externalMessageKey) ||
        (part.kind === 'artifact' &&
          (!receipt.externalFileId ||
            (previous.upload != null && previous.upload.fileId !== receipt.externalFileId)))))
  )
    throw new ChannelRunConflict('invalid_transition');
}

export function leaseDeadline(now: number, leaseMs: number): number {
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isSafeInteger(now + leaseMs)
  )
    throw new Error('Invalid channel lease');
  return now + leaseMs;
}

/** Evidence is verified by the transport; storage binds it to the exact uncertain attempt. */
export function assertReconciliation(
  previous: Omit<ChannelDeliveryReceipt, 'operationId'> | undefined,
  receipt: Pick<ChannelDeliveryReceipt, 'attempts' | 'externalMessageKey' | 'externalFileId'>,
): void {
  if (
    !previous ||
    !['unknown', 'confirmed'].includes(previous.outcome) ||
    previous.attempts !== receipt.attempts ||
    (!receipt.externalMessageKey && !receipt.externalFileId) ||
    (previous.externalMessageKey && previous.externalMessageKey !== receipt.externalMessageKey) ||
    (previous.externalFileId && previous.externalFileId !== receipt.externalFileId) ||
    (previous.upload && previous.upload.fileId !== receipt.externalFileId) ||
    (previous.outcome === 'confirmed' &&
      (previous.externalMessageKey !== receipt.externalMessageKey ||
        previous.externalFileId !== receipt.externalFileId))
  )
    throw new ChannelRunConflict('invalid_transition');
}

const terminalSnapshots = ['completed', 'failed', 'cancelled'];

export function snapshotPatch(
  run: ChannelRunRecord,
  snapshot: ChannelRunSnapshot,
): Pick<ChannelRunRecord, 'state' | 'snapshot'> {
  assertSnapshotBinding(run, snapshot);
  if (
    run.snapshot &&
    terminalSnapshots.includes(run.snapshot.status) &&
    (run.snapshot.status !== snapshot.status ||
      run.snapshot.responseId !== snapshot.responseId ||
      run.snapshot.text !== snapshot.text)
  )
    throw new ChannelRunConflict('invalid_transition');
  if (run.state === 'delivering' && !terminalSnapshots.includes(snapshot.status))
    throw new ChannelRunConflict('invalid_transition');
  let state: ChannelRunRecord['state'] = 'delivering';
  if (snapshot.status === 'running') state = 'executing';
  else if (snapshot.status === 'requires_action') state = 'requires_action';
  const patch: Pick<ChannelRunRecord, 'state' | 'snapshot'> = {
    state,
    snapshot:
      snapshot.summary == null && run.snapshot?.summary
        ? { ...snapshot, summary: run.snapshot.summary }
        : snapshot,
  };
  if (run.plan && digest(patch.snapshot ?? {}) !== digest(run.snapshot ?? {}))
    throw new ChannelRunConflict('invalid_transition');
  return patch;
}

export function assertPlan(
  run: ChannelRunRecord,
  plan: ChannelDeliveryPlan,
  maxParts: number,
): void {
  if (
    !run.snapshot ||
    !terminalSnapshots.includes(run.snapshot.status) ||
    run.state !== 'delivering' ||
    !plan.parts.length ||
    plan.parts.length > maxParts ||
    new Set(plan.parts.map((part) => part.operationId)).size !== plan.parts.length ||
    !plan.parts.some((part) => part.required) ||
    plan.parts.some(
      (part) =>
        !part.operationId ||
        !['message', 'artifact'].includes(part.kind) ||
        (part.kind === 'artifact' &&
          (!part.artifactId ||
            !run.snapshot?.artifacts?.some((artifact) => artifact.artifactId === part.artifactId))),
    )
  )
    throw new ChannelRunConflict('invalid_transition');
  assertSnapshotBinding(run, run.snapshot);
}

export function hasPermanentDeliveryFailure(run: ChannelRunRecord): boolean {
  return (
    run.plan?.parts.some(
      (part) =>
        part.required &&
        run.receipts.some(
          (receipt) =>
            receipt.operationId === part.operationId && receipt.outcome === 'permanent_failure',
        ),
    ) ?? false
  );
}

/** A permanent required failure is terminal even though successful delivery is impossible.
 * Unknown receipts never become eligible for resend. Optional unknown effects remain best effort. */
export function deliveryDisposition(
  run: ChannelRunRecord,
  maxParts: number,
): 'delivered' | 'failed' | 'cancelled' {
  if (!run.plan || !run.snapshot) throw new ChannelRunConflict('delivery_incomplete');
  assertPlan(run, run.plan, maxParts);
  if (
    run.receipts.length !== run.plan.parts.length ||
    new Set(run.receipts.map((receipt) => receipt.operationId)).size !== run.receipts.length
  )
    throw new ChannelRunConflict('invalid_transition');
  for (const receipt of run.receipts) assertDeliveryEvidence(run, receipt, receipt);
  if (
    run.receipts.some((receipt) => receipt.outcome === 'inflight') ||
    run.progress?.outcome === 'inflight'
  )
    throw new ChannelRunConflict('delivery_incomplete');
  const required = run.plan.parts
    .filter((part) => part.required)
    .map((part) => run.receipts.find((receipt) => receipt.operationId === part.operationId));
  if (hasPermanentDeliveryFailure(run)) return 'failed';
  if (required.some((receipt) => receipt?.outcome !== 'confirmed'))
    throw new ChannelRunConflict('delivery_incomplete');
  if (run.snapshot.status === 'completed') return 'delivered';
  if (run.snapshot.status === 'cancelled') return 'cancelled';
  return 'failed';
}
