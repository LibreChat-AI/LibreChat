import {
  discordInboxFenceSchema,
  discordGatewayOwnerSchema,
  discordGuildThreadSourceSchema,
  discordThreadRouteSchema,
  discordGuildTextActorSourceSchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  DiscordGatewayOwner,
  DiscordGuildTextActorSource,
  DiscordGuildThreadSource,
  DiscordInboxFence,
  DiscordThreadRoute,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordInboxRecord, DiscordInboxLeaseRecord } from '~/models/discordInbox';
import type { DiscordInboxResult } from './discordInbox';
import { touchDiscordThreadRoute, touchDiscordThreadBinding } from './discordThread';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { createDiscordInboxModel } from '~/models/discordInbox';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchDiscordGatewayOwner } from './discordGateway';
import { touchDiscordDmInbox } from './discordCommandScope';
import { createAgentChannelModel } from '~/models/channel';
import { touchChannelAuthority } from './channelScope';
import { touchDiscordInstallation } from './discord';

export interface DiscordInboxResolutionStorage {
  inspect(
    fence: DiscordInboxFence,
    owner: DiscordGatewayOwner,
    now: number,
  ): Promise<DiscordInboxLeaseRecord | null>;
  resolve(
    fence: DiscordInboxFence,
    owner: DiscordGatewayOwner,
    source: DiscordGuildThreadSource,
    route: DiscordThreadRoute,
    now: number,
  ): Promise<DiscordInboxResult<DiscordInboxRecord>>;
  resolveText(
    fence: DiscordInboxFence,
    owner: DiscordGatewayOwner,
    source: DiscordGuildTextActorSource,
    now: number,
  ): Promise<DiscordInboxResult<DiscordInboxRecord>>;
  unavailable(
    fence: DiscordInboxFence,
    owner: DiscordGatewayOwner,
    encryptedReply: string,
    now: number,
  ): Promise<DiscordInboxResult<DiscordInboxLeaseRecord>>;
}
const stale = (): { ok: false; error: { code: 'stale_fence' } } => ({
  ok: false,
  error: { code: 'stale_fence' },
});
const changed = (): { ok: false; error: { code: 'authority_changed' } } => ({
  ok: false,
  error: { code: 'authority_changed' },
});

/** One inspection execution per lease epoch, using the existing durable inbox and no second ledger. */
export function createDiscordInboxResolutionStorage(
  mongoose: typeof import('mongoose'),
): DiscordInboxResolutionStorage {
  const inbox = createDiscordInboxModel(mongoose);
  function tenant(): string | undefined {
    const value = getTenantId();
    if (value === SYSTEM_TENANT_ID)
      throw new TypeError('Discord inbox resolution requires tenant scope');
    return value || undefined;
  }
  function live(fence: DiscordInboxFence, owner: DiscordGatewayOwner, now: number) {
    discordInboxFenceSchema.parse(fence);
    discordGatewayOwnerSchema.parse(owner);
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TypeError('Invalid Discord resolution clock');
    return {
      tenantId: tenant() ?? null,
      applicationId: fence.applicationId,
      applicationRevision: owner.applicationRevision,
      eventId: fence.eventId,
      leaseOwner: fence.owner,
      leaseEpoch: fence.epoch,
      leaseExpiresAt: { $gt: now },
      expiresAt: { $gt: now },
      state: { $in: ['processing', 'reply'] },
    };
  }
  async function owned(
    fence: DiscordInboxFence,
    owner: DiscordGatewayOwner,
    now: number,
    session: ClientSession,
  ) {
    if (owner.applicationId !== fence.applicationId) return null;
    if (!(await touchDiscordGatewayOwner(mongoose, { ...owner, tenantId: tenant() }, session)))
      return null;
    const record = await inbox
      .findOne(live(fence, owner, now))
      .select('+action +encryptedToken +encryptedReply')
      .session(session)
      .lean();
    if (!record) return null;
    const textCommand =
      record.routing !== 'inspection' &&
      !record.thread &&
      ['ask', 'status', 'review', 'decide'].includes(record.action?.kind ?? '');
    if (record.routing !== 'inspection' && !record.thread && !textCommand) return null;
    if (
      textCommand &&
      !record.dm &&
      !(await touchChannelAuthority(
        mongoose,
        {
          tenantId: tenant(),
          provider: 'discord',
          channelId: record.channelId,
          channelRevision: record.channelRevision,
          agentId: record.agentId,
          applicationId: record.applicationId,
          applicationRevision: record.applicationRevision,
          guildId: record.guildId,
          externalChannelId: record.externalChannelId,
          now,
        },
        session,
      ))
    )
      return null;
    if (
      record.routing !== 'inspection' &&
      record.dm &&
      !(await touchDiscordDmInbox(mongoose, record, now, session))
    )
      return null;
    if (
      record.routing === 'inspection' &&
      !(await touchDiscordInstallation(
        mongoose,
        {
          tenantId: tenant(),
          applicationId: record.applicationId,
          expectedApplicationRevision: record.applicationRevision,
          guildId: record.guildId,
          installationId: record.installationId,
          expectedRevision: record.installationRevision,
        },
        session,
      ))
    )
      return null;
    if (
      record.routing !== 'inspection' &&
      record.thread &&
      !(await touchDiscordThreadBinding(mongoose, { ...record, thread: record.thread }, session))
    )
      return null;
    return record;
  }
  return {
    inspect: (fence, owner, now) =>
      withRequiredTransaction(mongoose, (session) => owned(fence, owner, now, session)),
    async resolve(fence, owner, input, expected, now) {
      const source = discordGuildThreadSourceSchema.parse(input);
      const route = discordThreadRouteSchema.parse(expected);
      return withRequiredTransaction(mongoose, async (session) => {
        const record = await owned(fence, owner, now, session);
        if (!record || record.state !== 'processing' || record.inspectionEpoch === fence.epoch)
          return stale();
        if (
          record.dm !== undefined ||
          (route.tenantId || undefined) !== tenant() ||
          source.applicationId !== record.applicationId ||
          source.guildId !== record.guildId ||
          source.threadChannelId !== record.externalChannelId ||
          source.authorId !== record.externalUserId ||
          route.applicationId !== record.applicationId ||
          route.guildId !== record.guildId ||
          route.threadChannelId !== record.externalChannelId ||
          route.botUserId !== source.botUserId ||
          route.parentChannelId !== source.parentChannelId ||
          route.threadType !== source.threadType ||
          (record.routing === 'inspection' &&
            (route.installationId !== record.installationId ||
              route.installationRevision !== record.installationRevision)) ||
          (record.routing !== 'inspection' &&
            (record.channelId !== route.channelId ||
              record.channelRevision !== route.channelRevision ||
              record.thread?.parentChannelId !== route.parentChannelId ||
              record.thread?.mappingRevision !== route.mappingRevision)) ||
          !(await touchDiscordThreadRoute(
            mongoose,
            {
              tenantId: tenant(),
              owner,
              channelId: route.channelId,
              channelRevision: route.channelRevision,
              mappingRevision: route.mappingRevision,
              externalChannelId: record.externalChannelId,
              externalUserId: record.externalUserId,
              source,
            },
            session,
          ))
        )
          return changed();
        const channel = await createAgentChannelModel(mongoose)
          .findOne({
            tenantId: tenant() ?? null,
            channelId: route.channelId,
            revision: route.channelRevision,
            type: 'discord',
            status: 'active',
          })
          .select('agentId')
          .session(session)
          .lean();
        if (!channel) return changed();
        const updated = await inbox
          .findOneAndUpdate(
            {
              ...live(fence, owner, now),
              state: 'processing',
              inspectionEpoch: { $ne: fence.epoch },
            },
            {
              $set: {
                routing: 'bound',
                channelId: route.channelId,
                channelRevision: route.channelRevision,
                agentId: channel.agentId,
                thread: {
                  parentChannelId: route.parentChannelId,
                  mappingRevision: route.mappingRevision,
                },
                inspectionEpoch: fence.epoch,
              },
            },
            { new: true, session },
          )
          .select('+action +encryptedToken +encryptedReply')
          .lean();
        if (!updated || updated.routing === 'inspection') return stale();
        return { ok: true, value: updated };
      });
    },
    async resolveText(fence, owner, input, now) {
      const source = discordGuildTextActorSourceSchema.parse(input);
      return withRequiredTransaction(mongoose, async (session) => {
        const record = await owned(fence, owner, now, session);
        if (
          !record ||
          record.routing === 'inspection' ||
          record.thread ||
          record.state !== 'processing' ||
          !['ask', 'status', 'review', 'decide'].includes(record.action?.kind ?? '') ||
          record.inspectionEpoch === fence.epoch
        )
          return stale();
        const parent = await createAgentChannelModel(mongoose)
          .findOne({
            tenantId: tenant() ?? null,
            channelId: record.channelId,
            revision: record.channelRevision,
            type: 'discord',
            status: 'active',
          })
          .select('discord.botUserId')
          .session(session)
          .lean();
        if (
          !discordGuildTextActorUsable(source) ||
          !parent ||
          source.applicationId !== record.applicationId ||
          source.guildId !== (record.dm?.source.guildId ?? record.guildId) ||
          source.channelId !== (record.dm?.parentChannelId ?? record.externalChannelId) ||
          source.authorId !== record.externalUserId ||
          source.botUserId !== parent.discord?.botUserId
        )
          return changed();
        const updated = await inbox
          .findOneAndUpdate(
            {
              ...live(fence, owner, now),
              state: 'processing',
              inspectionEpoch: { $ne: fence.epoch },
            },
            { $set: { inspectionEpoch: fence.epoch } },
            { new: true, session },
          )
          .select('+action +encryptedToken +encryptedReply')
          .lean();
        return updated && updated.routing !== 'inspection' ? { ok: true, value: updated } : stale();
      });
    },
    async unavailable(fence, owner, encryptedReply, now) {
      if (!encryptedReply || encryptedReply.length > 131072)
        throw new TypeError('Invalid Discord private reply');
      return withRequiredTransaction(mongoose, async (session) => {
        const record = await owned(fence, owner, now, session);
        if (!record) return stale();
        if (record.state === 'reply') return { ok: true, value: record };
        if (record.inspectionEpoch === fence.epoch) return stale();
        const updated = await inbox
          .findOneAndUpdate(
            {
              ...live(fence, owner, now),
              state: 'processing',
              inspectionEpoch: { $ne: fence.epoch },
            },
            {
              $set: { state: 'reply', encryptedReply, inspectionEpoch: fence.epoch },
            },
            { new: true, session },
          )
          .select('+action +encryptedToken +encryptedReply')
          .lean();
        return updated ? { ok: true, value: updated } : stale();
      });
    },
  };
}
