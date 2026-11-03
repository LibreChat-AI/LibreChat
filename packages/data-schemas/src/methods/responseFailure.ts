import { isDeepStrictEqual } from 'node:util';
import type {
  ResponsePersistenceFailure,
  StoredResponseRecord,
  ResponseMutationResult,
} from '~/models/response';
import type { ResponseCanonicalTarget, ManagedPublication } from '~/types/managed';
import {
  managedTargetFilter,
  managedPublicationFilter,
  managedTargetModels,
  retireManagedAllocation,
} from './managed';
import { assertResponseExecutionBinding, responseReceiptKey } from '~/utils/receipt';
import { responseScopeKeys, isResponseScopeClosed } from './responseScope';
import { responseRootFilter, responseReference } from './responseRoot';
import { createStoredResponseModel } from '~/models/response';
import { includeManagedAllocations } from '~/utils/managed';
import { activeExpirationFilter } from '~/utils/retention';
import { reconcileResponseTargets } from './registration';

/** Completion failure preserves confirmed history; account/Conversation erasure does not. */
export function createResponseFailureStorage(mongoose: typeof import('mongoose')) {
  const roots = createStoredResponseModel(mongoose);
  const available = {
    '_managed.phase': 'published',
    retiredAt: { $exists: false },
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  };
  const read = (record: StoredResponseRecord) =>
    roots
      .findOne({ ...responseRootFilter(mongoose, responseReference(record)), ...available })
      .select('+canonicalTargets +providerExecution +checkpoint')
      .lean();

  async function seal(
    record: StoredResponseRecord,
    selection: ResponseCanonicalTarget,
  ): Promise<'published' | 'retired' | null> {
    const target = selection.target;
    // This placeholder CAS is the fence against an already admitted canonical writer.
    // A writer that wins first is confirmed history, even if its journal ACK was lost.
    await retireManagedAllocation(mongoose, target, record.storageTarget!.id);
    const model = mongoose.model(managedTargetModels[target.kind]);
    const [ownerKey, conversationKey] = responseScopeKeys(record, record.conversationId);
    const publication: ManagedPublication = {
      target,
      parentId: record.storageTarget!.id,
      logicalId: selection.logicalId,
      receipt: selection.receipt,
      ownerKey,
      conversationKey,
    };
    if (
      await includeManagedAllocations(
        model.exists({
          ...managedPublicationFilter(mongoose, publication),
          '_managed.phase': 'published',
        }),
      ).read('primary')
    )
      return 'published';
    return (await includeManagedAllocations(
      model.exists(managedTargetFilter(mongoose, target)),
    ).read('primary'))
      ? null
      : 'retired';
  }

  return {
    async recordPersistenceFailure(
      record: StoredResponseRecord,
      failure: ResponsePersistenceFailure,
    ): Promise<ResponseMutationResult> {
      assertResponseExecutionBinding(failure);
      if (
        !['target_retired', 'document_limit'].includes(failure.code) ||
        (failure.receiptKey != null && !/^[a-f\d]{64}$/.test(failure.receiptKey))
      )
        throw new TypeError('Invalid Response persistence failure');
      const current = await read(record);
      if (!current || (await isResponseScopeClosed(mongoose, current, current.conversationId)))
        return { ok: false, code: 'response_conflict' };
      if (current.persistenceFailure)
        return isDeepStrictEqual(current.persistenceFailure, failure)
          ? { ok: true, record: current }
          : { ok: false, code: 'response_conflict' };
      const receipt = current.pendingTerminal ?? current.preparedTerminal;
      if (
        !['queued', 'in_progress', 'requires_action', 'materializing'].includes(current.status) ||
        current.generationCreatedAt !== failure.generationCreatedAt ||
        current.providerExecution?.id !== failure.providerExecutionId ||
        current.providerExecution.ownerId !== failure.ownerId ||
        (receipt && responseReceiptKey(receipt) !== failure.receiptKey)
      )
        return { ok: false, code: 'response_conflict' };
      const saved = await roots
        .findOneAndUpdate(
          {
            ...responseRootFilter(mongoose, responseReference(current)),
            ...available,
            revision: current.revision,
            persistenceFailure: { $exists: false },
            generationCreatedAt: failure.generationCreatedAt,
            'providerExecution.id': failure.providerExecutionId,
            'providerExecution.ownerId': failure.ownerId ?? { $exists: false },
          },
          { $set: { persistenceFailure: failure, status: 'materializing' }, $inc: { revision: 1 } },
          { new: true, upsert: false, runValidators: true },
        )
        .lean();
      if (!saved || (await isResponseScopeClosed(mongoose, saved, saved.conversationId)))
        return { ok: false, code: 'response_conflict' };
      return { ok: true, record: saved };
    },
    async finishPersistenceFailure(
      record: StoredResponseRecord,
      responseJSON: string,
    ): Promise<ResponseMutationResult> {
      const response: unknown = JSON.parse(responseJSON);
      if (
        typeof response !== 'object' ||
        response === null ||
        !('id' in response) ||
        response.id !== record.responseId ||
        !('model' in response) ||
        response.model !== record.agentId ||
        !('object' in response) ||
        response.object !== 'response' ||
        !('status' in response) ||
        response.status !== 'failed' ||
        !('background' in response) ||
        response.background !== true ||
        !('store' in response) ||
        response.store !== true ||
        !('output' in response) ||
        !Array.isArray(response.output) ||
        response.output.length !== 0 ||
        // Control-only fallback fits inside the reserved BSON cleanup headroom.
        Buffer.byteLength(responseJSON, 'utf8') > 64 * 1024
      )
        throw new TypeError('Invalid bounded Response persistence failure result');
      const current = await read(record);
      const failure = current?.persistenceFailure;
      if (
        !current ||
        !failure ||
        !isDeepStrictEqual(failure, record.persistenceFailure) ||
        (await isResponseScopeClosed(mongoose, current, current.conversationId))
      )
        return { ok: false, code: 'response_conflict' };
      if (current.status === 'failed' && !current.preparedTerminal && !current.pendingTerminal)
        return { ok: true, record: current };
      if (
        current.status !== 'materializing' ||
        current.generationCreatedAt !== failure.generationCreatedAt ||
        current.providerExecution?.id !== failure.providerExecutionId ||
        current.providerExecution.ownerId !== failure.ownerId ||
        current.providerExecution.drained !== true ||
        !current.providerExecution.outcome ||
        (current.checkpoint &&
          (current.checkpoint.state !== 'settled' || current.checkpoint.erased !== true))
      )
        return { ok: false, code: 'response_conflict' };
      for (const selection of current.canonicalTargets ?? []) {
        const phase = await seal(current, selection);
        if (!phase) return { ok: false, code: 'response_conflict' };
        if (phase === selection.phase) continue;
        const updated = await roots.updateOne(
          {
            ...responseRootFilter(mongoose, responseReference(current)),
            ...available,
            persistenceFailure: failure,
            canonicalTargets: {
              $elemMatch: {
                logicalId: selection.logicalId,
                receipt: selection.receipt,
                'target.id': selection.target.id,
                'target.incarnation': selection.target.incarnation,
              },
            },
          },
          { $set: { 'canonicalTargets.$.phase': phase }, $inc: { revision: 1 } },
        );
        if (updated.matchedCount !== 1) return { ok: false, code: 'response_conflict' };
      }
      for (const conversationId of [undefined, current.conversationId])
        await reconcileResponseTargets(mongoose, current, conversationId);
      const latest = await read(current);
      if (!latest || (await isResponseScopeClosed(mongoose, latest, latest.conversationId)))
        return { ok: false, code: 'response_conflict' };
      const saved = await roots
        .findOneAndUpdate(
          {
            ...responseRootFilter(mongoose, responseReference(latest)),
            ...available,
            revision: latest.revision,
            persistenceFailure: failure,
            status: 'materializing',
          },
          {
            $set: { status: 'failed', responseJSON },
            $unset: { preparedTerminal: 1, pendingTerminal: 1, review: 1, resume: 1 },
            $inc: { revision: 1 },
          },
          { new: true, upsert: false },
        )
        .lean();
      return saved && !(await isResponseScopeClosed(mongoose, saved, saved.conversationId))
        ? { ok: true, record: saved }
        : { ok: false, code: 'response_conflict' };
    },
  };
}
