import { createHash } from 'node:crypto';
import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { ClientSession, Types } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { eraseChannelIdentitiesForChannel } from './channelIdentityErasure';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { reconcileClosedChannelRegistries } from './channelRegistry';
import { createChannelScopeModel } from '~/models/channelScope';
import { touchChannelOwnerAdmission } from './channelOwner';

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

/** Transactional callers pass their session; portable publication uses canonical registration. */
export async function touchChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
  session?: ClientSession,
): Promise<boolean> {
  assertChannelTenant(tenantId);
  const result = await createChannelScopeModel(mongoose).updateOne(
    { _id: key(tenantId, channelId), closed: false },
    { $inc: { revision: 1 } },
    { session },
  );
  return result.matchedCount === 1;
}

export async function lockChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
  session: ClientSession,
): Promise<void> {
  assertChannelTenant(tenantId);
  const locked = await createChannelScopeModel(mongoose).updateOne(
    { _id: key(tenantId, channelId) },
    { $inc: { revision: 1 } },
    { session },
  );
  if (locked.matchedCount !== 1) throw new Error('Channel serialization fence unavailable');
}

/** Read canonical authority only after joining the same fence as every parent mutation. */
export async function touchChannelAuthority(
  mongoose: typeof import('mongoose'),
  authority: {
    tenantId?: string;
    channelId: string;
    agentId: string;
    channelRevision: string;
    teamId?: string;
    appId?: string;
    principal?: { userId: string; linkId?: string; linkRevision?: string };
    externalUserId?: string;
    now?: number;
  },
  session: ClientSession,
): Promise<boolean> {
  if (!(await touchChannelScope(mongoose, authority.tenantId, authority.channelId, session)))
    return false;
  const parent = await createAgentChannelModel(mongoose)
    .findOne({
      tenantId:
        !authority.tenantId || authority.tenantId === '_'
          ? { $in: [null, ''] }
          : authority.tenantId,
      channelId: authority.channelId,
      agentId: authority.agentId,
      revision:
        authority.channelRevision === authority.channelId
          ? { $in: [null, authority.channelRevision] }
          : authority.channelRevision,
      status: 'active',
      ...(authority.teamId === undefined ? {} : { 'slack.teamId': authority.teamId }),
      ...(authority.appId === undefined ? {} : { 'slack.appId': authority.appId }),
    })
    .select('createdBy tenantId credentialMode')
    .session(session)
    .lean();
  if (
    !parent ||
    !(await touchChannelOwnerAdmission(
      mongoose,
      {
        userId: parent.createdBy,
        tenantId: parent.tenantId || undefined,
      },
      session,
    ))
  )
    return false;
  const principal = authority.principal;
  if (!principal) return true;
  if (principal.linkId === undefined && principal.linkRevision === undefined)
    return parent.credentialMode === 'shared';
  if (!principal.linkId || principal.linkRevision === undefined || authority.now === undefined)
    return false;
  const admitted = await createChannelIdentityModel(mongoose).updateOne(
    {
      tenantId: authority.tenantId || '_',
      linkId: principal.linkId,
      revision: principal.linkRevision,
      userId: principal.userId,
      state: 'active',
      '_managed.phase': 'published',
      expiresAtMs: { $gt: authority.now },
      'identity.tenantId': authority.tenantId || '_',
      'identity.channelId': authority.channelId,
      'identity.channelRevision': authority.channelRevision,
      'identity.agentId': authority.agentId,
      'identity.teamId': authority.teamId,
      'identity.externalUserId': authority.externalUserId,
    },
    { $inc: { __v: 1 } },
    { session, upsert: false },
  );
  return admitted.matchedCount === 1;
}

export async function closeChannelScope(
  mongoose: typeof import('mongoose'),
  tenantId: string | undefined,
  channelId: string,
  session?: ClientSession,
): Promise<void> {
  assertChannelTenant(tenantId);
  const model = createChannelScopeModel(mongoose);
  const filter = { _id: key(tenantId, channelId) };
  if (session) {
    const closed = await model.updateOne(filter, { $set: { closed: true } }, { session });
    if (closed.matchedCount !== 1) throw new Error('Channel closure fence unavailable');
    return;
  }
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

/** Close canonical authority first, then drain the shared fence before dependent erasure. */
export async function retireAgentChannel(
  mongoose: typeof import('mongoose'),
  connection: { tenantId?: string; channelId: string; createdBy: string; id?: string },
  redactCredentials = false,
  options: Partial<ChannelStorageConfig> = {},
): Promise<AgentChannelRecord | null> {
  const { erasureBatchSize } = channelStorageConfigSchema.parse(options);
  const { tenantId, channelId, createdBy } = connection;
  assertChannelTenant(tenantId);
  if (getTenantId() === SYSTEM_TENANT_ID && tenantId)
    return tenantStorage.run({ tenantId }, () =>
      retireAgentChannel(mongoose, connection, redactCredentials, options),
    );
  if (connection.id !== undefined && !/^[a-f\d]{24}$/i.test(connection.id))
    throw new TypeError('Invalid channel retirement identity');
  const model = createAgentChannelModel(mongoose);
  const parent = await model
    .findOne({
      ...(connection.id && { _id: new mongoose.Types.ObjectId(connection.id) }),
      channelId,
      createdBy,
      tenantId: tenantId || { $in: [null, ''] },
    })
    .select('_id _managed.incarnation')
    .read('primary')
    .lean<{ _id: Types.ObjectId; _managed?: { incarnation: string } }>();
  if (!parent) return null;
  await initializeChannelScope(mongoose, tenantId, channelId);
  const deleting = await model
    .findOneAndUpdate(
      {
        _id: parent._id,
        channelId,
        createdBy,
        tenantId: tenantId || { $in: [null, ''] },
        '_managed.incarnation': parent._managed?.incarnation ?? { $exists: false },
      },
      {
        $set: { status: 'deleting' },
        ...(redactCredentials
          ? {
              $unset: Object.fromEntries(CHANNEL_PRIVATE_FIELDS.map((field) => [field, 1])),
            }
          : {}),
      },
      { new: true, upsert: false },
    )
    .select(CHANNEL_PRIVATE_FIELDS.map((field) => `+${field}`).join(' '))
    .lean();
  if (!deleting) return null;
  // Existing transactional writers still touch this fence. Closing it waits for
  // their admitted writes or makes their transaction retry against closed authority.
  // No dependent sweep or successful retirement acknowledgment precedes this write.
  await closeChannelScope(mongoose, tenantId, channelId);
  if (!parent._managed) throw new Error('Channel retirement requires managed ownership');
  await eraseChannelIdentitiesForChannel(
    mongoose,
    {
      kind: 'channel',
      id: String(parent._id),
      incarnation: parent._managed.incarnation,
      ...(tenantId && { tenantId }),
    },
    channelId,
    erasureBatchSize,
  );
  await reconcileClosedChannelRegistries(mongoose, {
    id: String(parent._id),
    tenantId,
    channelId,
    createdBy,
  });
  return deleting;
}
