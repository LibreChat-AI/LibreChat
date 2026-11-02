import type { ClientSession } from 'mongoose';
import type { ResponseOwner } from '~/models/response';
import { responseScopeKeys, initializeResponseScopes } from './responseScope';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createResponseScopeModel } from '~/models/responseScope';

/** All private channel persistence joins the same account-erasure admission fence. */
export async function prepareChannelOwnerAdmission(
  mongoose: typeof import('mongoose'),
  owner: ResponseOwner,
): Promise<(session: ClientSession) => Promise<boolean>> {
  const current = getTenantId() || undefined;
  if (
    !owner.userId ||
    owner.tenantId === SYSTEM_TENANT_ID ||
    (current && current !== SYSTEM_TENANT_ID && current !== (owner.tenantId || undefined))
  )
    throw new TypeError('Channel owner does not match authenticated scope');
  const [key] = responseScopeKeys(owner, '');
  await initializeResponseScopes(mongoose, [key]);
  return async (session) => {
    const admitted = await createResponseScopeModel(mongoose).updateOne(
      { _id: key, closed: false },
      { $inc: { revision: 1 } },
      { session },
    );
    return admitted.matchedCount === 1;
  };
}
