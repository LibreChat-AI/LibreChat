import type { UpdateQuery, FilterQuery, QueryOptions } from 'mongoose';
import type {
  StoredResponseRecord,
  ResponseMutationResult,
  ResponseReservation,
} from '~/models/response';
import type { ResponseCanonicalTarget } from '~/types/managed';
import { isManagedConversationId, includeManagedAllocations } from '~/utils/managed';
import { MAX_BSON_DOCUMENT_BYTES, BSON_WRITE_HEADROOM_BYTES } from '~/utils/bson';
import { responseReceiptKey, responseTurnMessageIds } from '~/utils/receipt';
import { createStoredResponseModel } from '~/models/response';

// Payload leaves 64 KiB, as conversation imports do. An admitted saver may use
// that space to close, while leaving 8 KiB for the fixed failure envelope, bounded
// provider/receipt identities, cancellation and release. Variable saver settings
// and even the fallback's model/id strings are measured, never assumed to fit.
export const RESPONSE_DOCUMENT_BYTES: number = MAX_BSON_DOCUMENT_BYTES - BSON_WRITE_HEADROOM_BYTES;
type ResponseBudgetPhase = 'payload' | 'settlement' | 'unused' | 'failure';
const MAXIMUM_BYTES: Record<ResponseBudgetPhase, number> = {
  payload: RESPONSE_DOCUMENT_BYTES,
  settlement: MAX_BSON_DOCUMENT_BYTES - 8 * 1024,
  unused: MAX_BSON_DOCUMENT_BYTES - 8 * 1024,
  failure: MAX_BSON_DOCUMENT_BYTES,
};
export const RESPONSE_BUDGET_FIELDS: string =
  '+_managed +canonicalTargets +providerExecution +checkpoint';

/** Measure the persisted schema, retaining unknown stored fields and all private data. */
export function responseUpdateFits<Current extends Partial<StoredResponseRecord>>(
  mongoose: typeof import('mongoose'),
  current: Current,
  update: UpdateQuery<StoredResponseRecord>,
  phase: ResponseBudgetPhase = 'payload',
): boolean {
  if (Object.keys(update).some((key) => !['$set', '$unset', '$inc'].includes(key)))
    throw new TypeError('Response BSON preflight requires explicit field mutations');
  if (Object.keys(update.$inc ?? {}).some((key) => key !== 'revision'))
    throw new TypeError('Response BSON preflight cannot infer counter mutations');
  if (!('_managed' in current) || !current._managed)
    throw new TypeError('Response BSON preflight requires its complete physical snapshot');
  const model = createStoredResponseModel(mongoose);
  const document = new model(current);
  if (update.$set) document.set(update.$set);
  for (const field of Object.keys(update.$unset ?? {})) {
    if (field.includes('.'))
      throw new TypeError('Response BSON preflight requires whole-field removal');
    document.set(field, undefined);
  }
  document.set('createdAt', current.createdAt ?? new Date());
  document.set('updatedAt', new Date());
  document.set('revision', Number.MAX_SAFE_INTEGER);
  const next = document.toObject({
    depopulate: true,
    minimize: false,
    getters: false,
    virtuals: false,
    transform: false,
  });
  const candidate = { ...current, ...next };
  for (const field of Object.keys(update.$unset ?? {})) Reflect.deleteProperty(candidate, field);
  const maximum = MAXIMUM_BYTES[phase];
  // A closed unused request cannot acquire a provider or saver later. It may
  // consume control headroom after scrubbing the request, retaining room for release.
  if (
    phase === 'unused' &&
    (candidate.status !== 'cancelled' ||
      candidate.requestJSON !== '{}' ||
      candidate.generationCreatedAt != null ||
      candidate.providerExecution ||
      candidate.checkpoint ||
      candidate.preparedTerminal ||
      candidate.pendingTerminal ||
      candidate.review ||
      candidate.resume ||
      candidate.canonicalTargets?.length ||
      candidate.persistenceFailure ||
      candidate.retiredAt ||
      Object.keys(update.$set ?? {}).some(
        (key) => !['status', 'responseJSON', 'requestJSON'].includes(key),
      ))
  )
    throw new TypeError('Response unused budget requires a closed, unenrolled request');
  if (phase === 'failure') {
    if (
      !candidate.persistenceFailure ||
      candidate.status !== 'failed' ||
      candidate.requestJSON !== '{}' ||
      candidate.preparedTerminal ||
      candidate.pendingTerminal ||
      candidate.review ||
      candidate.resume
    )
      throw new TypeError('Response failure budget requires frozen, finalized private state');
    return mongoose.mongo.BSON.calculateObjectSize(candidate) <= maximum;
  }
  if (
    phase === 'settlement' &&
    (candidate.checkpoint?.state !== 'settled' ||
      Object.keys(update.$set ?? {}).some(
        (key) => key !== 'checkpoint' && !key.startsWith('checkpoint.'),
      ))
  )
    throw new TypeError('Response settlement budget cannot admit payload');
  if (mongoose.mongo.BSON.calculateObjectSize(candidate) > maximum) return false;
  const projecting =
    !candidate.persistenceFailure &&
    !candidate.retiredAt &&
    ['queued', 'in_progress', 'requires_action', 'materializing'].includes(candidate.status!);
  // Selections remain after their discovery slots settle. Reserve their entire
  // eventual BSON map at immutable receipt admission, including array-key overhead.
  const targets = new Map<string, ResponseCanonicalTarget>(
    candidate.canonicalTargets?.map((entry) => [
      entry.logicalId,
      projecting ? { ...entry, phase: 'registering' } : entry,
    ]),
  );
  if (
    projecting &&
    candidate.conversationId &&
    isManagedConversationId(candidate.conversationId) &&
    !candidate.conversationTarget
  ) {
    candidate.conversationTarget = {
      id: '0'.repeat(24),
      userId: candidate.userId!,
      conversationId: candidate.conversationId,
      ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
    };
    if (!targets.has(candidate.conversationId))
      targets.set(candidate.conversationId, {
        logicalId: candidate.conversationId,
        receipt: '0'.repeat(64),
        phase: 'registering',
        target: {
          kind: 'conversation',
          id: '0'.repeat(24),
          incarnation: '0'.repeat(36),
          ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
        },
      });
  }
  const receipt = candidate.pendingTerminal ?? candidate.preparedTerminal;
  if (projecting && receipt?.turnJSON) {
    const key = responseReceiptKey(receipt);
    for (const logicalId of responseTurnMessageIds(candidate.responseId!, receipt)) {
      if (targets.has(logicalId)) continue;
      targets.set(logicalId, {
        logicalId,
        receipt: key,
        phase: 'registering',
        target: {
          kind: 'message',
          id: '0'.repeat(24),
          incarnation: '0'.repeat(36),
          ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
        },
      });
    }
  }
  if (targets.size) candidate.canonicalTargets = [...targets.values()];
  if (mongoose.mongo.BSON.calculateObjectSize(candidate) > maximum) return false;
  // A terminal error must remain representable even for unusually large identity
  // strings. Its variable identity bytes are admitted here; the fixed envelope and
  // failure proof fit the reserved control margin. No rejected proposal is copied.
  const failure = {
    ...candidate,
    status: 'failed',
    requestJSON: '{}',
    responseJSON: JSON.stringify({ id: candidate.responseId, model: candidate.agentId }),
  };
  for (const field of [
    'preparedTerminal',
    'pendingTerminal',
    'terminalReceiptKey',
    'review',
    'resume',
  ])
    Reflect.deleteProperty(failure, field);
  return mongoose.mongo.BSON.calculateObjectSize(failure) <= maximum;
}

/** Every unbounded growth writer checks the same complete snapshot it fences by revision. */
export async function updateResponseDocument(
  mongoose: typeof import('mongoose'),
  filter: FilterQuery<StoredResponseRecord>,
  update: UpdateQuery<StoredResponseRecord>,
  options: QueryOptions<StoredResponseRecord> = {},
  snapshot?: StoredResponseRecord,
  phase: 'payload' | 'settlement' | 'unused' = 'payload',
): Promise<ResponseMutationResult> {
  const model = createStoredResponseModel(mongoose);
  // Retry only a known CAS miss, once, with a new full size check. A caller-owned
  // revision/snapshot retains its conflict semantics; uncertain driver errors escape.
  for (let attempt = 0; attempt < 2; attempt++) {
    const current =
      snapshot ??
      (await includeManagedAllocations(
        model.findOne(filter).select(RESPONSE_BUDGET_FIELDS).read('primary').lean(),
      ));
    if (!current) return { ok: false, code: 'response_conflict' };
    if (!responseUpdateFits(mongoose, current, update, phase))
      return { ok: false, code: 'document_limit' };
    const record = await includeManagedAllocations(
      model.findOneAndUpdate(
        { ...filter, revision: current.revision },
        { ...update, $inc: { ...update.$inc, revision: 1 } },
        { ...options, new: true, upsert: false },
      ),
    ).lean();
    if (record) return { ok: true, record };
    if (snapshot || filter.revision != null) break;
  }
  return { ok: false, code: 'response_conflict' };
}

/** Reject before allocation, including the Root's eventual discovery metadata. */
export function responseReservationFits(
  mongoose: typeof import('mongoose'),
  input: ResponseReservation,
): boolean {
  const { dispatch, ...reservation } = input;
  return responseUpdateFits(
    mongoose,
    {
      ...reservation,
      status: 'queued',
      revision: 0,
      storageTarget: {
        kind: 'response',
        id: '0'.repeat(24),
        incarnation: '0'.repeat(36),
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      },
      _managed: {
        phase: 'published',
        incarnation: '0'.repeat(36),
        parentId: '0'.repeat(24),
        ownerKey: '0'.repeat(64),
        conversationKey: '0'.repeat(64),
        receipt: '0'.repeat(64),
        logicalId: input.responseId,
      },
      ...(dispatch
        ? { dispatchOutbox: { kind: 'create', id: input.responseId, state: 'pending' } }
        : {}),
    },
    {},
  );
}
