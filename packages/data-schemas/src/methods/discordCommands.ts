import { z } from 'zod';
import type {
  ChannelRunPrincipal,
  ChannelRunState,
  DiscordInboxFence,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordInboxRecord, DiscordCancelResult } from '~/models/discordInbox';
import type { ChannelRunRecord } from '~/models/channelRun';
import { discordCommandAdmission } from './discordCommandScope';
import { channelRunActorScope } from './channelProvider';
export { discordCommandAdmission } from './discordCommandScope';
import { touchChannelDestinationBinding } from './channelDestination';
import { createDiscordInboxModel } from '~/models/discordInbox';
import { withRequiredTransaction } from '~/utils/transactions';
import { createChannelRunModel } from '~/models/channelRun';
import { touchChannelOwnerAdmission } from './channelOwner';
import { createChannelIndexGate } from './channelIndexes';
import { touchDiscordInbox } from './discordInboxScope';

export interface DiscordCommandScope {
  record: DiscordInboxRecord;
  fence: DiscordInboxFence;
  principal: ChannelRunPrincipal;
}
export interface DiscordCommandRun {
  runId: string;
  state: ChannelRunState;
  cancellationRequested: boolean;
  conversationId?: string;
  responseId?: string;
}
export type DiscordCommandResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'authority_changed' } };
const denied = (): { ok: false; error: { code: 'authority_changed' } } => ({
  ok: false,
  error: { code: 'authority_changed' },
});

export interface DiscordCommandStorage {
  reviewRun(
    scope: DiscordCommandScope,
    now: number,
    runId: string,
    messageId?: string,
  ): Promise<DiscordCommandResult<ChannelRunRecord | null>>;
  saveReview(
    scope: DiscordCommandScope,
    encryptedReview: string,
    now: number,
  ): Promise<DiscordCommandResult<string>>;
  updateReview(
    scope: DiscordCommandScope,
    reference: string,
    previous: string,
    next: string,
    now: number,
  ): Promise<boolean>;
  readReview(
    scope: DiscordCommandScope,
    reference: string,
    now: number,
  ): Promise<DiscordCommandResult<string | null>>;
  latest(
    scope: DiscordCommandScope,
    now: number,
  ): Promise<DiscordCommandResult<DiscordCommandRun | null>>;
  cancel(
    scope: DiscordCommandScope,
    now: number,
  ): Promise<DiscordCommandResult<DiscordCancelResult>>;
}

/** Controls retain the real physical destination and rejoin its immutable native mapping. */
export async function touchDiscordCommandAuthority(
  mongoose: typeof import('mongoose'),
  { record, principal }: DiscordCommandScope,
  now: number,
  session: ClientSession,
): Promise<boolean> {
  const admission = discordCommandAdmission(record);
  if (!admission) return false;
  return touchChannelDestinationBinding(
    mongoose,
    {
      tenantId: record.tenantId || undefined,
      channelId: record.channelId,
      agentId: record.agentId,
      applicationRevision: record.applicationRevision,
      principal,
      admission,
    },
    now,
    session,
  );
}

/** Cancellation freezes its target and result in the same transaction as the run mutation. */
export function createDiscordCommandStorage(
  mongoose: typeof import('mongoose'),
): DiscordCommandStorage {
  const inbox = createDiscordInboxModel(mongoose);
  const runs = createChannelRunModel(mongoose);
  const indexes = createChannelIndexGate(() => [inbox, runs]);
  async function authorized(
    scope: DiscordCommandScope,
    now: number,
    session: ClientSession,
  ): Promise<boolean> {
    const { record, fence, principal } = scope;
    if (
      principal.channelRevision !== record.channelRevision ||
      fence.applicationId !== record.applicationId ||
      fence.eventId !== record.eventId
    )
      return false;
    return (
      (await touchChannelOwnerAdmission(
        mongoose,
        {
          tenantId: record.tenantId || undefined,
          userId: principal.userId,
        },
        session,
      )) &&
      (await touchDiscordInbox(mongoose, record, fence, now, session)) &&
      (await touchDiscordCommandAuthority(mongoose, scope, now, session))
    );
  }
  function filter({ record, principal }: DiscordCommandScope) {
    const admission = discordCommandAdmission(record);
    if (!admission) throw new TypeError('Invalid Discord command scope');
    let destination: object = { 'admission.discordDestination': { $exists: false } };
    if (admission.discordDestination)
      destination = { 'admission.discordDestination': admission.discordDestination };
    return {
      tenantId: record.tenantId || '_',
      channelId: record.channelId,
      agentId: record.agentId,
      'principal.userId': principal.userId,
      'principal.channelRevision': record.channelRevision,
      'principal.linkId': principal.linkId,
      'principal.linkRevision': principal.linkRevision,
      ...channelRunActorScope(admission.actor),
      'admission.actor.externalUserId': record.externalUserId,
      'admission.externalChannelId': record.externalChannelId,
      ...destination,
      ...(record.dm ? { 'admission.externalThreadKey': admission.externalThreadKey } : {}),
    };
  }
  const project = (run: ChannelRunRecord): DiscordCommandRun => ({
    runId: run.runId,
    state: run.state,
    cancellationRequested: run.cancellationRequested,
    ...(run.execution?.conversationId ? { conversationId: run.execution.conversationId } : {}),
    ...(run.execution?.responseId ? { responseId: run.execution.responseId } : {}),
  });
  function source(record: DiscordInboxRecord, messageId: string) {
    const key = `${record.externalChannelId}:${messageId}`;
    return {
      $or: [
        { 'progress.externalMessageKey': key, 'progress.outcome': 'confirmed' },
        { receipts: { $elemMatch: { externalMessageKey: key, outcome: 'confirmed' } } },
      ],
    };
  }
  return {
    reviewRun: (scope, now, runId, messageId) =>
      withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return denied();
          const run = await runs
            .findOne({
              ...filter(scope),
              runId,
              ...(messageId ? source(scope.record, messageId) : {}),
            })
            .session(session)
            .lean();
          return { ok: true as const, value: run };
        },
        indexes,
      ),
    saveReview: (scope, encryptedReview, now) => {
      z.string().min(1).max(32768).parse(encryptedReview);
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return denied();
          const key = { applicationId: scope.record.applicationId, eventId: scope.record.eventId };
          const current = await inbox
            .findOne(key)
            .select('+encryptedReview')
            .session(session)
            .lean();
          if (!current) return denied();
          if (current.encryptedReview) return { ok: true as const, value: current.encryptedReview };
          await inbox.updateOne(key, { $set: { encryptedReview } }, { session });
          return { ok: true as const, value: encryptedReview };
        },
        indexes,
      );
    },
    readReview: (scope, reference, now) =>
      withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return denied();
          const { record } = scope;
          const found = await inbox
            .findOne({
              applicationId: record.applicationId,
              applicationRevision: record.applicationRevision,
              eventId: reference,
              channelId: record.channelId,
              channelRevision: record.channelRevision,
              agentId: record.agentId,
              externalChannelId: record.externalChannelId,
              externalUserId: record.externalUserId,
              expiresAt: { $gt: now },
              state: { $in: ['reply', 'done'] },
              ...(record.dm
                ? {
                    'dm.selectionId': record.dm.selectionId,
                    'dm.selectionRevision': record.dm.selectionRevision,
                  }
                : { dm: { $exists: false } }),
              ...(record.thread ? { thread: record.thread } : { thread: { $exists: false } }),
            })
            .select('+encryptedReview')
            .session(session)
            .lean();
          return { ok: true as const, value: found?.encryptedReview ?? null };
        },
        indexes,
      ),
    updateReview: (scope, reference, previous, next, now) => {
      z.string().min(1).max(32768).parse(next);
      return withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return false;
          const result = await inbox.updateOne(
            {
              applicationId: scope.record.applicationId,
              eventId: reference,
              externalUserId: scope.record.externalUserId,
              externalChannelId: scope.record.externalChannelId,
              channelId: scope.record.channelId,
              encryptedReview: previous,
              expiresAt: { $gt: now },
            },
            { $set: { encryptedReview: next } },
            { session },
          );
          return result.matchedCount === 1;
        },
        indexes,
      );
    },
    latest: (scope, now) =>
      withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return denied();
          const run = await runs
            .findOne(filter(scope))
            .sort({ receivedAt: -1, runId: -1 })
            .select(
              'runId state cancellationRequested execution.conversationId execution.responseId',
            )
            .session(session)
            .lean();
          return { ok: true as const, value: run ? project(run) : null };
        },
        indexes,
      ),
    cancel: (scope, now) =>
      withRequiredTransaction(
        mongoose,
        async (session) => {
          if (!(await authorized(scope, now, session))) return denied();
          const { record, fence } = scope;
          const key = {
            tenantId: record.tenantId || null,
            applicationId: fence.applicationId,
            eventId: fence.eventId,
            leaseOwner: fence.owner,
            leaseEpoch: fence.epoch,
            state: 'processing',
          };
          const current = await inbox
            .findOne(key)
            .select('+commandResult +action')
            .session(session)
            .lean();
          if (!current || current.action?.kind !== 'cancel') return denied();
          if (current.commandResult) return { ok: true as const, value: current.commandResult };
          const action = current.action;
          if (Boolean(action.reference) !== Boolean(action.messageId)) return denied();
          const source =
            action.reference && action.messageId
              ? {
                  runId: action.reference,
                  $or: [
                    {
                      'progress.externalMessageKey': `${record.externalChannelId}:${action.messageId}`,
                      'progress.outcome': 'confirmed',
                    },
                    {
                      receipts: {
                        $elemMatch: {
                          externalMessageKey: `${record.externalChannelId}:${action.messageId}`,
                          outcome: 'confirmed',
                        },
                      },
                    },
                  ],
                }
              : {};
          const run = await runs
            .findOne({ ...filter(scope), ...source })
            .sort({ receivedAt: -1, runId: -1 })
            .select('runId state cancellationRequested')
            .session(session)
            .lean();
          const result: DiscordCancelResult = {
            cancelled: false,
            ...(run ? { runId: run.runId } : {}),
          };
          if (run) {
            const updated = await runs.updateOne(
              {
                ...filter(scope),
                runId: run.runId,
                state: { $in: ['queued', 'executing', 'requires_action'] },
              },
              { $set: { cancellationRequested: true } },
              { session },
            );
            result.cancelled = updated.matchedCount === 1;
          }
          const saved = await inbox.updateOne(
            key,
            { $set: { commandResult: result } },
            { session },
          );
          if (saved.matchedCount !== 1)
            throw new Error('Discord cancellation result did not persist');
          return { ok: true as const, value: result };
        },
        indexes,
      ),
  };
}
