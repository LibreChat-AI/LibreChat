import { createHash } from 'node:crypto';
import { tenantStorage } from '@librechat/data-schemas';
import {
  discordInboxResolutionSchema,
  discordInboxSubmissionSchema,
  discordPrivateReplySchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  DiscordInboxSubmission,
  DiscordInboxFence,
  DiscordInboxClaim,
  DiscordInboxDelivery,
  DiscordInboxResolution,
  DiscordNativeAuthority,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import type {
  DiscordInboxStorage,
  DiscordInboxRecord,
  DiscordInboxLeaseRecord,
  DiscordInboxResolutionStorage,
  DiscordThreadStorage,
} from '@librechat/data-schemas';
import type { DiscordRouteResolver } from './routes';

/** Discord timestamps are encoded in globally unique snowflakes, not supplied by a client clock. */
export function discordInteractionExpiry(eventId: string): number {
  return Number(BigInt(eventId) >> BigInt(22)) + 1420070400000 + 900000;
}

export interface DiscordInboxServiceDependencies {
  storage: DiscordInboxStorage;
  resolver: DiscordRouteResolver;
  encrypt: (value: string) => Promise<string>;
  decrypt: (value: string) => Promise<string>;
  execute: (record: DiscordInboxRecord, fence: DiscordInboxFence) => Promise<DiscordPrivateReply>;
  retryDelayMs: () => Promise<number>;
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
      await deps.storage.finish(fence, 'expired', now());
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
    if (expiresAt <= now()) await deps.storage.finish(fence, 'expired', now());
    else {
      const delay = await deps.retryDelayMs();
      if (!Number.isSafeInteger(delay) || delay <= 0)
        throw new TypeError('Invalid inbox retry delay');
      await deps.storage.defer(fence, now() + delay, now());
    }
  }
  return {
    async submit(input: DiscordInboxSubmission): ReturnType<DiscordInboxStorage['submit']> {
      const parsed = discordInboxSubmissionSchema.parse(input);
      const route = await deps.resolver.resolve(parsed);
      if (!route) return { ok: false as const, error: { code: 'authority_changed' as const } };
      const expiresAt = discordInteractionExpiry(parsed.eventId);
      const timestamp = now();
      if (expiresAt <= timestamp || expiresAt > timestamp + 900000)
        return { ok: false as const, error: { code: 'expired' as const } };
      const encryptedToken = await deps.encrypt(parsed.token);
      return tenantStorage.run(
        { tenantId: route.tenantId === '_' ? undefined : route.tenantId },
        async () =>
          deps.storage.submit(
            {
              eventId: parsed.eventId,
              applicationId: route.applicationId,
              applicationRevision: route.applicationRevision,
              guildId: route.guildId,
              externalChannelId: route.externalChannelId,
              externalUserId: parsed.externalUserId,
              channelId: route.channelId,
              channelRevision: route.channelRevision,
              agentId: route.agentId,
              action: parsed.action,
              encryptedToken,
              tokenHash: createHash('sha256').update(parsed.token).digest('hex'),
              expiresAt,
            },
            timestamp,
          ),
      );
    },
    async claim(applicationId: string, owner: string): Promise<DiscordInboxClaim | null> {
      return scope(
        applicationId,
        async () => {
          let record = await deps.storage.claim(applicationId, owner, now());
          if (!record) return null;
          const fence = { applicationId, eventId: record.eventId, owner, epoch: record.leaseEpoch };
          try {
            if (
              record.state === 'processing' &&
              (record.routing === 'inspection' || record.thread || record.action?.kind === 'ask')
            )
              return {
                fence,
                applicationRevision: record.applicationRevision,
                expiresAt: record.expiresAt,
                inspection: {
                  guildId: record.guildId,
                  externalChannelId: record.externalChannelId,
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
                await deps.storage.finish(
                  fence,
                  record.expiresAt <= now() ? 'expired' : 'unavailable',
                  now(),
                );
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
                source.guildId !== record.guildId ||
                source.channelId !== record.externalChannelId ||
                source.authorId !== record.externalUserId
              )
                return await unavailable();
              const resolved = await inspection.storage.resolveText(fence, owner, source, now());
              if (!resolved.ok) return null;
              const reply = discordPrivateReplySchema.parse(
                await inspection.execute(resolved.value, fence, {
                  kind: 'guild_text',
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
              !source ||
              source.applicationId !== record.applicationId ||
              source.guildId !== record.guildId ||
              source.threadChannelId !== record.externalChannelId ||
              source.authorId !== record.externalUserId
            )
              return await unavailable();
            const parent = await deps.resolver.resolve({
              applicationId: record.applicationId,
              guildId: record.guildId,
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
      return scope(fence.applicationId, () => deps.storage.finish(fence, result, now()), false);
    },
    async defer(fence: DiscordInboxFence, retryAt: number): Promise<boolean> {
      return scope(fence.applicationId, () => deps.storage.defer(fence, retryAt, now()), false);
    },
  };
}
export type DiscordInboxService = ReturnType<typeof createDiscordInboxService>;
