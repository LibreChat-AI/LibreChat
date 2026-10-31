import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { createChannelScopeModel } from '~/models/channelScope';
import { touchChannelOwnerAdmission } from './channelOwner';
import { createAgentChannelModel } from '~/models/channel';

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
  return Boolean(
    await createChannelIdentityModel(mongoose)
      .exists({
        tenantId: authority.tenantId || '_',
        linkId: principal.linkId,
        revision: principal.linkRevision,
        userId: principal.userId,
        state: 'active',
        expiresAtMs: { $gt: authority.now },
        'identity.tenantId': authority.tenantId || '_',
        'identity.channelId': authority.channelId,
        'identity.channelRevision': authority.channelRevision,
        'identity.agentId': authority.agentId,
        'identity.teamId': authority.teamId,
        'identity.externalUserId': authority.externalUserId,
      })
      .session(session),
  );
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

/** Status, credential redaction and closure commit together; dependent erasure is retryable. */
export async function retireAgentChannel(
  mongoose: typeof import('mongoose'),
  connection: { tenantId?: string; channelId: string; createdBy: string },
  redactCredentials = false,
): Promise<AgentChannelRecord | null> {
  const { tenantId, channelId, createdBy } = connection;
  await initializeChannelScope(mongoose, tenantId, channelId);
  const session = await mongoose.startSession();
  try {
    const deleting = await session.withTransaction(async () => {
      const record = await createAgentChannelModel(mongoose)
        .findOneAndUpdate(
          { channelId, createdBy, tenantId: tenantId || { $in: [null, ''] } },
          {
            $set: { status: 'deleting' },
            ...(redactCredentials
              ? {
                  $unset: {
                    encryptedBotToken: '',
                    encryptedSigningSecret: '',
                  },
                }
              : {}),
          },
          { new: true, session },
        )
        .select('+encryptedBotToken +encryptedSigningSecret')
        .lean();
      if (!record) return null;
      await closeChannelScope(mongoose, tenantId, channelId, session);
      return record;
    });
    if (!deleting) return null;
    await createChannelIdentityModel(mongoose).deleteMany({
      tenantId: tenantId || '_',
      'identity.channelId': channelId,
    });
    return deleting;
  } finally {
    await session.endSession();
  }
}
