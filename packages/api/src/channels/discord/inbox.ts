import { createHash } from 'node:crypto';
import { tenantStorage } from '@librechat/data-schemas';
import {
  discordInboxResolutionSchema,
  discordInboxSubmissionSchema,
  discordDmInboxSubmissionSchema,
  discordPrivateReplySchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  DiscordInboxSubmission,
  DiscordDmInboxSubmission,
  DiscordInboxFence,
  DiscordInboxClaim,
  DiscordInboxDelivery,
  DiscordInboxResolution,
  DiscordNativeAuthority,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import type {
  DiscordInboxStorage,
  DiscordDmStorage,
  DiscordInboxRecord,
  DiscordInboxLeaseRecord,
  DiscordInboxResolutionStorage,
  DiscordThreadStorage,
} from '@librechat/data-schemas';
import type { DiscordRouteResolver } from './routes';
import type { DiscordObserver } from './observe';
import { safeDiscordObserver } from './observe';

/** Discord timestamps are encoded in globally unique snowflakes, not supplied by a client clock. */
export function discordInteractionExpiry(eventId: string): number {
  return Number(BigInt(eventId) >> BigInt(22)) + 1420070400000 + 900000;
}

export interface DiscordInboxServiceDependencies {
  storage: DiscordInboxStorage;
  observe?: DiscordObserver;
  resolver: DiscordRouteResolver;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  execute: (record: DiscordInboxRecord, fence: DiscordInboxFence) => Promise<DiscordPrivateReply>;
  retryDelayMs: () => Promise<number>;
  dm?: { selections: Pick<DiscordDmStorage, 'currentReference'>; enabled: () => Promise<boolean> };
  inspection?: {
    storage: DiscordInboxResolutionStorage;
    threads?: Pick<DiscordThreadStorage, 'bind'>;
    execute: (
      record: DiscordInboxRecord,
      fence: DiscordInboxFence,
      context: DiscordNativeAuthority,
    ) => Promise<DiscordPrivateReply>;
  };
  now?: () => number;
}

/** Internal control plane: resolve the tenant from canonical application ownership every time. */
export function createDiscordInboxService(deps: DiscordInboxServiceDependencies) {
  const now = deps.now ?? Date.now;
  const observe = safeDiscordObserver(deps.observe);
  async function finish(fence: DiscordInboxFence, result: 'completed' | 'expired' | 'unavailable') {
    const changed = await deps.storage.finish(fence, result, now());
    if (changed && result === 'expired') observe({ type: 'inbox', event: 'expired' });
    return changed;
  }
  async function defer(fence: DiscordInboxFence, retryAt: number) {
    const changed = await deps.storage.defer(fence, retryAt, now());
    if (changed) observe({ type: 'inbox', event: 'deferred' });
    return changed;
  }
  async function scope<T>(applicationId: string, run: () => Promise<T>, absent: T): Promise<T> {
    const app = await deps.resolver.security(applicationId);
    if (!app) return absent;
    return tenantStorage.run({ tenantId: app.tenantId === '_' ? undefined : app.tenantId }, run);
  }
  async function delivery(
    record: DiscordInboxLeaseRecord,
    fence: DiscordInboxFence,
  ): Promise<DiscordInboxDelivery | null> {
    if (!record.encryptedReply || !record.encryptedToken)
      throw new Error('Discord inbox payload unavailable');
    const [token, reply] = await Promise.all([
      deps.decrypt(record.encryptedToken),
      deps.decrypt(record.encryptedReply),
    ]);
    if (record.expiresAt <= now()) {
      await finish(fence, 'expired');
      return null;
    }
    return {
      fence,
      applicationRevision: record.applicationRevision,
      token,
      expiresAt: record.expiresAt,
      reply: discordPrivateReplySchema.parse(JSON.parse(reply)),
    };
  }
  async function deferFailure(fence: DiscordInboxFence, expiresAt: number): Promise<void> {
    if (expiresAt <= now()) await finish(fence, 'expired');
    else {
      const delay = await deps.retryDelayMs();
      if (!Number.isSafeInteger(delay) || delay <= 0)
        throw new TypeError('Invalid inbox retry delay');
      await defer(fence, now() + delay);
    }
  }
  return {
    async submit(input: DiscordInboxSubmission): ReturnType<DiscordInboxStorage['submit']> {
      const parsed = discordInboxSubmissionSchema.parse(input);
      const route = await deps.resolver.resolve(parsed);
      const inspection =
        !route && deps.inspection?.threads ? await deps.resolver.inspect?.(parsed) : null;
      const authority = route ?? inspection;
      if (!authority) return { ok: false as const, error: { code: 'authority_changed' as const } };
      const binding = route
        ? {
            channelId: route.channelId,
            channelRevision: route.channelRevision,
            agentId: route.agentId,
          }
        : {
            routing: 'inspection' as const,
            installationId: authority.installationId,
            installationRevision: authority.installationRevision,
          };
      const expiresAt = discordInteractionExpiry(parsed.eventId);
      const timestamp = now();
      if (expiresAt <= timestamp || expiresAt > timestamp + 900000)
        return { ok: false as const, error: { code: 'expired' as const } };
      const encryptedToken = await deps.encrypt(parsed.token);
      return tenantStorage.run(
        { tenantId: authority.tenantId === '_' ? undefined : authority.tenantId },
        async () =>
          deps.storage.submit(
            {
              eventId: parsed.eventId,
              applicationId: authority.applicationId,
              applicationRevision: authority.applicationRevision,
              guildId: parsed.guildId,
              externalChannelId: parsed.externalChannelId,
              externalUserId: parsed.externalUserId,
              ...binding,
              action: parsed.action,
              encryptedToken,
              tokenHash: createHash('sha256').update(parsed.token).digest('hex'),
              expiresAt,
            },
            timestamp,
          ),
      );
    },
    async submitDm(input: DiscordDmInboxSubmission): ReturnType<DiscordInboxStorage['submit']> {
      const parsed = discordDmInboxSubmissionSchema.parse(input);
      const app = await deps.resolver.security(parsed.applicationId);
      const changed = { ok: false as const, error: { code: 'authority_changed' as const } };
      const dm = deps.dm;
      if (!dm || !app || app.applicationRevision !== parsed.expectedApplicationRevision)
        return changed;
      return tenantStorage.run(
        { tenantId: app.tenantId === '_' ? undefined : app.tenantId },
        async () => {
          if (parsed.action.kind === 'ask' && !(await dm.enabled())) return changed;
          const selected = await dm.selections.currentReference(
            {
              applicationId: parsed.applicationId,
              applicationRevision: app.applicationRevision,
              externalUserId: parsed.externalUserId,
              dmChannelId: parsed.externalChannelId,
            },
            now(),
          );
          if (!selected || BigInt(parsed.eventId) <= BigInt(selected.confirmationEventId))
            return changed;
          const expiresAt = discordInteractionExpiry(parsed.eventId);
          const timestamp = now();
          if (expiresAt <= timestamp || expiresAt > timestamp + 900000)
            return { ok: false as const, error: { code: 'expired' as const } };
          return deps.storage.submit(
            {
              applicationId: parsed.applicationId,
              applicationRevision: app.applicationRevision,
              eventId: parsed.eventId,
              externalChannelId: parsed.externalChannelId,
              externalUserId: parsed.externalUserId,
              channelId: selected.source.channelId,
              channelRevision: selected.source.channelRevision,
              agentId: selected.source.agentId,
              dm: {
                selectionId: selected.selectionId,
                selectionRevision: selected.revision,
                parentChannelId: selected.source.externalChannelId,
                confirmationEventId: selected.confirmationEventId,
                source: selected.source,
              },
              action: parsed.action,
              encryptedToken: await deps.encrypt(parsed.token),
              tokenHash: createHash('sha256').update(parsed.token).digest('hex'),
              expiresAt,
            },
            timestamp,
          );
        },
      );
    },
    async claim(applicationId: string, owner: string): Promise<DiscordInboxClaim | null> {
      return scope(
        applicationId,
        async () => {
          let record = await deps.storage.claim(applicationId, owner, now());
          if (!record) return null;
          observe({ type: 'queue', seconds: Math.max(0, now() - record.receivedAt) / 1000 });
          const fence = { applicationId, eventId: record.eventId, owner, epoch: record.leaseEpoch };
          try {
            if (
              record.state === 'processing' &&
              (record.routing === 'inspection' ||
                record.thread ||
                ['ask', 'review', 'decide'].includes(record.action?.kind ?? '') ||
                (record.action?.kind === 'status' && deps.inspection != null))
            )
              return {
                fence,
                applicationRevision: record.applicationRevision,
                expiresAt: record.expiresAt,
                inspection: {
                  guildId:
                    record.routing !== 'inspection' && record.dm
                      ? record.dm.source.guildId
                      : record.guildId!,
                  externalChannelId:
                    record.routing !== 'inspection' && record.dm
                      ? record.dm.parentChannelId
                      : record.externalChannelId,
                  ...(record.routing !== 'inspection' && record.dm ? { scope: 'dm' as const } : {}),
                  externalUserId: record.externalUserId,
                },
              };
            if (record.state === 'processing' && record.routing !== 'inspection') {
              const reply = discordPrivateReplySchema.parse(await deps.execute(record, fence));
              const prepared = await deps.storage.prepareReply(
                fence,
                await deps.encrypt(JSON.stringify(reply)),
                now(),
              );
              if (!prepared.ok) {
                await finish(fence, record.expiresAt <= now() ? 'expired' : 'unavailable');
                return null;
              }
              record = prepared.value;
            }
            return await delivery(record, fence);
          } catch (error) {
            await deferFailure(fence, record.expiresAt);
            throw error;
          }
        },
        null,
      );
    },
    async resolve(input: DiscordInboxResolution): Promise<DiscordInboxDelivery | null> {
      const parsed = discordInboxResolutionSchema.parse(input);
      const inspection = deps.inspection;
      if (!inspection) return null;
      const { fence, owner, source } = parsed;
      return scope(
        fence.applicationId,
        async () => {
          const record = await inspection.storage.inspect(fence, owner, now());
          if (!record) return null;
          try {
            if (record.state === 'reply') return await delivery(record, fence);
            const unavailable = async (): Promise<DiscordInboxDelivery | null> => {
              const prepared = await inspection.storage.unavailable(
                fence,
                owner,
                await deps.encrypt(
                  JSON.stringify({
                    content:
                      'This destination is unavailable. Run the command again in an accessible active channel or thread.',
                  }),
                ),
                now(),
              );
              return prepared.ok ? await delivery(prepared.value, fence) : null;
            };
            if (source?.kind === 'guild_text') {
              if (
                record.routing === 'inspection' ||
                record.thread ||
                !discordGuildTextActorUsable(source) ||
                source.applicationId !== record.applicationId ||
                source.guildId !== (record.dm?.source.guildId ?? record.guildId) ||
                source.channelId !== (record.dm?.parentChannelId ?? record.externalChannelId) ||
                source.authorId !== record.externalUserId
              )
                return await unavailable();
              const resolved = await inspection.storage.resolveText(fence, owner, source, now());
              if (!resolved.ok) return null;
              const reply = discordPrivateReplySchema.parse(
                await inspection.execute(resolved.value, fence, {
                  kind: resolved.value.dm ? 'dm' : 'guild_text',
                  owner,
                  source,
                }),
              );
              const prepared = await deps.storage.prepareReply(
                fence,
                await deps.encrypt(JSON.stringify(reply)),
                now(),
              );
              return prepared.ok ? await delivery(prepared.value, fence) : null;
            }
            if (
              record.dm !== undefined ||
              !source ||
              source.applicationId !== record.applicationId ||
              source.guildId !== record.guildId ||
              source.threadChannelId !== record.externalChannelId ||
              source.authorId !== record.externalUserId
            )
              return await unavailable();
            const parent = await deps.resolver.resolve({
              applicationId: record.applicationId,
              guildId: source.guildId,
              externalChannelId: source.parentChannelId,
              expectedApplicationRevision: record.applicationRevision,
            });
            if (!parent || !inspection.threads) return await unavailable();
            const mapping = await inspection.threads.bind(owner, source, {
              channelId: parent.channelId,
              channelRevision: parent.channelRevision,
              routeRevision: parent.routeRevision,
            });
            if (!mapping.ok) return await unavailable();
            const resolved = await inspection.storage.resolve(
              fence,
              owner,
              source,
              mapping.value,
              now(),
            );
            if (!resolved.ok) return null;
            const reply = discordPrivateReplySchema.parse(
              await inspection.execute(resolved.value, fence, {
                kind: 'guild_thread',
                owner,
                source,
              }),
            );
            const prepared = await deps.storage.prepareReply(
              fence,
              await deps.encrypt(JSON.stringify(reply)),
              now(),
            );
            return prepared.ok ? await delivery(prepared.value, fence) : null;
          } catch (error) {
            await deferFailure(fence, record.expiresAt);
            throw error;
          }
        },
        null,
      );
    },
    async finish(
      fence: DiscordInboxFence,
      result: 'completed' | 'expired' | 'unavailable',
    ): Promise<boolean> {
      return scope(fence.applicationId, () => finish(fence, result), false);
    },
    async defer(fence: DiscordInboxFence, retryAt: number): Promise<boolean> {
      return scope(fence.applicationId, () => defer(fence, retryAt), false);
    },
  };
}
export type DiscordInboxService = ReturnType<typeof createDiscordInboxService>;
