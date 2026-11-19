import { z } from 'zod';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import type { DiscordGatewayOwner } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import { createDiscordMessageReceiptModel } from '~/models/discordMessage';
import { getTenantId, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { withRequiredTransaction } from '~/utils/transactions';
import { touchDiscordGatewayOwner } from './discordGateway';
import { createChannelIndexGate } from './channelIndexes';
import { touchChannelAuthority } from './channelScope';
import { ChannelRunConflict } from './channelProtocol';

export interface DiscordMessageOccurrence {
  applicationId: string;
  messageId: string;
  fingerprint: string;
  purgeAt: number;
}
export interface DiscordMessageRoute {
  channelId: string;
  agentId: string;
  channelRevision: string;
  guildId: string;
  externalChannelId: string;
}
export interface DiscordMessageStorage {
  ignore(
    owner: DiscordGatewayOwner,
    occurrence: DiscordMessageOccurrence,
    route?: DiscordMessageRoute,
  ): Promise<'ignored' | 'duplicate'>;
}
const occurrenceSchema = z
  .object({
    applicationId: channelSnowflakeSchema,
    messageId: channelSnowflakeSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    purgeAt: z.number().int().positive(),
  })
  .strict();
/** Called in the existing run-admission transaction, before allocating a lane or inserting a run. */
export async function assertDiscordMessageUnused(
  mongoose: typeof import('mongoose'),
  occurrence: DiscordMessageOccurrence,
  session: ClientSession,
): Promise<void> {
  occurrenceSchema.parse(occurrence);
  const previous = await createDiscordMessageReceiptModel(mongoose)
    .findOne({ applicationId: occurrence.applicationId, messageId: occurrence.messageId })
    .session(session)
    .lean();
  if (previous)
    throw new ChannelRunConflict(
      previous.fingerprint === occurrence.fingerprint ? 'event_consumed' : 'event_conflict',
    );
}
export async function recordDiscordMessage(
  mongoose: typeof import('mongoose'),
  occurrence: DiscordMessageOccurrence,
  outcome: 'admitted' | 'ignored',
  session: ClientSession,
): Promise<void> {
  occurrenceSchema.parse(occurrence);
  await createDiscordMessageReceiptModel(mongoose).create(
    [{ ...occurrence, outcome, purgeAt: new Date(occurrence.purgeAt) }],
    { session },
  );
}
/** Ignores eligible messages durably; activation of a later link never revives their prompts. */
export function createDiscordMessageStorage(
  mongoose: typeof import('mongoose'),
): DiscordMessageStorage {
  const receipts = createDiscordMessageReceiptModel(mongoose);
  const indexes = createChannelIndexGate(() => [receipts]);
  return {
    ignore: async (owner, occurrence, route) => {
      occurrenceSchema.parse(occurrence);
      const tenantId = getTenantId();
      if (tenantId === SYSTEM_TENANT_ID || owner.applicationId !== occurrence.applicationId)
        throw new TypeError('Invalid Discord message authority');
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await touchDiscordGatewayOwner(mongoose, { ...owner, tenantId }, session)))
            throw new ChannelRunConflict('stale_fence');
          if (
            route &&
            !(await touchChannelAuthority(
              mongoose,
              {
                ...route,
                tenantId,
                provider: 'discord',
                applicationId: owner.applicationId,
                applicationRevision: owner.applicationRevision,
              },
              session,
            ))
          )
            throw new ChannelRunConflict('invalid_transition');
          const previous = await receipts
            .findOne({ applicationId: occurrence.applicationId, messageId: occurrence.messageId })
            .session(session)
            .lean();
          if (previous) {
            if (previous.fingerprint !== occurrence.fingerprint)
              throw new ChannelRunConflict('event_conflict');
            return 'duplicate' as const;
          }
          await recordDiscordMessage(mongoose, occurrence, 'ignored', session);
          return 'ignored' as const;
        },
        indexes,
      );
    },
  };
}
