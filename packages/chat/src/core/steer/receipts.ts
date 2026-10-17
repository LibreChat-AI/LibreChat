import type {
  TMessage,
  TAgentQueuedTurnReceipt,
  TAgentQueuedTurnFileRef,
} from 'librechat-data-provider';
import type { QueuedMessage, SettledQueuedTurnReceipt } from './types';
import { hydrateFileDeliveryMetadata } from '../files';

type AgentQueuedTurnReceipt = TAgentQueuedTurnReceipt;

function compareQueuedMessages(a: QueuedMessage, b: QueuedMessage): number {
  const priority = Number(b.priority ?? false) - Number(a.priority ?? false);
  if (priority !== 0) {
    return priority;
  }
  const aServerOrder = a.server?.revision;
  const bServerOrder = b.server?.revision;
  if (aServerOrder != null && bServerOrder != null && aServerOrder !== bServerOrder) {
    return aServerOrder - bServerOrder;
  }
  if (a.server != null && b.server == null) {
    return -1;
  }
  if (a.server == null && b.server != null) {
    return 1;
  }
  return a.createdAt - b.createdAt;
}

function queuedTurnCreatedAt(receipt: AgentQueuedTurnReceipt): number {
  const createdAt = Date.parse(receipt.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

export type QueuedTurnReceiptSource = 'snapshot' | 'enqueue' | 'direct';

function isAdmissionIndeterminateReceipt(receipt: AgentQueuedTurnReceipt): boolean {
  return (
    receipt.failure?.code === 'ADMISSION_INDETERMINATE' &&
    (receipt.status === 'claimed' || receipt.status === 'dead')
  );
}

function settledEvidenceForReceipt(
  receipt: AgentQueuedTurnReceipt,
): SettledQueuedTurnReceipt | undefined {
  if (
    receipt.status === 'admitted' &&
    (receipt.effectivePredecessorCreatedAt != null || receipt.rootPredecessor === true)
  ) {
    return {
      clientRequestId: receipt.clientRequestId,
      status: 'admitted',
      ...(receipt.effectivePredecessorCreatedAt != null && {
        effectivePredecessorCreatedAt: receipt.effectivePredecessorCreatedAt,
      }),
      ...(receipt.rootPredecessor === true && { rootPredecessor: true }),
    };
  }
  if (receipt.status === 'admitted') {
    return {
      clientRequestId: receipt.clientRequestId,
      status: 'admitted_pending_boundary',
    };
  }
  if (isAdmissionIndeterminateReceipt(receipt)) {
    return { clientRequestId: receipt.clientRequestId, status: 'indeterminate' };
  }
  if (receipt.status === 'cancelled') {
    return { clientRequestId: receipt.clientRequestId, status: 'cancelled' };
  }
  if (receipt.status === 'dead') {
    return { clientRequestId: receipt.clientRequestId, status: 'dead' };
  }
  return undefined;
}

/** Client receipt knowledge is a monotonic evidence lattice. Enqueue is the
 * only source that can carry a pre-scheduling snapshot, so it never weakens
 * evidence already observed by GET/direct settlement. Indeterminate evidence
 * can advance only through a later authoritative terminal observation. */
export function mergeSettledQueuedTurnEvidence(
  existing: SettledQueuedTurnReceipt | undefined,
  receipt: AgentQueuedTurnReceipt,
  source: QueuedTurnReceiptSource,
): SettledQueuedTurnReceipt | undefined {
  const incoming = settledEvidenceForReceipt(receipt);
  if (existing == null) {
    return incoming;
  }
  if (existing.status === 'admitted_pending_boundary' && incoming?.status === 'admitted') {
    return incoming;
  }
  if (
    existing.status === 'indeterminate' &&
    source !== 'enqueue' &&
    incoming != null &&
    incoming.status !== 'indeterminate'
  ) {
    return incoming;
  }
  return existing;
}

export function toQueuedTurnFileRefs(
  files: TMessage['files'],
): TAgentQueuedTurnFileRef[] | undefined {
  const refs = (files ?? []).flatMap((file): TAgentQueuedTurnFileRef[] => {
    if (typeof file.file_id !== 'string' || file.file_id.length === 0) {
      return [];
    }
    return [
      {
        file_id: file.file_id,
        ...(file.type != null && { type: file.type }),
        ...(file.filepath != null && { filepath: file.filepath }),
        ...(file.filename != null && { filename: file.filename }),
        ...(file.llmDeliveryPath != null && { llmDeliveryPath: file.llmDeliveryPath }),
        ...(file.height != null && { height: file.height }),
        ...(file.width != null && { width: file.width }),
        ...(file.bytes != null && { bytes: file.bytes }),
      },
    ];
  });
  return refs.length > 0 ? refs : undefined;
}

export function reconcileServerQueuedTurns(
  previous: QueuedMessage[],
  receipts: AgentQueuedTurnReceipt[],
  settledByRequestId: ReadonlyMap<string, SettledQueuedTurnReceipt>,
  authoritativeSnapshot = true,
  storedFiles?: Parameters<typeof hydrateFileDeliveryMetadata>[2],
): QueuedMessage[] {
  const previousByClientRequestId = new Map(
    previous.flatMap((item) =>
      item.clientRequestId != null ? [[item.clientRequestId, item] as const] : [],
    ),
  );
  const observedClientRequestIds = new Set(receipts.map((receipt) => receipt.clientRequestId));
  const projected = receipts.flatMap((receipt): QueuedMessage[] => {
    const settled = settledByRequestId.get(receipt.clientRequestId);
    const admissionIndeterminate = isAdmissionIndeterminateReceipt(receipt);
    if (settled?.status === 'admitted' || settled?.status === 'cancelled') {
      return [];
    }
    const optimistic = previousByClientRequestId.get(receipt.clientRequestId);
    if (
      (settled?.status === 'dead' ||
        settled?.status === 'admitted_pending_boundary' ||
        (settled?.status === 'indeterminate' && !admissionIndeterminate)) &&
      receipt.status !== 'dead' &&
      receipt.status !== 'admitted'
    ) {
      return optimistic == null ? [] : [optimistic];
    }
    const boundaryPending = receipt.status === 'admitted';
    let status: NonNullable<QueuedMessage['server']>['status'] = 'rejected';
    if (admissionIndeterminate) {
      status = 'indeterminate';
    } else if (boundaryPending) {
      status = 'uncertain';
    } else if (receipt.status === 'queued' || receipt.status === 'claimed') {
      status = receipt.status;
    }
    const files = hydrateFileDeliveryMetadata(receipt.files, optimistic?.files, storedFiles);
    return [
      {
        id: optimistic?.id ?? receipt.clientRequestId,
        text: receipt.text,
        createdAt: queuedTurnCreatedAt(receipt),
        clientRequestId: receipt.clientRequestId,
        parentMessageId: receipt.parentMessageId,
        ...(receipt.expectedPredecessorCreatedAt != null && {
          expectedPredecessorCreatedAt: receipt.expectedPredecessorCreatedAt,
        }),
        ...(files != null && files.length > 0 && { files }),
        ...(receipt.quotes != null && receipt.quotes.length > 0 && { quotes: receipt.quotes }),
        ...(receipt.manualSkills != null &&
          receipt.manualSkills.length > 0 && {
            manualSkills: receipt.manualSkills,
          }),
        ...(receipt.reasoningOverride != null && {
          reasoningOverride: receipt.reasoningOverride,
        }),
        ...(receipt.priority === true && { priority: true }),
        server: {
          id: receipt.queuedTurnId,
          status,
          revision: receipt.revision,
          ...(boundaryPending && {
            uncertainSince: optimistic?.server?.uncertainSince ?? Date.now(),
          }),
          ...(receipt.position != null && { position: receipt.position }),
          ...(receipt.failure?.code != null && { errorCode: receipt.failure.code }),
          ...(receipt.failure?.message != null && { errorMessage: receipt.failure.message }),
        },
      },
    ];
  });
  const retained = previous.filter((item) => {
    if (item.server == null) {
      return true;
    }
    const settled =
      item.clientRequestId == null ? undefined : settledByRequestId.get(item.clientRequestId);
    if (settled?.status === 'admitted' || settled?.status === 'cancelled') {
      return false;
    }
    if (settled?.status === 'dead' || settled?.status === 'admitted_pending_boundary') {
      return item.clientRequestId == null || !observedClientRequestIds.has(item.clientRequestId);
    }
    if (item.clientRequestId == null || observedClientRequestIds.has(item.clientRequestId)) {
      return false;
    }
    if (!authoritativeSnapshot) {
      return true;
    }
    return (
      item.server.status === 'sending' ||
      item.server.status === 'uncertain' ||
      item.server.status === 'indeterminate' ||
      item.server.status === 'rejected'
    );
  });
  return [...retained, ...projected].sort(compareQueuedMessages);
}
