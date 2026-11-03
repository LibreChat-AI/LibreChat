import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelStorageConfig } from 'librechat-data-provider';
import type { Types } from 'mongoose';
import type { AgentChannelRecord } from '~/models/channel';
import type { ManagedTarget } from '~/types/managed';
import { getTenantId, SYSTEM_TENANT_ID, tenantStorage } from '~/config/tenantContext';
import { createAgentChannelModel, CHANNEL_PRIVATE_FIELDS } from '~/models/channel';
import { eraseChannelIdentitiesForChannel } from './channelIdentityErasure';
import { reconcileClosedChannelRegistries } from './channelRegistry';

export function assertChannelTenant(tenantId: string | undefined): void {
  const current = getTenantId();
  if (current && current !== SYSTEM_TENANT_ID && current !== (tenantId || '_'))
    throw new TypeError('Channel tenant does not match authenticated scope');
}

type ChannelConnection = {
  tenantId?: string;
  channelId: string;
  createdBy: string;
  id?: string;
  incarnation?: string;
};
interface ClosedChannel {
  record: AgentChannelRecord;
  target: ManagedTarget<'channel'>;
}

/** Close/redact canonical authority without entering a dependent storage cascade. */
export async function closeAgentChannel(
  mongoose: typeof import('mongoose'),
  connection: ChannelConnection,
  redactCredentials = false,
): Promise<ClosedChannel | null> {
  const { tenantId, channelId, createdBy } = connection;
  assertChannelTenant(tenantId);
  if (getTenantId() === SYSTEM_TENANT_ID && tenantId)
    return tenantStorage.run({ tenantId }, () =>
      closeAgentChannel(mongoose, connection, redactCredentials),
    );
  if (connection.id !== undefined && !/^[a-f\d]{24}$/i.test(connection.id))
    throw new TypeError('Invalid channel retirement identity');
  const model = createAgentChannelModel(mongoose);
  const parent = await model
    .findOne({
      ...(connection.id && { _id: new mongoose.Types.ObjectId(connection.id) }),
      channelId,
      createdBy,
      '_managed.phase': 'published',
      tenantId: tenantId || { $in: [null, ''] },
      ...(connection.incarnation && { '_managed.incarnation': connection.incarnation }),
    })
    .select('_id _managed.incarnation')
    .read('primary')
    .lean<{ _id: Types.ObjectId; _managed?: { incarnation: string } }>();
  if (!parent) return null;
  if (!parent._managed) throw new Error('Channel retirement requires managed ownership');
  const deleting = await model
    .findOneAndUpdate(
      {
        _id: parent._id,
        channelId,
        createdBy,
        tenantId: tenantId || { $in: [null, ''] },
        '_managed.incarnation': parent._managed.incarnation,
        '_managed.phase': 'published',
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
  return {
    record: deleting,
    target: {
      kind: 'channel',
      id: String(parent._id),
      incarnation: parent._managed.incarnation,
      ...(tenantId && { tenantId }),
    },
  };
}

/** Close canonical authority first, then drain dependent identities and registrations. */
export async function retireAgentChannel(
  mongoose: typeof import('mongoose'),
  connection: ChannelConnection,
  redactCredentials = false,
  options: Partial<ChannelStorageConfig> = {},
): Promise<AgentChannelRecord | null> {
  const { erasureBatchSize } = channelStorageConfigSchema.parse(options);
  if (getTenantId() === SYSTEM_TENANT_ID && connection.tenantId)
    return tenantStorage.run({ tenantId: connection.tenantId }, () =>
      retireAgentChannel(mongoose, connection, redactCredentials, options),
    );
  const closed = await closeAgentChannel(mongoose, connection, redactCredentials);
  if (!closed) return null;
  const { tenantId, channelId, createdBy } = connection;
  await eraseChannelIdentitiesForChannel(mongoose, closed.target, channelId, erasureBatchSize);
  await reconcileClosedChannelRegistries(mongoose, {
    id: closed.target.id,
    tenantId,
    channelId,
    createdBy,
  });
  return closed.record;
}
