import { createHash } from 'node:crypto';
import { tenantStorage, ChannelRunConflict } from '@librechat/data-schemas';
import {
  discordChannelConfigSchema,
  discordDmMessagePrepareSchema,
  discordDmMessageSubmissionSchema,
  discordGuildTextActorUsable,
} from 'librechat-data-provider';
import type {
  DiscordDmMessagePrepare,
  DiscordDmMessagePrepared,
  DiscordDmMessageSubmission,
  DiscordChannelConfig,
  DiscordApplication,
  ChannelRunAdmission,
  ChannelRunPrincipal,
} from 'librechat-data-provider';
import type {
  DiscordDmStorage,
  DiscordGatewayStorage,
  DiscordMessageStorage,
  DiscordInstallationStorage,
  ChannelRunStorage,
  AgentChannelMethods,
} from '@librechat/data-schemas';
import type { DiscordMessageServiceResult } from './messages';
import type { ChannelAuthority } from '../authority';

export interface DiscordDmMessageService {
  prepare(
    input: DiscordDmMessagePrepare,
  ): Promise<DiscordMessageServiceResult<DiscordDmMessagePrepared | null>>;
  submit(input: DiscordDmMessageSubmission): Promise<DiscordMessageServiceResult>;
}
const denied = (code: 'authority_changed' | 'event_conflict' | 'invalid_input') =>
  ({ ok: false, error: { code } }) as const;

/** Preparation only joins serialization counters; submission owns all execution and consent fences. */
export function createDiscordDmMessageService(deps: {
  selections: Pick<DiscordDmStorage, 'current'>;
  gateway: Pick<DiscordGatewayStorage, 'load'>;
  installations: Pick<DiscordInstallationStorage, 'lookupApplication'>;
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  messages: DiscordMessageStorage;
  runs: Pick<ChannelRunStorage, 'admit'>;
  authority: Pick<ChannelAuthority, 'identity'>;
  settings: () => Promise<DiscordChannelConfig>;
  now?: () => number;
}): DiscordDmMessageService {
  const now = deps.now ?? Date.now;
  async function context(input: DiscordDmMessagePrepare, app: DiscordApplication) {
    const policy = discordChannelConfigSchema.parse(await deps.settings());
    if (!policy.enabled || !policy.gateway.enabled || !policy.dm.enabled) return null;
    const owned = await deps.gateway.load(input.owner);
    if (!owned || owned.applicationRevision !== app.revision || owned.botUserId !== app.botUserId)
      return null;
    const selected = await deps.selections.current(
      {
        applicationId: app.applicationId,
        applicationRevision: app.revision,
        externalUserId: input.event.authorId,
        dmChannelId: input.event.channelId,
      },
      now(),
    );
    if (!selected) return null;
    const source = selected.source;
    const channel = await deps.channels.getAgentChannelMetadata(source.channelId);
    if (
      !channel ||
      channel.type !== 'discord' ||
      channel.status !== 'active' ||
      channel.revision !== source.channelRevision ||
      channel.agentId !== source.agentId ||
      channel.installationId !== source.installationId ||
      channel.installationRevision !== source.installationRevision ||
      channel.discord.applicationId !== app.applicationId ||
      channel.discord.guildId !== source.guildId ||
      channel.discord.externalChannelId !== source.externalChannelId ||
      channel.discord.botUserId !== app.botUserId
    )
      return null;
    const linked = await deps.authority.identity.resolve(
      {
        provider: 'discord',
        tenantId: app.tenantId || '_',
        channelId: source.channelId,
        channelRevision: source.channelRevision,
        agentId: source.agentId,
        applicationId: app.applicationId,
        guildId: source.guildId,
        externalUserId: input.event.authorId,
      },
      source.linkRevision,
    );
    if (
      !linked.ok ||
      linked.value.linkId !== source.linkId ||
      linked.value.userId !== source.userId
    )
      return null;
    const principal: ChannelRunPrincipal = {
      userId: linked.value.userId,
      channelRevision: source.channelRevision,
      linkId: linked.value.linkId,
      linkRevision: linked.value.revision,
    };
    return { selected, channel, principal, policy };
  }
  async function application(input: DiscordDmMessagePrepare) {
    const app = await deps.installations.lookupApplication(input.owner.applicationId);
    return app?.revision === input.owner.applicationRevision ? app : null;
  }
  return {
    async prepare(input) {
      const parsed = discordDmMessagePrepareSchema.parse(input);
      const app = await application(parsed);
      if (!app) return denied('authority_changed');
      return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () => {
        const current = await context(parsed, app);
        if (!current) return { ok: true, value: null };
        return {
          ok: true,
          value: {
            applicationId: app.applicationId,
            externalUserId: parsed.event.authorId,
            dmChannelId: parsed.event.channelId,
            selectionId: current.selected.selectionId,
            selectionRevision: current.selected.revision,
            guildId: current.selected.source.guildId,
            parentChannelId: current.selected.source.externalChannelId,
            botUserId: app.botUserId,
          },
        };
      });
    },
    async submit(input) {
      const parsed = discordDmMessageSubmissionSchema.parse(input);
      const app = await application(parsed);
      if (!app) return denied('authority_changed');
      return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () => {
        try {
          const { owner, event, source } = parsed;
          const policy = discordChannelConfigSchema.parse(await deps.settings());
          if (!policy.enabled || !policy.gateway.enabled || !policy.dm.enabled)
            return denied('authority_changed');
          const timestamp = now();
          const createdAt = Number(BigInt(event.messageId) >> BigInt(22)) + 1420070400000;
          if (createdAt > timestamp + policy.signatureToleranceSeconds * 1000)
            return denied('invalid_input');
          if (timestamp - createdAt >= 900000)
            return { ok: true, value: { outcome: 'ignored', reason: 'expired' } };
          const occurrence = {
            applicationId: event.applicationId,
            messageId: event.messageId,
            fingerprint: createHash('sha256')
              .update(
                JSON.stringify([
                  event.applicationId,
                  event.messageId,
                  null,
                  event.channelId,
                  event.authorId,
                  event.content,
                ]),
              )
              .digest('hex'),
            purgeAt: Math.max(timestamp, createdAt) + policy.inbox.retentionMs,
          };
          async function ignore(
            reason: 'unavailable' | 'unsupported' | 'expired',
          ): Promise<DiscordMessageServiceResult> {
            return (await deps.messages.ignore(owner, occurrence)) === 'duplicate'
              ? { ok: true, value: { outcome: 'duplicate' } }
              : { ok: true, value: { outcome: 'ignored', reason } };
          }
          const prompt = event.content.trim();
          if (
            !prompt ||
            event.authorId === app.botUserId ||
            event.content.length > policy.gateway.maxMessageCharacters
          )
            return ignore('unsupported');
          if (timestamp - createdAt >= policy.gateway.messageMaxAgeMs) return ignore('expired');
          const current = await context(parsed, app);
          if (
            !current ||
            current.selected.selectionId !== parsed.selectionId ||
            current.selected.revision !== parsed.selectionRevision ||
            !source ||
            !discordGuildTextActorUsable(source) ||
            source.applicationId !== app.applicationId ||
            source.botUserId !== app.botUserId ||
            source.authorId !== event.authorId ||
            source.guildId !== current.selected.source.guildId ||
            source.channelId !== current.selected.source.externalChannelId
          )
            return ignore('unavailable');
          const latest = discordChannelConfigSchema.parse(await deps.settings());
          if (!latest.enabled || !latest.gateway.enabled || !latest.dm.enabled)
            return denied('authority_changed');
          const admittedAt = now();
          if (admittedAt - createdAt >= latest.gateway.messageMaxAgeMs) return ignore('expired');
          if (event.content.length > latest.gateway.maxMessageCharacters)
            return ignore('unavailable');
          const admission: ChannelRunAdmission = {
            actor: {
              provider: 'discord',
              scope: 'dm',
              applicationId: app.applicationId,
              externalUserId: event.authorId,
              selectionId: parsed.selectionId,
              selectionRevision: parsed.selectionRevision,
            },
            discordDestination: {
              kind: 'dm',
              parentChannelId: current.selected.source.externalChannelId,
              selectionId: parsed.selectionId,
              selectionRevision: parsed.selectionRevision,
            },
            eventId: event.messageId,
            externalChannelId: event.channelId,
            externalThreadKey: `${event.channelId}:${current.selected.confirmationEventId}`,
            externalMessageKey: `${event.channelId}:${event.messageId}`,
            input: prompt,
          };
          try {
            await deps.runs.admit(
              {
                tenantId: app.tenantId || '_',
                channelId: current.channel.channelId,
                agentId: current.channel.agentId,
                principal: current.principal,
                admission,
                applicationRevision: app.revision,
                discordGateway: { owner, occurrence },
                discordAuthority: { kind: 'dm', owner, source },
              },
              admittedAt,
            );
          } catch (error) {
            if (error instanceof ChannelRunConflict && error.code === 'invalid_transition')
              return ignore('unavailable');
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
