import { channelSnowflakeSchema, discordIngressActionSchema } from 'librechat-data-provider';
import type {
  DiscordChannelReplyMapping,
  ChannelFeedbackResult,
  ChannelFeedbackView,
  ChannelFeedbackVote,
} from 'librechat-data-provider';
import type { ChannelFeedbackLedger, ChannelFeedbackEventRecord } from '~/models/channelFeedback';
import type { DiscordInboxRecord } from '~/models/discordInbox';
import type { DiscordCommandScope } from './discordCommands';
import {
  createChannelReplyModel,
  createChannelFeedbackModel,
  createChannelFeedbackEventModel,
} from '~/models/channelFeedback';
import {
  withChannelFeedbackAuthority,
  sameFeedbackSource,
  ChannelFeedbackAuthorityError,
} from './channelFeedbackScope';
import {
  pinFeedbackCheckpoint,
  acknowledgeFeedbackReceipt,
  feedbackCheckpoint,
} from './channelFeedbackCheckpoint';
import {
  channelFeedbackProviderFilter,
  isLaterChannelFeedbackEvent,
} from './channelFeedbackProtocol';
import { discordCommandAdmission, touchDiscordCommandAuthority } from './discordCommands';
import { createDiscordInboxModel } from '~/models/discordInbox';
import { createChannelIndexGate } from './channelIndexes';
import { touchDiscordInbox } from './discordInboxScope';
import { digest } from './channelProtocol';

const failure = (
  code: 'forbidden' | 'event_conflict',
): ChannelFeedbackResult<ChannelFeedbackView> => ({ ok: false, error: { code } });

function matchesScope(record: DiscordInboxRecord, mapping: DiscordChannelReplyMapping): boolean {
  if (!discordCommandAdmission(record)) return false;
  return record.dm
    ? mapping.scope === 'dm' &&
        mapping.selectionId === record.dm.selectionId &&
        mapping.selectionRevision === record.dm.selectionRevision &&
        mapping.sourceGuildId === record.dm.source.guildId &&
        mapping.parentChannelId === record.dm.parentChannelId &&
        mapping.confirmationEventId === record.dm.confirmationEventId &&
        record.dm.source.userId === mapping.principalId &&
        record.dm.source.linkId === mapping.linkId &&
        record.dm.source.linkRevision === mapping.linkRevision
    : mapping.scope === undefined && mapping.guildId === record.guildId;
}
/** One occurrence, one replaceable vote slot and one existing durable export ledger. */
export function createDiscordFeedbackRecorder(
  mongoose: typeof import('mongoose'),
): (
  scope: DiscordCommandScope,
  mapping: DiscordChannelReplyMapping,
  now: number,
) => Promise<ChannelFeedbackResult<ChannelFeedbackView>> {
  const inbox = createDiscordInboxModel(mongoose);
  const replies = createChannelReplyModel(mongoose);
  const events = createChannelFeedbackEventModel(mongoose);
  const ledgers = createChannelFeedbackModel(mongoose);
  const ready = createChannelIndexGate(() => [inbox, replies, events, ledgers]);
  return async (scope, mapping, now) => {
    const { record, fence, principal } = scope;
    if (!Number.isSafeInteger(now) || now < 0)
      throw new TypeError('Invalid Discord feedback clock');
    if (
      mapping.provider !== 'discord' ||
      mapping.tenantId !== (record.tenantId || '_') ||
      mapping.channelId !== record.channelId ||
      mapping.channelRevision !== record.channelRevision ||
      mapping.agentId !== record.agentId ||
      mapping.applicationId !== record.applicationId ||
      !matchesScope(record, mapping) ||
      mapping.externalChannelId !== record.externalChannelId ||
      mapping.externalUserId !== record.externalUserId ||
      mapping.principalId !== principal.userId ||
      mapping.linkId !== principal.linkId ||
      mapping.linkRevision !== principal.linkRevision ||
      principal.channelRevision !== mapping.channelRevision ||
      fence.eventId !== record.eventId ||
      fence.applicationId !== record.applicationId ||
      !channelSnowflakeSchema.safeParse(record.eventId).success
    )
      return failure('forbidden');
    await ready();
    try {
      return await withChannelFeedbackAuthority(mongoose, mapping, async (session, expiredAt) => {
        if (
          !(await touchDiscordInbox(mongoose, record, fence, now, session)) ||
          !(await touchDiscordCommandAuthority(mongoose, scope, now, session))
        )
          throw new ChannelFeedbackAuthorityError();
        // Read the canonical private action; caller-provided copies never choose a vote or run.
        const current = await inbox
          .findOne({
            tenantId: record.tenantId || null,
            applicationId: record.applicationId,
            eventId: record.eventId,
            leaseOwner: fence.owner,
            leaseEpoch: fence.epoch,
            state: 'processing',
          })
          .select('+action')
          .session(session)
          .lean();
        const parsedAction = discordIngressActionSchema.safeParse(current?.action);
        const action = parsedAction.success ? parsedAction.data : null;
        if (
          !current ||
          current.routing === 'inspection' ||
          action?.kind !== 'feedback' ||
          action.reference !== mapping.runId ||
          `${current.externalChannelId}:${action.messageId}` !== mapping.externalMessageKey ||
          !matchesScope(current, mapping) ||
          current.channelRevision !== mapping.channelRevision ||
          current.agentId !== mapping.agentId ||
          current.externalChannelId !== mapping.externalChannelId ||
          !channelSnowflakeSchema.safeParse(action.messageId).success
        )
          throw new ChannelFeedbackAuthorityError();
        const sourceScope =
          mapping.scope === 'dm'
            ? {
                scope: mapping.scope,
                selectionId: mapping.selectionId,
                selectionRevision: mapping.selectionRevision,
                sourceGuildId: mapping.sourceGuildId,
                parentChannelId: mapping.parentChannelId,
                confirmationEventId: mapping.confirmationEventId,
                externalChannelId: mapping.externalChannelId,
              }
            : mapping.guildId;
        const key = digest([
          'discord',
          mapping.tenantId,
          mapping.channelId,
          mapping.channelRevision,
          mapping.applicationId,
          sourceScope,
          mapping.runId,
          mapping.externalUserId,
        ]);
        const event: ChannelFeedbackEventRecord = {
          tenantId: mapping.tenantId,
          channelId: mapping.channelId,
          eventId: current.eventId,
          ledgerKey: key,
          mapping,
          rating: action.rating,
          processed: false,
          digest: digest([
            'discord',
            mapping.channelRevision,
            mapping.applicationId,
            sourceScope,
            mapping.agentId,
            mapping.runId,
            mapping.principalId,
            mapping.linkId,
            mapping.linkRevision,
            current.eventId,
            mapping.externalMessageKey,
            mapping.externalUserId,
            action.rating,
          ]),
          event: {
            provider: 'discord',
            eventId: current.eventId,
            externalMessageKey: mapping.externalMessageKey,
            externalUserId: mapping.externalUserId,
            reaction: 'discord-button',
            action: 'replaced',
          },
        };
        const eventKey = {
          tenantId: event.tenantId,
          channelId: event.channelId,
          eventId: event.eventId,
        };
        const previous = await events.findOne(eventKey).session(session).lean();
        if (previous && previous.digest !== event.digest) return failure('event_conflict');
        const replyKey = {
          tenantId: mapping.tenantId,
          channelId: mapping.channelId,
          ...channelFeedbackProviderFilter(mapping),
          externalMessageKey: mapping.externalMessageKey,
        };
        await replies.updateOne(
          replyKey,
          { $setOnInsert: mapping, ...(expiredAt ? { $min: { expiredAt } } : {}) },
          { upsert: true, session },
        );
        const reply = await replies.findOne(replyKey).session(session).lean();
        if (!reply || !sameFeedbackSource(mapping, reply))
          throw new ChannelFeedbackAuthorityError();
        await ledgers.updateOne(
          { tenantId: mapping.tenantId, key },
          {
            $setOnInsert: {
              tenantId: mapping.tenantId,
              key,
              mapping: reply,
              externalUserId: mapping.externalUserId,
              scoreId: `channel-feedback-${key}`,
              scoreTimestamp: new Date(),
              votes: [],
              revision: 0,
              rating: null,
              exportStatus: 'sent',
              retryAtMs: 0,
            },
            ...(expiredAt ? { $min: { expiredAt } } : {}),
          },
          { upsert: true, session },
        );
        const ledger = await ledgers
          .findOne({ tenantId: mapping.tenantId, key })
          .session(session)
          .lean();
        if (
          !ledger ||
          !sameFeedbackSource(mapping, ledger.mapping) ||
          ledger.votes.length > 1 ||
          ledger.votes.some((vote) => vote.provider !== 'discord')
        )
          throw new ChannelFeedbackAuthorityError();
        // All parts share the same source response; keep the first canonical mapping for export.
        event.mapping = ledger.mapping;
        if (!previous)
          await events.create([{ ...event, ...(expiredAt ? { expiredAt } : {}) }], { session });
        const vote: ChannelFeedbackVote = {
          provider: 'discord',
          reaction: 'discord-button',
          externalMessageKey: mapping.externalMessageKey,
          rating: action.rating,
          active: true,
          eventId: current.eventId,
        };
        let projected: ChannelFeedbackLedger = ledger;
        if (!ledger.votes[0] || isLaterChannelFeedbackEvent(vote, ledger.votes[0])) {
          const ratingChanged = ledger.rating !== action.rating;
          projected = {
            ...ledger,
            votes: [vote],
            rating: action.rating,
            revision: ledger.revision + (ratingChanged ? 1 : 0),
            exportStatus: ratingChanged ? 'pending' : ledger.exportStatus,
            retryAtMs: ratingChanged ? 0 : ledger.retryAtMs,
          };
          const changed = await ledgers.updateOne(
            { tenantId: mapping.tenantId, key, revision: ledger.revision },
            {
              $set: {
                votes: projected.votes,
                rating: projected.rating,
                revision: projected.revision,
                exportStatus: projected.exportStatus,
                retryAtMs: projected.retryAtMs,
              },
            },
            { session },
          );
          if (changed.matchedCount !== 1)
            throw new Error('Discord feedback projection did not persist');
          await pinFeedbackCheckpoint(mongoose, projected, session);
        }
        await acknowledgeFeedbackReceipt(
          mongoose,
          previous ?? event,
          feedbackCheckpoint(projected),
          session,
        );
        return {
          ok: true,
          value: {
            messageId: mapping.messageId,
            conversationId: mapping.conversationId,
            feedback: projected.rating ? { rating: projected.rating } : null,
            ignored: false,
          },
        };
      });
    } catch (error) {
      if (error instanceof ChannelFeedbackAuthorityError) return failure('forbidden');
      throw error;
    }
  };
}
