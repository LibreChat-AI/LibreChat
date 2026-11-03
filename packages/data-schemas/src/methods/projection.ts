import { createHash } from 'node:crypto';
import type { FilterQuery, Types } from 'mongoose';
import type {
  ResponseExecutionBinding,
  ResponseOwner,
  ResponseTerminalReceipt,
  StoredResponseRecord,
} from '~/models/response';
import type { ManagedPublication, ResponseCanonicalTarget } from '~/types/managed';
import type { ManagedAllocationPage } from './managed';
import type { ManagedTarget } from '~/types/managed';
import {
  allocateManagedTarget,
  discardManagedAllocation,
  assertManagedTenant,
  managedTargetFilter,
  managedPublicationFilter,
  pinManagedTarget,
  beginManagedTargetRegistration,
  retireManagedAllocation,
  listManagedAllocations,
  markManagedTargetRegistered,
} from './managed';
import {
  responseReceiptKey,
  terminalFilter,
  sameResponseTerminalReceipt,
  responseProviderFilter,
} from '~/utils/receipt';
import { includeManagedAllocations, isManagedConversationId } from '~/utils/managed';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { shortenExpiration, activeExpirationFilter } from '~/utils/retention';
import { responseOwnerFilter, responseScopeKeys } from './responseScope';
import { createStoredResponseModel } from '~/models/response';

interface ResponseTargetOwner extends ResponseOwner {
  parentId: string;
  responseId: string;
  fingerprint: string;
  conversationId: string;
  logicalId: string;
}

export type ResponseTargetIntent = ResponseTargetOwner &
  (
    | { kind: 'conversation'; receipt?: never; execution: ResponseExecutionBinding }
    | { kind: 'message'; receipt: ResponseTerminalReceipt }
  );

export type ResponseTargetResult =
  | { ok: true; selection: ResponseCanonicalTarget; publication: ManagedPublication }
  | { ok: false; code: 'response_conflict' | 'target_retired' };

/** Portable producers must assign managed input IDs before freezing the immutable turn.
 * Ordinary UUID inputs cannot use this path: legacy upserts could recreate them after erasure. */
function declaredMessage(intent: ResponseTargetIntent): boolean {
  if (intent.kind !== 'message') return true;
  const turn: unknown = JSON.parse(intent.receipt.turnJSON!);
  if (
    typeof turn !== 'object' ||
    turn === null ||
    !('version' in turn) ||
    turn.version !== 1 ||
    !('inputs' in turn) ||
    !Array.isArray(turn.inputs)
  )
    return false;
  return (
    intent.logicalId === intent.responseId ||
    turn.inputs.some(
      (input: unknown) =>
        typeof input === 'object' &&
        input !== null &&
        'messageId' in input &&
        input.messageId === intent.logicalId,
    )
  );
}

function identity(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
): FilterQuery<StoredResponseRecord> {
  assertManagedTenant(intent.tenantId);
  if (
    !/^[a-f\d]{24}$/i.test(intent.parentId) ||
    !intent.userId ||
    !intent.responseId ||
    !intent.fingerprint ||
    !intent.conversationId ||
    (intent.kind === 'conversation'
      ? !isManagedConversationId(intent.logicalId) || intent.logicalId !== intent.conversationId
      : !/^resp_d_[a-f\d]{32}$/.test(intent.logicalId) ||
        !intent.receipt.turnJSON ||
        !Number.isSafeInteger(intent.receipt.generationCreatedAt) ||
        intent.receipt.generationCreatedAt < 1) ||
    !declaredMessage(intent)
  )
    throw new TypeError('Invalid Response target intent');
  return {
    _id: new mongoose.Types.ObjectId(intent.parentId),
    ...responseOwnerFilter(intent),
    responseId: intent.responseId,
    fingerprint: intent.fingerprint,
    conversationId: intent.conversationId,
  };
}

function receiptKey(intent: ResponseTargetIntent): string {
  return intent.kind === 'message'
    ? responseReceiptKey(intent.receipt)
    : createHash('sha256')
        .update(
          JSON.stringify([
            'conversation',
            intent.responseId,
            intent.fingerprint,
            intent.conversationId,
          ]),
        )
        .digest('hex');
}

function admission(intent: ResponseTargetIntent): FilterQuery<StoredResponseRecord> {
  const available = {
    retiredAt: { $exists: false },
    persistenceFailure: { $exists: false },
    $and: [activeExpirationFilter<StoredResponseRecord>()],
  };
  if (intent.kind === 'message')
    return {
      ...available,
      status: 'materializing',
      generationCreatedAt: intent.receipt.generationCreatedAt,
      ...terminalFilter('pendingTerminal', intent.receipt),
    };
  return { ...available, status: 'in_progress', ...responseProviderFilter(intent.execution) };
}

function eligible(parent: StoredResponseRecord, intent: ResponseTargetIntent): boolean {
  if (
    parent.persistenceFailure ||
    parent.retiredAt != null ||
    (parent.expiredAt && parent.expiredAt <= new Date())
  )
    return false;
  if (intent.kind === 'message')
    return (
      parent.status === 'materializing' &&
      parent.generationCreatedAt === intent.receipt.generationCreatedAt &&
      parent.pendingTerminal != null &&
      sameResponseTerminalReceipt(parent.pendingTerminal, intent.receipt)
    );
  return (
    parent.status === 'in_progress' &&
    parent.generationCreatedAt === intent.execution.generationCreatedAt &&
    parent.providerExecution?.id === intent.execution.providerExecutionId &&
    parent.providerExecution.ownerId === intent.execution.ownerId &&
    parent.providerExecution.drained !== true &&
    parent.cancellationRequestedAt == null
  );
}

function selected(
  parent: StoredResponseRecord,
  intent: ResponseTargetIntent,
): ResponseCanonicalTarget | undefined {
  return parent.canonicalTargets?.find((entry) => entry.logicalId === intent.logicalId);
}

function exact(selection: ResponseCanonicalTarget): Record<string, unknown> {
  return {
    logicalId: selection.logicalId,
    receipt: selection.receipt,
    'target.kind': selection.target.kind,
    'target.id': selection.target.id,
    'target.incarnation': selection.target.incarnation,
  };
}

function result(
  intent: ResponseTargetIntent,
  selection: ResponseCanonicalTarget,
): ResponseTargetResult {
  if (
    selection.receipt !== receiptKey(intent) ||
    selection.target.kind !== intent.kind ||
    (selection.target.tenantId || undefined) !== (intent.tenantId || undefined)
  )
    return { ok: false, code: 'response_conflict' };
  if (selection.phase === 'retired') return { ok: false, code: 'target_retired' };
  const [ownerKey, conversationKey] = responseScopeKeys(intent, intent.conversationId);
  return {
    ok: true,
    selection,
    publication: {
      target: selection.target,
      parentId: intent.parentId,
      logicalId: selection.logicalId,
      receipt: selection.receipt,
      ownerKey,
      conversationKey,
    },
  };
}

async function targetExists(
  mongoose: typeof import('mongoose'),
  selection: ResponseCanonicalTarget,
): Promise<boolean> {
  const model = mongoose.model(selection.target.kind === 'message' ? 'Message' : 'Conversation');
  return (
    (await includeManagedAllocations(
      model.exists(managedTargetFilter(mongoose, selection.target)),
    ).read('primary')) != null
  );
}

/** Select one acknowledged physical target in the existing journal. No provider execution is owned here. */
export async function selectResponseTarget(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
): Promise<ResponseTargetResult> {
  const filter = identity(mongoose, intent);
  const model = createStoredResponseModel(mongoose);
  const parent = await model
    .findOne(filter)
    .select({
      status: 1,
      revision: 1,
      generationCreatedAt: 1,
      pendingTerminal: 1,
      canonicalTargets: 1,
      providerExecution: 1,
      retiredAt: 1,
      expiredAt: 1,
      cancellationRequestedAt: 1,
      persistenceFailure: 1,
    })
    .lean();
  if (!parent || parent.persistenceFailure) return { ok: false, code: 'response_conflict' };
  const previous = selected(parent, intent);
  if (previous) {
    const current = result(intent, previous);
    if (!current.ok) return current;
    if (await targetExists(mongoose, previous))
      return previous.phase !== 'selected' ||
        (await pinManagedTarget(mongoose, previous.target, intent.parentId))
        ? current
        : { ok: false, code: 'response_conflict' };
    // Registration may have succeeded despite a lost acknowledgment. Never replace after this boundary.
    if (previous.phase !== 'selected' || !eligible(parent, intent))
      return retireResponseTarget(mongoose, intent, previous);
  }
  if (!eligible(parent, intent)) return { ok: false, code: 'response_conflict' };
  const target = await allocateManagedTarget(mongoose, intent.kind, intent.tenantId);
  const selection: ResponseCanonicalTarget = {
    logicalId: intent.logicalId,
    receipt: receiptKey(intent),
    phase: 'selected',
    target,
  };
  const updated = await model
    .findOneAndUpdate(
      {
        ...filter,
        ...admission(intent),
        revision: parent.revision,
        ...(previous
          ? { canonicalTargets: { $elemMatch: { ...exact(previous), phase: 'selected' } } }
          : { 'canonicalTargets.logicalId': { $ne: intent.logicalId } }),
      },
      {
        ...(previous
          ? { $set: { 'canonicalTargets.$': selection } }
          : { $push: { canonicalTargets: selection } }),
        $inc: { revision: 1 },
      },
      { new: true },
    )
    .select({
      status: 1,
      revision: 1,
      generationCreatedAt: 1,
      pendingTerminal: 1,
      canonicalTargets: 1,
      providerExecution: 1,
      retiredAt: 1,
      expiredAt: 1,
      cancellationRequestedAt: 1,
      persistenceFailure: 1,
    })
    .lean();
  if (updated)
    return (await pinManagedTarget(mongoose, target, intent.parentId))
      ? result(intent, selection)
      : { ok: false, code: 'response_conflict' };
  // A losing, unclaimed allocation may be removed; this CAS cannot delete a pinned winner.
  await discardManagedAllocation(mongoose, target);
  return { ok: false, code: 'response_conflict' };
}

/** Pin first, then irreversibly freeze the parent selection before any authority registration. */
export async function beginResponseTargetRegistration(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
  selection: ResponseCanonicalTarget,
): Promise<ResponseTargetResult> {
  const filter = identity(mongoose, intent);
  const requested = result(intent, selection);
  if (!requested.ok) return requested;
  const model = createStoredResponseModel(mongoose);
  const parent = await model
    .findOne(filter)
    .select({
      status: 1,
      revision: 1,
      generationCreatedAt: 1,
      pendingTerminal: 1,
      canonicalTargets: 1,
      providerExecution: 1,
      retiredAt: 1,
      expiredAt: 1,
      cancellationRequestedAt: 1,
      persistenceFailure: 1,
    })
    .lean();
  const current = parent && selected(parent, intent);
  if (
    !parent ||
    !current ||
    current.target.id !== selection.target.id ||
    current.target.incarnation !== selection.target.incarnation
  )
    return { ok: false, code: 'response_conflict' };
  const owned = result(intent, current);
  if (!owned.ok) return owned;
  if (!eligible(parent, intent)) return { ok: false, code: 'response_conflict' };
  if (current.phase === 'selected') {
    if (!(await pinManagedTarget(mongoose, current.target, intent.parentId)))
      return { ok: false, code: 'response_conflict' };
    const frozen = await model.updateOne(
      {
        ...filter,
        ...admission(intent),
        revision: parent.revision,
        canonicalTargets: { $elemMatch: { ...exact(current), phase: 'selected' } },
      },
      { $set: { 'canonicalTargets.$.phase': 'registering' }, $inc: { revision: 1 } },
    );
    if (frozen.matchedCount !== 1) return { ok: false, code: 'response_conflict' };
  }
  if (await beginManagedTargetRegistration(mongoose, current.target, intent.parentId))
    return result(intent, { ...current, phase: 'registering' });
  const sealed = await includeManagedAllocations(
    mongoose.model(intent.kind === 'message' ? 'Message' : 'Conversation').exists({
      ...managedPublicationFilter(mongoose, owned.publication),
      '_managed.phase': { $in: ['registered', 'published'] },
    }),
  ).read('primary');
  if (sealed)
    return result(intent, {
      ...current,
      phase: current.phase === 'selected' ? 'registering' : current.phase,
    });
  return retireResponseTarget(mongoose, intent, current);
}

/** Retirement freezes the journal first. Owning cleanup then erases the exact canonical target. */
export async function retireResponseTarget(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
  selection: ResponseCanonicalTarget,
): Promise<Extract<ResponseTargetResult, { ok: false }>> {
  const filter = identity(mongoose, intent);
  const checked = result(intent, { ...selection, phase: 'selected' });
  if (!checked.ok) return checked;
  const model = createStoredResponseModel(mongoose);
  const retired = await model.updateOne(
    {
      ...filter,
      canonicalTargets: { $elemMatch: { ...exact(selection), phase: { $ne: 'retired' } } },
    },
    { $set: { 'canonicalTargets.$.phase': 'retired' }, $inc: { revision: 1 } },
  );
  if (
    retired.matchedCount === 1 ||
    (await model.exists({
      ...filter,
      canonicalTargets: { $elemMatch: { ...exact(selection), phase: 'retired' } },
    }))
  )
    await retireManagedAllocation(mongoose, selection.target, intent.parentId);
  return { ok: false, code: 'target_retired' };
}

/** Pinned rows outlive an owning selection, never merely a timer or lease. */
export async function sweepResponseTargetOrphans(
  mongoose: typeof import('mongoose'),
  kind: ManagedTarget['kind'],
  page: ManagedAllocationPage,
): Promise<{ deleted: number; next?: string }> {
  const listed = await listManagedAllocations(mongoose, kind, page, [
    'pinned',
    'registering',
    'registered',
  ]);
  if (!listed.allocations.length) return { deleted: 0 };
  const parentIds = [
    ...new Set(
      listed.allocations.map(({ state }) => {
        if (!state.parentId || !/^[a-f\d]{24}$/i.test(state.parentId))
          throw new Error('Managed target has no valid owning parent');
        return state.parentId.toLowerCase();
      }),
    ),
  ];
  const parents = await createStoredResponseModel(mongoose)
    .find({
      _id: { $in: parentIds.map((id) => new mongoose.Types.ObjectId(id)) },
      tenantId: page.tenantId || { $in: [null, ''] },
    })
    .select({ canonicalTargets: 1 })
    .read('primary')
    .lean<Array<{ _id: Types.ObjectId; canonicalTargets?: ResponseCanonicalTarget[] }>>();
  const selections = new Map(
    parents.map((parent) => [String(parent._id), parent.canonicalTargets]),
  );
  let deleted = 0;
  for (const { target, state } of listed.allocations) {
    const live = selections
      .get(state.parentId!.toLowerCase())
      ?.some(
        (entry) =>
          entry.phase !== 'retired' &&
          entry.target.kind === kind &&
          entry.target.id === target.id &&
          entry.target.incarnation === target.incarnation,
      );
    if (!live && (await retireManagedAllocation(mongoose, target, state.parentId!))) deleted++;
  }
  return { deleted, ...(listed.next && { next: listed.next }) };
}

/** Advance journal metadata only after the exact target proves the corresponding durable phase. */
export async function acknowledgeResponseTarget(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
  selection: ResponseCanonicalTarget,
  phase: 'registered' | 'published',
): Promise<ResponseTargetResult> {
  const filter = identity(mongoose, intent);
  const requested = result(intent, selection);
  if (!requested.ok) return requested;
  const model = createStoredResponseModel(mongoose);
  const parent = await model
    .findOne(filter)
    .select({
      status: 1,
      revision: 1,
      generationCreatedAt: 1,
      pendingTerminal: 1,
      canonicalTargets: 1,
      providerExecution: 1,
      retiredAt: 1,
      expiredAt: 1,
      cancellationRequestedAt: 1,
      persistenceFailure: 1,
    })
    .lean();
  const current = parent && selected(parent, intent);
  if (
    !parent ||
    !current ||
    current.target.id !== selection.target.id ||
    current.target.incarnation !== selection.target.incarnation
  )
    return { ok: false, code: 'response_conflict' };
  const owned = result(intent, current);
  if (!owned.ok) return owned;
  if (current.phase === 'selected') return { ok: false, code: 'response_conflict' };
  const target = await includeManagedAllocations(
    mongoose.model(intent.kind === 'message' ? 'Message' : 'Conversation').exists({
      ...managedPublicationFilter(mongoose, owned.publication),
      '_managed.phase': phase === 'published' ? 'published' : { $in: ['registered', 'published'] },
    }),
  ).read('primary');
  if (!target) {
    if (!(await targetExists(mongoose, current)))
      return retireResponseTarget(mongoose, intent, current);
    return { ok: false, code: 'response_conflict' };
  }
  if (current.phase === phase || current.phase === 'published') return owned;
  const updated = await model.updateOne(
    {
      ...filter,
      ...admission(intent),
      revision: parent.revision,
      canonicalTargets: { $elemMatch: { ...exact(current), phase: current.phase } },
    },
    { $set: { 'canonicalTargets.$.phase': phase }, $inc: { revision: 1 } },
  );
  return updated.matchedCount === 1
    ? result(intent, { ...current, phase })
    : { ok: false, code: 'response_conflict' };
}

/** Each target gets its own registry key, even when several messages share one terminal receipt. */
export function responseTargetRegistrationKey(publication: ManagedPublication): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        publication.parentId,
        publication.receipt,
        publication.logicalId,
        publication.target.id,
        publication.target.incarnation,
      ]),
    )
    .digest('hex');
}

/** One canonical publication protocol for managed Conversation seeds and confirmed Messages. */
export async function publishResponseTarget<T>(
  mongoose: typeof import('mongoose'),
  intent: ResponseTargetIntent,
  write: (publication: ManagedPublication, expiredAt?: Date) => Promise<T | null | undefined>,
  options: { maxPendingTargetsPerScope?: number; expiredAt?: Date } = {},
): Promise<
  | { ok: true; value: T; publication: ManagedPublication }
  | { ok: false; code: 'response_conflict' | 'target_retired' }
> {
  const selected = await selectResponseTarget(mongoose, intent);
  if (!selected.ok) return selected;
  const started = await beginResponseTargetRegistration(mongoose, intent, selected.selection);
  if (!started.ok) return started;
  const { publication } = started;
  const entry = {
    key: responseTargetRegistrationKey(publication),
    target: publication.target,
  };
  let expiredAt = options.expiredAt;
  for (const conversationId of [undefined, intent.conversationId]) {
    const registered = await registerResponseTarget(mongoose, intent, conversationId, entry, {
      maxPendingTargetsPerScope: options.maxPendingTargetsPerScope,
    });
    if (registered.status !== 'registered') {
      if (registered.status === 'closed')
        await retireResponseTarget(mongoose, intent, started.selection);
      return { ok: false, code: 'response_conflict' };
    }
    if (registered.expiredAt && (!expiredAt || registered.expiredAt < expiredAt))
      expiredAt = registered.expiredAt;
  }
  const model = mongoose.model(intent.kind === 'message' ? 'Message' : 'Conversation');
  if (!(await markManagedTargetRegistered(mongoose, publication))) {
    const published = await includeManagedAllocations(
      model.exists({
        ...managedPublicationFilter(mongoose, publication),
        '_managed.phase': 'published',
      }),
    ).read('primary');
    if (!published) {
      if (!(await targetExists(mongoose, started.selection)))
        return retireResponseTarget(mongoose, intent, started.selection);
      return { ok: false, code: 'response_conflict' };
    }
  }
  const registered = await acknowledgeResponseTarget(
    mongoose,
    intent,
    started.selection,
    'registered',
  );
  if (!registered.ok) return registered;
  if (expiredAt) {
    if (expiredAt <= new Date()) return { ok: false, code: 'response_conflict' };
    // An idempotent canonical writer may return an already published row. Its
    // deadline still has to adopt a newly shortened discovery authority.
    await shortenExpiration(model, managedTargetFilter(mongoose, publication.target), expiredAt);
  }
  const value = await write(publication, expiredAt);
  if (value == null) {
    if (!(await targetExists(mongoose, registered.selection)))
      return retireResponseTarget(mongoose, intent, registered.selection);
    return { ok: false, code: 'response_conflict' };
  }
  const published = await acknowledgeResponseTarget(
    mongoose,
    intent,
    registered.selection,
    'published',
  );
  if (!published.ok) return published;
  for (const conversationId of [undefined, intent.conversationId])
    if (!(await settleResponseTarget(mongoose, intent, conversationId, entry)))
      return { ok: false, code: 'response_conflict' };
  return { ok: true, value, publication };
}
