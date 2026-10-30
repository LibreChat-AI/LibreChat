import type { ChannelFeedbackActor, ChannelReplyMapping } from 'librechat-data-provider';
import { assertChannelTenant } from './channelScope';

export type ChannelFeedbackReplySource = Omit<
  ChannelReplyMapping,
  'traceId' | 'centralTraceExportEnabled'
> & { langfuseRunId?: string };

/** Dedicated metadata projection for feedback on a delivered reply; never exposes history or credentials. */
export async function readChannelFeedbackReplySource(
  mongoose: typeof import('mongoose'),
  actor: ChannelFeedbackActor,
  externalMessageKey: string,
): Promise<ChannelFeedbackReplySource | null> {
  assertChannelTenant(actor.tenantId);
  const rows = await mongoose.model('ChannelRun').aggregate<ChannelFeedbackReplySource>([
    {
      $match: {
        tenantId: actor.tenantId,
        channelId: actor.channelId,
        agentId: actor.agentId,
        state: 'delivered',
        'principal.channelRevision': actor.channelRevision,
        'admission.actor.teamId': actor.teamId,
        'execution.protocol': 'responses',
        'snapshot.responseId': { $type: 'string', $ne: '' },
        $expr: { $eq: ['$execution.responseId', '$snapshot.responseId'] },
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
              isCreatedByUser: false,
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
        teamId: '$admission.actor.teamId',
        agentId: 1,
        externalMessageKey: { $literal: externalMessageKey },
        runId: 1,
        responseId: '$snapshot.responseId',
        messageId: '$message.messageId',
        conversationId: '$execution.conversationId',
        principalId: '$principal.userId',
        langfuseRunId: '$message.langfuseRunId',
        isTemporary: '$message.isTemporary',
        sampled: '$message.langfuseSampled',
        destinationIds: '$message.langfuseDestinationIds',
      },
    },
  ]);
  const source = rows.length === 1 ? rows[0] : null;
  return source?.messageId === source?.responseId && source?.messageId ? source : null;
}
