import type { MediaOwnerScope, MediaStoredOwner } from '~/types/media';
import type { ITransaction } from '~/schema/transaction';
import { createTransactionModel } from '~/models/transaction';
import { createMediaOwnerModel } from '~/models/media';
import { mediaScopeFilter } from '~/utils/media';
import { createUserModel } from '~/models/user';
import { durable } from './scope';

type MediaLedgerReconciler = (
  scope: MediaOwnerScope,
  limit: number,
  transactionId?: string,
) => Promise<number>;

/** Pending receipts survive a writer that resumes after its account tombstone has expired. */
export function createMediaLedgerReconciler(
  mongoose: typeof import('mongoose'),
): MediaLedgerReconciler {
  const Transaction = createTransactionModel(mongoose);
  const Owner = createMediaOwnerModel(mongoose);
  const User = createUserModel(mongoose);
  return async (scope, limit, transactionId) => {
    const ownerScope = mediaScopeFilter(scope);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid ledger cleanup limit');
    const filter = {
      user: ownerScope.ownerId,
      tenantId: ownerScope.tenantId,
      mediaAccountPending: true,
      ...(transactionId ? { _id: transactionId } : {}),
    };
    const pending = await Transaction.find(filter)
      .select('_id')
      .sort({ _id: 1 })
      .limit(limit)
      .lean<Pick<ITransaction, '_id'>[]>();
    if (!pending.length) return 0;
    const owner = await Owner.findOne(ownerScope)
      .select('status')
      .lean<Pick<MediaStoredOwner, 'status'>>();
    const selected = { ...filter, _id: { $in: pending.map((receipt) => receipt._id) } };
    if (owner?.status === 'active') {
      // This update never upserts: a deletion after validation cannot revive a removed receipt.
      const result = await Transaction.updateMany(
        selected,
        { $unset: { mediaAccountPending: 1 } },
        { writeConcern: durable },
      );
      return result.modifiedCount;
    }
    if (
      owner?.status === 'deleted' ||
      (!owner && !(await User.exists({ _id: scope.ownerId, tenantId: ownerScope.tenantId })))
    ) {
      const result = await Transaction.deleteMany(selected, { writeConcern: durable });
      return result.deletedCount;
    }
    return 0;
  };
}
