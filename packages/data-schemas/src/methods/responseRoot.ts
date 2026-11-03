import { createHash } from 'node:crypto';
import type { StoredResponseRecord } from '~/models/response';
import type { ResponseReservation } from './response';
import type { ManagedTarget } from '~/types/managed';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { createStoredResponseModel } from '~/models/response';
import { includeManagedAllocations } from '~/utils/managed';
import { responseScopeKeys } from './responseScope';
import { managedTargetFilter } from './managed';

/** Install a root only into its acknowledged allocation, after both discovery authorities admit it.
 * The caller owns idempotency lookup and allocation; neither a retry nor a lost reply can upsert it. */
export async function publishResponseRoot(
  mongoose: typeof import('mongoose'),
  target: ManagedTarget<'response'>,
  input: ResponseReservation,
  options?: { maxPendingTargetsPerScope?: number },
): Promise<StoredResponseRecord | null> {
  if (
    target.kind !== 'response' ||
    (input.tenantId || undefined) !== (target.tenantId || undefined) ||
    !input.userId ||
    !/^resp_d_[a-f\d]{32}$/.test(input.responseId) ||
    !input.requestKey ||
    !input.fingerprint ||
    !input.conversationId ||
    (input.expiredAt != null &&
      (!(input.expiredAt instanceof Date) || !Number.isFinite(input.expiredAt.getTime())))
  )
    throw new TypeError('Invalid Response root publication');
  const physical = managedTargetFilter(mongoose, target);
  const [ownerKey, conversationKey] = responseScopeKeys(input, input.conversationId);
  const key = createHash('sha256')
    .update(JSON.stringify(['response', target.id.toLowerCase(), target.incarnation]))
    .digest('hex');
  const entry = { key, target };
  let expiredAt = input.expiredAt;
  for (const conversationId of [undefined, input.conversationId]) {
    const registered = await registerResponseTarget(
      mongoose,
      input,
      conversationId,
      entry,
      options,
    );
    if (registered.status !== 'registered') return null;
    if (registered.expiredAt && (!expiredAt || registered.expiredAt < expiredAt))
      expiredAt = registered.expiredAt;
  }
  if (expiredAt && expiredAt <= new Date()) return null;
  const model = createStoredResponseModel(mongoose);
  const metadata = {
    '_managed.parentId': target.id,
    '_managed.logicalId': input.responseId,
    '_managed.receipt': key,
    '_managed.ownerKey': ownerKey,
    '_managed.conversationKey': conversationKey,
  };
  const sealed = await includeManagedAllocations(
    model.updateOne(
      {
        ...physical,
        responseId: `__allocation_${target.id.toLowerCase()}`,
        requestKey: `__allocation_${target.id.toLowerCase()}`,
        userId: { $exists: false },
        $or: [{ '_managed.phase': 'empty' }, { ...metadata, '_managed.phase': 'registered' }],
      },
      { $set: { ...metadata, '_managed.phase': 'registered' } },
    ),
  );
  if (sealed.matchedCount !== 1) return null;
  const { dispatch, ...reservation } = input;
  const record = await includeManagedAllocations(
    model.findOneAndUpdate(
      {
        ...physical,
        ...metadata,
        '_managed.phase': 'registered',
        userId: { $exists: false },
        responseId: `__allocation_${target.id.toLowerCase()}`,
        requestKey: `__allocation_${target.id.toLowerCase()}`,
      },
      {
        $set: {
          ...reservation,
          ...(expiredAt ? { expiredAt } : {}),
          ...(dispatch
            ? { dispatchOutbox: { kind: 'create', id: input.responseId, state: 'pending' } }
            : {}),
          status: 'queued',
          revision: 0,
          '_managed.phase': 'published',
        },
      },
      { new: true },
    ),
  ).lean();
  if (!record) return null;
  for (const conversationId of [undefined, input.conversationId])
    await settleResponseTarget(mongoose, input, conversationId, entry);
  return record;
}
