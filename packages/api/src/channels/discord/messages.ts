import { createHash } from 'node:crypto';
import { tenantStorage, ChannelRunConflict } from '@librechat/data-schemas';
import {
  discordMessageSubmissionSchema,
  discordChannelConfigSchema,
  discordMentionPrompt,
  discordGuildTextActorSourceSchema,
  discordGuildTextActorUsable,
  discordThreadUsable,
} from 'librechat-data-provider';
import type {
  DiscordMessageSubmission,
  DiscordNativeAuthority,
  DiscordGuildThreadDestination,
  DiscordMessageResult,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type {
  DiscordMessageStorage,
  DiscordThreadStorage,
  DiscordInstallationStorage,
  ChannelRunStorage,
  AgentChannelMethods,
} from '@librechat/data-schemas';
import type { ChannelAuthority } from '../authority';
import type { DiscordRouteResolver } from './routes';
import { channelExternalIdentity } from '../authority';

export type DiscordMessageServiceResult<T = DiscordMessageResult> =
  | { ok: true; value: T }
  | { ok: false; error: { code: 'authority_changed' | 'event_conflict' | 'invalid_input' } };
export interface DiscordMessageService {
  submit(input: DiscordMessageSubmission): Promise<DiscordMessageServiceResult>;
}
const ignored = (
  reason: Extract<DiscordMessageResult, { outcome: 'ignored' }>['reason'],
): DiscordMessageServiceResult => ({ ok: true, value: { outcome: 'ignored', reason } });
const denied = (
  code: 'authority_changed' | 'event_conflict' | 'invalid_input',
): DiscordMessageServiceResult => ({ ok: false, error: { code } });
/** The trusted Gateway owns source inspection; every new run still joins live canonical authority. */
export function createDiscordMessageService(deps: {
  installations: Pick<DiscordInstallationStorage, 'lookupApplication'>;
  resolver: DiscordRouteResolver;
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  messages: DiscordMessageStorage;
  threads?: Pick<DiscordThreadStorage, 'bind'>;
  runs: Pick<ChannelRunStorage, 'admit'>;
  authority: ChannelAuthority;
  settings: () => Promise<DiscordChannelConfig>;
  now?: () => number;
}): DiscordMessageService {
  const now = deps.now ?? Date.now;
  return {
    async submit(input) {
      const { owner, event, source } = discordMessageSubmissionSchema.parse(input);
      if (
        owner.applicationId !== event.applicationId ||
        owner.applicationRevision !== event.applicationRevision ||
        owner.ownerId !== event.ownerId
      )
        return denied('invalid_input');
      const app = await deps.installations.lookupApplication(owner.applicationId);
      if (!app || app.revision !== owner.applicationRevision) return denied('authority_changed');
      return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () => {
        try {
          const policy = discordChannelConfigSchema.parse(await deps.settings());
          if (!policy.enabled || !policy.gateway.enabled) return denied('authority_changed');
          const prompt = discordMentionPrompt(event, app.botUserId);
          if (
            !prompt ||
            event.authorId === app.botUserId ||
            event.content.length > policy.gateway.maxMessageCharacters
          )
            return ignored('unsupported');
          const timestamp = now();
          const createdAt = Number(BigInt(event.messageId) >> BigInt(22)) + 1420070400000;
          if (createdAt > timestamp + policy.signatureToleranceSeconds * 1000)
            return denied('invalid_input');
          // The configurable ceiling never exceeds the minimum receipt retention.
          if (timestamp - createdAt >= 900000) return ignored('expired');
          const occurrence = {
            applicationId: event.applicationId,
            messageId: event.messageId,
            fingerprint: createHash('sha256')
              .update(
                JSON.stringify([
                  event.applicationId,
                  event.messageId,
                  event.guildId ?? null,
                  event.channelId,
                  event.authorId,
                  event.content,
                ]),
              )
              .digest('hex'),
            purgeAt: Math.max(timestamp, createdAt) + policy.inbox.retentionMs,
          };
          if (
            source &&
            (source.applicationId !== app.applicationId ||
              source.botUserId !== app.botUserId ||
              source.guildId !== event.guildId ||
              (source.kind === 'guild_thread' ? source.threadChannelId : source.channelId) !==
                event.channelId ||
              ('authorId' in source && source.authorId !== event.authorId))
          )
            return denied('invalid_input');
          const route = event.guildId
            ? await deps.resolver.resolve({
                applicationId: owner.applicationId,
                expectedApplicationRevision: owner.applicationRevision,
                guildId: event.guildId,
                externalChannelId:
                  source?.kind === 'guild_thread' ? source.parentChannelId : event.channelId,
              })
            : null;
          const scope = route
            ? {
                channelId: route.channelId,
                channelRevision: route.channelRevision,
                agentId: route.agentId,
                guildId: route.guildId,
                externalChannelId: route.externalChannelId,
              }
            : undefined;
          async function consume(
            reason: Extract<DiscordMessageResult, { outcome: 'ignored' }>['reason'],
          ): Promise<DiscordMessageServiceResult> {
            const result = await deps.messages.ignore(owner, occurrence, scope);
            return result === 'duplicate'
              ? { ok: true, value: { outcome: 'duplicate' } }
              : ignored(reason);
          }
          if (timestamp - createdAt >= policy.gateway.messageMaxAgeMs) return consume('expired');
          if (
            !event.guildId ||
            (event.channelType !== undefined &&
              event.channelType !== (source?.kind === 'guild_thread' ? source.threadType : 0))
          )
            return consume('unsupported');
          const actorSource = discordGuildTextActorSourceSchema.safeParse(source);
          let native: DiscordNativeAuthority;
          if (source?.kind === 'guild_thread' && discordThreadUsable(source))
            native = { kind: 'guild_thread', owner, source };
          else if (actorSource.success && discordGuildTextActorUsable(actorSource.data))
            native = { kind: 'guild_text', owner, source: actorSource.data };
          else return consume(route ? 'unavailable' : 'unsupported');
          if (!route) return consume('unavailable');
          const channel = await deps.channels.getAgentChannelMetadata(route.channelId);
          if (!channel || channel.type !== 'discord' || channel.revision !== route.channelRevision)
            return denied('authority_changed');
          const actor = {
            provider: 'discord' as const,
            applicationId: event.applicationId,
            guildId: event.guildId,
            externalUserId: event.authorId,
          };
          const principal = await deps.authority.resolvePrincipal(channel, actor);
          if (!principal) {
            const view = await deps.authority.identity.inspectActor(
              channelExternalIdentity(channel, event.authorId),
            );
            return consume(
              view.ok &&
                (!view.value ||
                  ['pending', 'accepted', 'expired', 'revoked'].includes(view.value.state))
                ? 'link_required'
                : 'unavailable',
            );
          }
          const current = discordChannelConfigSchema.parse(await deps.settings());
          if (!current.enabled || !current.gateway.enabled) return denied('authority_changed');
          const admittedAt = now();
          if (admittedAt - createdAt >= current.gateway.messageMaxAgeMs) return consume('expired');
          if (event.content.length > current.gateway.maxMessageCharacters)
            return consume('unavailable');
          let destination: DiscordGuildThreadDestination | undefined;
          if (native.kind === 'guild_thread') {
            const mapping = await deps.threads?.bind(owner, native.source, {
              channelId: route.channelId,
              channelRevision: route.channelRevision,
              routeRevision: route.routeRevision,
            });
            if (!mapping?.ok) return consume('unavailable');
            destination = {
              kind: 'guild_thread',
              parentChannelId: mapping.value.parentChannelId,
              mappingRevision: mapping.value.mappingRevision,
            };
          }
          try {
            await deps.runs.admit(
              {
                tenantId: route.tenantId,
                channelId: channel.channelId,
                agentId: channel.agentId,
                applicationRevision: owner.applicationRevision,
                discordGateway: { owner, occurrence },
                discordAuthority: native,
                principal,
                admission: {
                  actor,
                  eventId: event.messageId,
                  input: prompt,
                  externalChannelId: event.channelId,
                  externalThreadKey: `${event.channelId}:${destination ? event.channelId : event.messageId}`,
                  ...(destination ? { discordDestination: destination } : {}),
                  externalMessageKey: `${event.channelId}:${event.messageId}`,
                },
              },
              admittedAt,
            );
          } catch (error) {
            if (error instanceof ChannelRunConflict && error.code === 'invalid_transition')
              return consume('unavailable');
            throw error;
          }
          return { ok: true, value: { outcome: 'admitted' } };
        } catch (error) {
          if (!(error instanceof ChannelRunConflict)) throw error;
          if (error.code === 'event_consumed') return { ok: true, value: { outcome: 'duplicate' } };
          return denied(error.code === 'event_conflict' ? 'event_conflict' : 'authority_changed');
        }
      });
    },
  };
}
