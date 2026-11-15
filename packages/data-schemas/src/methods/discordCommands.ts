import type {
  ChannelRunPrincipal,
  ChannelRunState,
  DiscordInboxFence,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { DiscordInboxRecord, DiscordCancelResult } from '~/models/discordInbox';
import type { ChannelRunRecord } from '~/models/channelRun';
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
  return touchChannelDestinationBinding(
    mongoose,
    {
      tenantId: record.tenantId || undefined,
      channelId: record.channelId,
      agentId: record.agentId,
      applicationRevision: record.applicationRevision,
      principal,
      admission: {
        actor: {
          provider: 'discord',
          applicationId: record.applicationId,
          guildId: record.guildId,
          externalUserId: record.externalUserId,
        },
        eventId: record.eventId,
        input: 'control',
        externalChannelId: record.externalChannelId,
        externalThreadKey: `${record.externalChannelId}:${record.eventId}`,
        externalMessageKey: `${record.externalChannelId}:${record.eventId}`,
        ...(record.thread
          ? { discordDestination: { kind: 'guild_thread', ...record.thread } }
          : {}),
      },
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
    return {
      tenantId: record.tenantId || '_',
      channelId: record.channelId,
      agentId: record.agentId,
      'principal.userId': principal.userId,
      'principal.channelRevision': record.channelRevision,
      'principal.linkId': principal.linkId,
      'principal.linkRevision': principal.linkRevision,
      'admission.actor.provider': 'discord',
      'admission.actor.applicationId': record.applicationId,
      'admission.actor.guildId': record.guildId,
      'admission.actor.externalUserId': record.externalUserId,
      'admission.externalChannelId': record.externalChannelId,
      ...(record.thread
        ? { 'admission.discordDestination': { kind: 'guild_thread', ...record.thread } }
        : { 'admission.discordDestination': { $exists: false } }),
    };
  }
  const project = (run: ChannelRunRecord): DiscordCommandRun => ({
    runId: run.runId,
    state: run.state,
    cancellationRequested: run.cancellationRequested,
    ...(run.execution?.conversationId ? { conversationId: run.execution.conversationId } : {}),
    ...(run.execution?.responseId ? { responseId: run.execution.responseId } : {}),
  });
  return {
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
