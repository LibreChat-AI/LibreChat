import { channelStorageConfigSchema } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordReceiptModel } from '~/models/discordReceipt';
import { createDiscordInboxModel } from '~/models/discordInbox';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelIndexGate } from './channelIndexes';

export type DiscordInboxErasureScope = { tenantId?: string } & (
  | { kind: 'dm_user'; userId: string }
  | { kind: 'application'; applicationId: string }
  | { kind: 'guild'; applicationId: string; guildId: string }
  | { kind: 'channel'; channelId: string }
  | {
      kind: 'actor';
      channelId: string;
      externalUserId: string;
      applicationId?: string;
      guildId?: string;
    }
);

/** The caller supplies the canonical channel cleanup fence; no private rows cross this boundary. */
export function createDiscordInboxErasure(
  mongoose: typeof import('mongoose'),
  fence: (scope: { tenantId?: string; channelId: string }, session: ClientSession) => Promise<void>,
): { erase(scope: DiscordInboxErasureScope, batchSize?: number): Promise<void> } {
  const inbox = createDiscordInboxModel(mongoose);
  const receipts = createDiscordReceiptModel(mongoose);
  const ensureIndexes = createChannelIndexGate(() => [receipts]);
  return {
    async erase(scope, batchSize = channelStorageConfigSchema.parse({}).erasureBatchSize) {
      const tenantId = getTenantId() || undefined;
      if (tenantId === SYSTEM_TENANT_ID || (scope.tenantId || undefined) !== tenantId)
        throw new TypeError('Discord inbox erasure requires the matching tenant scope');
      channelStorageConfigSchema.shape.erasureBatchSize.parse(batchSize);
      const { kind } = scope;
      if (
        !['application', 'guild', 'channel', 'actor', 'dm_user'].includes(kind) ||
        ((kind === 'application' || kind === 'guild') &&
          (typeof scope.applicationId !== 'string' || !scope.applicationId)) ||
        ((kind === 'channel' || kind === 'actor') &&
          (typeof scope.channelId !== 'string' || !scope.channelId)) ||
        (kind === 'guild' && (typeof scope.guildId !== 'string' || !scope.guildId)) ||
        (kind === 'dm_user' && (typeof scope.userId !== 'string' || !scope.userId)) ||
        (kind === 'actor' && (typeof scope.externalUserId !== 'string' || !scope.externalUserId))
      )
        throw new TypeError('Invalid Discord inbox erasure scope');
      let destination: object;
      if (kind === 'dm_user') destination = { 'dm.source.userId': scope.userId };
      else if (kind === 'application' || kind === 'guild')
        destination = { applicationId: scope.applicationId };
      else if (kind === 'actor' && scope.applicationId && scope.guildId)
        destination = {
          $or: [
            { channelId: scope.channelId },
            { routing: 'inspection', applicationId: scope.applicationId, guildId: scope.guildId },
          ],
        };
      else destination = { channelId: scope.channelId };
      const filter = {
        tenantId: tenantId || { $in: [null, ''] },
        ...destination,
        ...(kind === 'guild'
          ? {
              $or: [
                { guildId: scope.guildId },
                {
                  'dm.source.guildId': scope.guildId,
                  'dm.source.applicationId': scope.applicationId,
                },
              ],
            }
          : {}),
        ...(kind === 'actor' ? { externalUserId: scope.externalUserId } : {}),
      };
      const last = await inbox
        .findOne(filter)
        .sort({ _id: -1 })
        .select('_id')
        .read('primary')
        .lean();
      if (!last) return;
      let more = true;
      while (more) {
        const count = await withRequiredTransaction(
          mongoose,
          async (session) => {
            const rows = await inbox
              .find({ ...filter, _id: { $lte: last._id } })
              .sort({ _id: 1 })
              .limit(batchSize)
              .select('applicationId eventId fingerprint purgeAt channelId routing')
              .session(session)
              .lean();
            const locked = new Set<string>();
            for (const row of rows) {
              if (row.routing !== 'inspection' && !locked.has(row.channelId)) {
                await fence({ tenantId, channelId: row.channelId }, session);
                locked.add(row.channelId);
              }
              await receipts.updateOne(
                { applicationId: row.applicationId, eventId: row.eventId },
                {
                  $setOnInsert: {
                    applicationId: row.applicationId,
                    eventId: row.eventId,
                    fingerprint: row.fingerprint,
                  },
                  $max: { purgeAt: row.purgeAt },
                },
                { upsert: true, session, runValidators: true },
              );
            }
            if (rows.length)
              await inbox.deleteMany(
                { ...filter, _id: { $in: rows.map((row) => row._id) } },
                { session },
              );
            return rows.length;
          },
          ensureIndexes,
        );
        more = count === batchSize;
      }
    },
  };
}
