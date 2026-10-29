import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelScopeModel } from '~/models/channelScope';

export function assertChannelTenant(tenantId: string | undefined): void {
  const current = getTenantId();
  if (current && current !== SYSTEM_TENANT_ID && current !== (tenantId || '_'))
    throw new TypeError('Channel tenant does not match authenticated scope');
}

const key = (tenantId: string | undefined, channelId: string) =>
  createHash('sha256')
    .update(JSON.stringify([tenantId || '_', channelId]))
    .digest('hex');

export async function initializeChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
): Promise<void> {
  assertChannelTenant(tenantId);
  const model = createChannelScopeModel(mongoose);
  const _id = key(tenantId, channelId);
  try {
    await model.updateOne(
      { _id },
      { $setOnInsert: { closed: false, revision: 0 } },
      { upsert: true },
    );
  } catch (error) {
    if (
      !(error instanceof mongoose.mongo.MongoServerError) ||
      error.code !== 11000 ||
      !(await model.exists({ _id }))
    )
      throw error;
  }
}

/** Must share the transaction that inserts or mutates channel-owned private data. */
export async function touchChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
  session: ClientSession,
): Promise<boolean> {
  assertChannelTenant(tenantId);
  const result = await createChannelScopeModel(mongoose).updateOne(
    { _id: key(tenantId, channelId), closed: false },
    { $inc: { revision: 1 } },
    { session },
  );
  return result.matchedCount === 1;
}

export async function closeChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
): Promise<void> {
  assertChannelTenant(tenantId);
  const model = createChannelScopeModel(mongoose);
  const filter = { _id: key(tenantId, channelId) };
  try {
    await model.updateOne(
      filter,
      { $set: { closed: true }, $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
  } catch (error) {
    if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
    await model.updateOne(filter, { $set: { closed: true } });
  }
}
