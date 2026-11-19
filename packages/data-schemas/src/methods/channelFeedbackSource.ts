import type {
  ChannelFeedbackActor,
  ChannelReplyMapping,
  SlackChannelReplyMapping,
  DiscordChannelReplyMapping,
} from 'librechat-data-provider';
import type { ClientSession, FilterQuery } from 'mongoose';
import type { ChannelRunRecord } from '~/models/channelRun';
import { channelFeedbackProviderFilter } from './channelFeedbackProtocol';
import { SERVER_AUTHORED_MESSAGE_FILTER } from '~/utils/authored';
import { assertChannelTenant } from './channelScope';

type ReplySource<T extends ChannelReplyMapping> = Omit<
  T,
  'traceId' | 'centralTraceExportEnabled'
> & { langfuseRunId?: string; centralTraceExportEnabled?: boolean };
export type ChannelFeedbackReplySource =
  | ReplySource<SlackChannelReplyMapping>
  | ReplySource<DiscordChannelReplyMapping>;

/** Match a confirmed receipt to its immutable required answer part, excluding progress and diagnostics. */
export function discordFeedbackDeliveryFilter(
  externalMessageKey: string,
): FilterQuery<ChannelRunRecord> {
  const receipts = {
    $map: {
      input: {
        $filter: {
          input: { $ifNull: ['$receipts', []] },
          as: 'receipt',
          cond: {
            $and: [
              { $eq: ['$$receipt.outcome', 'confirmed'] },
              { $eq: ['$$receipt.externalMessageKey', externalMessageKey] },
            ],
          },
        },
      },
      as: 'receipt',
      in: '$$receipt.operationId',
    },
  };
  const parts = {
    $map: {
      input: {
        $filter: {
          input: { $ifNull: ['$plan.parts', []] },
          as: 'part',
          cond: {
            $and: [
              { $eq: ['$$part.kind', 'message'] },
              { $eq: ['$$part.required', true] },
              { $eq: [{ $ifNull: ['$$part.traceUrl', null] }, null] },
            ],
          },
        },
      },
      as: 'part',
      in: '$$part.operationId',
    },
  };
  return { $expr: { $gt: [{ $size: { $setIntersection: [receipts, parts] } }, 0] } };
}

/** Dedicated metadata projection for feedback on a delivered reply; never exposes history or credentials. */
export async function readChannelFeedbackReplySource(
  mongoose: typeof import('mongoose'),
  actor: ChannelFeedbackActor,
  externalMessageKey: string,
  session?: ClientSession,
): Promise<ChannelFeedbackReplySource | null> {
  assertChannelTenant(actor.tenantId);
  const query = mongoose.model('ChannelRun').aggregate<ChannelFeedbackReplySource>([
    {
      $match: {
        tenantId: actor.tenantId,
        channelId: actor.channelId,
        agentId: actor.agentId,
        state: 'delivered',
        'principal.channelRevision': actor.channelRevision,
        ...channelFeedbackProviderFilter(actor, 'admission.actor.'),
        ...(actor.provider === 'discord'
          ? {
              'principal.linkId': { $type: 'string', $ne: '' },
              'principal.linkRevision': { $type: 'string', $ne: '' },
            }
          : {}),
        'execution.protocol': 'responses',
        'snapshot.responseId': { $type: 'string', $ne: '' },
        $and: [
          { $expr: { $eq: ['$execution.responseId', '$snapshot.responseId'] } },
          ...(actor.provider === 'discord'
            ? [discordFeedbackDeliveryFilter(externalMessageKey)]
            : []),
        ],
        receipts: { $elemMatch: { outcome: 'confirmed', externalMessageKey } },
      },
    },
    { $limit: 2 },
    {
      $lookup: {
        // Collection metadata only; the joined message has explicit owner and tenant predicates.
        // eslint-disable-next-line no-restricted-syntax
        from: mongoose.model('Message').collection.name,
        let: {
          user: '$principal.userId',
          conversationId: '$execution.conversationId',
          messageId: '$snapshot.responseId',
        },
        pipeline: [
          {
            $match: {
              tenantId: actor.tenantId === '_' ? { $in: [null, ''] } : actor.tenantId,
              ...SERVER_AUTHORED_MESSAGE_FILTER,
              $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
              $expr: {
                $and: [
                  { $eq: ['$user', '$$user'] },
                  { $eq: ['$conversationId', '$$conversationId'] },
                  { $eq: ['$messageId', '$$messageId'] },
                ],
              },
            },
          },
          { $limit: 1 },
          {
            $project: {
              _id: 0,
              messageId: 1,
              langfuseRunId: 1,
              langfuseCentralTraceExportEnabled: 1,
              langfuseSampled: 1,
              langfuseDestinationIds: 1,
              isTemporary: 1,
            },
          },
        ],
        as: 'message',
      },
    },
    { $unwind: { path: '$message', preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 0,
        tenantId: 1,
        channelId: 1,
        channelRevision: '$principal.channelRevision',
        ...(actor.provider === 'discord'
          ? {
              provider: { $literal: 'discord' },
              applicationId: '$admission.actor.applicationId',
              guildId: '$admission.actor.guildId',
              externalChannelId: '$admission.externalChannelId',
              externalUserId: '$admission.actor.externalUserId',
              linkId: '$principal.linkId',
              linkRevision: '$principal.linkRevision',
            }
          : { teamId: '$admission.actor.teamId' }),
        agentId: 1,
        externalMessageKey: { $literal: externalMessageKey },
        runId: 1,
        responseId: '$snapshot.responseId',
        messageId: '$message.messageId',
        conversationId: '$execution.conversationId',
        principalId: '$principal.userId',
        langfuseRunId: '$message.langfuseRunId',
        isTemporary: '$message.isTemporary',
        centralTraceExportEnabled: '$message.langfuseCentralTraceExportEnabled',
        sampled: '$message.langfuseSampled',
        destinationIds: '$message.langfuseDestinationIds',
      },
    },
  ]);
  if (session) query.session(session);
  const rows = await query;
  const source = rows.length === 1 ? rows[0] : null;
  return source?.messageId === source?.responseId && source?.messageId ? source : null;
}
