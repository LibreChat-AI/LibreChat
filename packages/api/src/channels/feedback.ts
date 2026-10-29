import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import type {
  ChannelFeedbackActor,
  ChannelFeedbackResult,
  ChannelFeedbackView,
  ChannelReactionEvent,
  ChannelReplyMapping,
  ChannelRating,
  ChannelFeedbackVote,
} from 'librechat-data-provider';
import type {
  ChannelFeedbackStorage,
  ChannelFeedbackLedger,
  ChannelFeedbackEventRecord,
} from '@librechat/data-schemas';
import type { SendFeedbackScoreParams } from '~/langfuse/feedback';

export interface ChannelFeedbackDependencies {
  storage: ChannelFeedbackStorage;
  /** Includes deployment feedback flag and live channel/tenant/revision checks. */
  canRecord: (actor: ChannelFeedbackActor) => Promise<boolean>;
  /** Resolves persisted run ownership and canonical message/trace provenance, not supplied IDs. */
  resolveReply: (
    actor: ChannelFeedbackActor,
    runId: string,
    externalMessageKey: string,
  ) => Promise<ChannelReplyMapping | null>;
  /** Host supplies effective appConfig and current export policy; must honor input.signal. */
  sendScore: (input: SendFeedbackScoreParams, mapping: ChannelReplyMapping) => Promise<void>;
  maxConflictRetries: number;
  exportTimeoutMs: number;
  exportLeaseMs: number;
  exportRetryMs: number;
  now?: () => number;
}

export const channelReactionSchema: z.ZodType<ChannelReactionEvent> = z
  .object({
    eventId: z.string().min(1).max(256),
    eventTimestampUs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    externalMessageKey: z.string().min(1).max(256),
    externalUserId: z.string().min(1).max(128),
    reaction: z.string().min(1).max(128),
    action: z.enum(['added', 'removed']),
  })
  .strict();
const digest = (value: readonly (string | number | boolean)[]): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = <T>(
  code: Extract<ChannelFeedbackResult<T>, { ok: false }>['error']['code'],
): ChannelFeedbackResult<T> => ({ ok: false, error: { code } });

export function normalizeChannelRating(reaction: string): ChannelRating | null {
  const name = reaction.replace(/::skin-tone-[2-6]$/, '');
  if (name === '+1' || name === 'thumbsup') return 'thumbsUp';
  if (name === '-1' || name === 'thumbsdown') return 'thumbsDown';
  return null;
}

function later(
  a: Pick<ChannelFeedbackVote, 'eventTimestampUs' | 'eventId'>,
  b: Pick<ChannelFeedbackVote, 'eventTimestampUs' | 'eventId'>,
): boolean {
  return (
    a.eventTimestampUs > b.eventTimestampUs ||
    (a.eventTimestampUs === b.eventTimestampUs && a.eventId > b.eventId)
  );
}

/** Independent message slots preserve a rating when one of several overflow reactions is removed. */
export function projectChannelReaction(
  votes: ChannelFeedbackVote[],
  event: ChannelReactionEvent,
  rating: ChannelRating,
): { votes: ChannelFeedbackVote[]; rating: ChannelRating | null; changed: boolean } {
  const index = votes.findIndex(
    (vote) => vote.externalMessageKey === event.externalMessageKey && vote.rating === rating,
  );
  if (index >= 0 && !later(event, votes[index]))
    return { votes, rating: latestRating(votes), changed: false };
  const next = [...votes];
  const vote: ChannelFeedbackVote = {
    externalMessageKey: event.externalMessageKey,
    rating,
    active: event.action === 'added',
    eventId: event.eventId,
    eventTimestampUs: event.eventTimestampUs,
  };
  if (index < 0) next.push(vote);
  else next[index] = vote;
  return { votes: next, rating: latestRating(next), changed: true };
}

function latestRating(votes: ChannelFeedbackVote[]): ChannelRating | null {
  let latest: ChannelFeedbackVote | undefined;
  for (const vote of votes) if (vote.active && (!latest || later(vote, latest))) latest = vote;
  return latest?.rating ?? null;
}

function matches(actor: ChannelFeedbackActor, mapping: ChannelReplyMapping): boolean {
  return (
    actor.tenantId === mapping.tenantId &&
    actor.channelId === mapping.channelId &&
    actor.channelRevision === mapping.channelRevision &&
    actor.teamId === mapping.teamId &&
    actor.agentId === mapping.agentId
  );
}

function response(record: ChannelFeedbackLedger): ChannelFeedbackView {
  return {
    messageId: record.mapping.messageId,
    conversationId: record.mapping.conversationId,
    feedback: record.rating ? { rating: record.rating } : null,
    ignored: false,
  };
}

export function createChannelFeedbackService(deps: ChannelFeedbackDependencies) {
  const now = deps.now ?? Date.now;
  if (
    ![deps.maxConflictRetries, deps.exportTimeoutMs, deps.exportLeaseMs, deps.exportRetryMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    deps.exportLeaseMs <= deps.exportTimeoutMs
  ) {
    throw new Error(
      'Channel feedback requires positive limits and an export lease longer than its timeout',
    );
  }
  async function project(
    record: ChannelFeedbackEventRecord,
  ): Promise<ChannelFeedbackResult<ChannelFeedbackView>> {
    let ledger = await deps.storage.ensureChannelFeedback({
      tenantId: record.tenantId,
      key: record.ledgerKey,
      mapping: record.mapping,
      externalUserId: record.event.externalUserId,
      scoreId: `channel-feedback-${record.ledgerKey}`,
      votes: [],
      revision: 0,
      rating: null,
      exportStatus: 'sent',
      retryAtMs: 0,
    });
    for (let attempt = 0; attempt < deps.maxConflictRetries; attempt++) {
      const next = projectChannelReaction(ledger.votes, record.event, record.rating);
      if (!next.changed) {
        await deps.storage.markChannelFeedbackEvent(record);
        return { ok: true, value: response(ledger) };
      }
      const updated: ChannelFeedbackLedger = {
        ...ledger,
        votes: next.votes,
        rating: next.rating,
        revision: ledger.revision + 1,
        exportStatus: 'pending',
      };
      if (await deps.storage.saveChannelFeedback(updated, ledger.revision)) {
        await deps.storage.markChannelFeedbackEvent(record);
        return { ok: true, value: response(updated) };
      }
      const current = await deps.storage.getChannelFeedback(record.tenantId, record.ledgerKey);
      if (!current) throw new Error('Channel feedback ledger disappeared during projection');
      ledger = current;
    }
    return failure('changed');
  }
  return {
    async mapReply(
      actor: ChannelFeedbackActor,
      runId: string,
      externalMessageKey: string,
    ): Promise<ChannelFeedbackResult<ChannelReplyMapping>> {
      if (!(await deps.canRecord(actor))) return failure('forbidden');
      const mapping = await deps.resolveReply(actor, runId, externalMessageKey);
      if (
        !mapping ||
        !matches(actor, mapping) ||
        mapping.runId !== runId ||
        mapping.externalMessageKey !== externalMessageKey
      )
        return failure('mapping_not_found');
      const stored = await deps.storage.putChannelReply(mapping);
      if (
        !matches(actor, stored) ||
        stored.runId !== runId ||
        stored.responseId !== mapping.responseId ||
        stored.messageId !== mapping.messageId ||
        stored.principalId !== mapping.principalId
      )
        return failure('event_conflict');
      return { ok: true, value: stored };
    },
    async record(
      actor: ChannelFeedbackActor,
      input: ChannelReactionEvent,
    ): Promise<ChannelFeedbackResult<ChannelFeedbackView>> {
      const parsed = channelReactionSchema.safeParse(input);
      if (!parsed.success) return failure('invalid_reaction');
      if (!(await deps.canRecord(actor))) return failure('forbidden');
      const event = parsed.data;
      const rating = normalizeChannelRating(event.reaction);
      if (!rating)
        return {
          ok: true,
          value: { messageId: '', conversationId: '', feedback: null, ignored: true },
        };
      const mapping = await deps.storage.getChannelReply(actor, event.externalMessageKey);
      if (!mapping) return failure('mapping_not_found');
      const ledgerKey = digest([
        actor.tenantId,
        actor.channelId,
        actor.channelRevision,
        actor.teamId,
        mapping.runId,
        event.externalUserId,
      ]);
      const eventDigest = digest([
        actor.channelRevision,
        actor.teamId,
        actor.agentId,
        event.eventId,
        event.eventTimestampUs,
        event.externalMessageKey,
        event.externalUserId,
        event.reaction,
        event.action,
      ]);
      const admitted = await deps.storage.admitChannelFeedbackEvent({
        tenantId: actor.tenantId,
        channelId: actor.channelId,
        eventId: event.eventId,
        digest: eventDigest,
        ledgerKey,
        event,
        mapping,
        rating,
        processed: false,
      });
      if (admitted.digest !== eventDigest) return failure('event_conflict');
      return project(admitted);
    },
    /** Recover accepted receipts after a process exits between admission and projection. */
    async recover(tenantId: string, limit: number): Promise<number> {
      const events = await deps.storage.pendingChannelFeedbackEvents(tenantId, limit);
      for (const event of events) await project(event);
      return events.length;
    },
    /** Durable retry state is not tied to the incoming Slack request's lifetime. */
    async flush(tenantId: string, limit: number): Promise<number> {
      const pending = await deps.storage.pendingChannelFeedbackExports(tenantId, now(), limit);
      let processed = 0;
      for (const candidate of pending) {
        const leaseId = randomUUID();
        const record = await deps.storage.claimChannelFeedbackExport(
          tenantId,
          candidate.key,
          leaseId,
          now(),
          now() + deps.exportLeaseMs,
        );
        if (!record) continue;
        processed += 1;
        let success = false;
        try {
          const enabled = await deps.canRecord(record.mapping);
          if (!enabled) continue;
          await deps.sendScore(
            {
              scoreId: record.scoreId,
              traceId: record.mapping.traceId,
              isTemporary: record.mapping.isTemporary,
              sampled: record.mapping.sampled,
              destinationIds: record.mapping.destinationIds,
              centralTraceExportEnabled: record.mapping.centralTraceExportEnabled,
              feedback: record.rating ? { rating: record.rating } : null,
              metadata: {
                source: 'channel',
                channelId: record.mapping.channelId,
                messageId: record.mapping.messageId,
                conversationId: record.mapping.conversationId,
                actorId: record.key,
                channelFeedbackRevision: record.revision,
              },
              signal: AbortSignal.timeout(deps.exportTimeoutMs),
            },
            record.mapping,
          );
          success = true;
        } finally {
          await deps.storage.finishChannelFeedbackExport(
            record,
            leaseId,
            success,
            now() + (success ? 0 : deps.exportRetryMs),
          );
        }
      }
      return processed;
    },
  };
}
