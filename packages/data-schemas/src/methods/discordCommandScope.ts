import {
  channelRunAdmissionSchema,
  discordDmInboxReferenceSchema,
  channelSnowflakeSchema,
} from 'librechat-data-provider';
import type { ChannelRunAdmission } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordInboxRecord } from '~/models/discordInbox';
import { touchDiscordDmDestination } from './discordDm';

/** One physical scope is used by admission, private controls and reply fencing. */
export function discordCommandAdmission(
  record: Pick<
    DiscordInboxRecord,
    | 'applicationId'
    | 'eventId'
    | 'externalUserId'
    | 'externalChannelId'
    | 'guildId'
    | 'thread'
    | 'dm'
  >,
  input = 'control',
): ChannelRunAdmission | null {
  const dm = record.dm;
  if (
    dm !== undefined &&
    (!discordDmInboxReferenceSchema.safeParse(dm).success ||
      record.guildId !== undefined ||
      record.thread)
  )
    return null;
  const conversation =
    dm?.confirmationEventId ?? (record.thread ? record.externalChannelId : record.eventId);
  let discordDestination: ChannelRunAdmission['discordDestination'];
  if (dm)
    discordDestination = {
      kind: 'dm',
      parentChannelId: dm.parentChannelId,
      selectionId: dm.selectionId,
      selectionRevision: dm.selectionRevision,
    };
  else if (record.thread) discordDestination = { kind: 'guild_thread', ...record.thread };
  const parsed = channelRunAdmissionSchema.safeParse({
    actor: {
      provider: 'discord',
      applicationId: record.applicationId,
      externalUserId: record.externalUserId,
      ...(dm
        ? { scope: 'dm', selectionId: dm.selectionId, selectionRevision: dm.selectionRevision }
        : { guildId: record.guildId }),
    },
    eventId: record.eventId,
    input,
    externalChannelId: record.externalChannelId,
    externalThreadKey: `${record.externalChannelId}:${conversation}`,
    externalMessageKey: `${record.externalChannelId}:${record.eventId}`,
    ...(discordDestination ? { discordDestination } : {}),
  });
  return parsed.success ? parsed.data : null;
}

/** A DM inbox row has no independent grant: rejoin its exact selected real source. */
export async function touchDiscordDmInbox(
  mongoose: typeof import('mongoose'),
  record: Pick<
    DiscordInboxRecord,
    | 'tenantId'
    | 'channelId'
    | 'channelRevision'
    | 'agentId'
    | 'applicationRevision'
    | 'applicationId'
    | 'eventId'
    | 'externalUserId'
    | 'externalChannelId'
    | 'guildId'
    | 'thread'
    | 'dm'
  >,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  const admission = discordCommandAdmission(record);
  const dm = record.dm;
  if (
    !dm ||
    !admission ||
    !channelSnowflakeSchema.safeParse(record.eventId).success ||
    BigInt(record.eventId) <= BigInt(dm.confirmationEventId) ||
    dm.source.applicationId !== record.applicationId ||
    dm.source.externalUserId !== record.externalUserId ||
    dm.source.channelId !== record.channelId ||
    dm.source.channelRevision !== record.channelRevision ||
    dm.source.agentId !== record.agentId
  )
    return false;
  return touchDiscordDmDestination(
    mongoose,
    {
      tenantId: record.tenantId,
      channelId: record.channelId,
      agentId: record.agentId,
      principal: {
        userId: dm.source.userId,
        linkId: dm.source.linkId,
        linkRevision: dm.source.linkRevision,
        channelRevision: record.channelRevision,
      },
      admission,
      applicationRevision: record.applicationRevision,
      expectedSource: dm.source,
      now,
    },
    session,
  );
}
