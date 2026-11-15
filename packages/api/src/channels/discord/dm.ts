import { tenantStorage } from '@librechat/data-schemas';
import { channelExternalIdentitySchema, discordDmConsumeSchema } from 'librechat-data-provider';
import type {
  DiscordDmSource,
  DiscordDmIssue,
  DiscordDmIssuedCode,
  DiscordDmSelectionPage,
  DiscordDmSelectionView,
  DiscordDmConsume,
  DiscordDmAcknowledgement,
  DiscordDmRevoke,
  DiscordDmResult,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import type {
  AgentChannelMethods,
  ChannelIdentityStorage,
  DiscordDmStorage,
  DiscordInstallationStorage,
} from '@librechat/data-schemas';
import type { DiscordManagementPrincipal } from './service';
import type { ChannelAuthority } from '../authority';

export interface DiscordDmService {
  issue(
    principal: DiscordManagementPrincipal,
    input: DiscordDmIssue,
  ): Promise<DiscordDmResult<DiscordDmIssuedCode>>;
  list(
    principal: DiscordManagementPrincipal,
    cursor?: string,
  ): Promise<DiscordDmResult<DiscordDmSelectionPage>>;
  revoke(
    principal: DiscordManagementPrincipal,
    input: DiscordDmRevoke,
  ): Promise<DiscordDmResult<null>>;
  select(input: DiscordDmConsume): Promise<DiscordDmResult<DiscordDmAcknowledgement>>;
}
type SourceLink = Omit<
  DiscordDmSource,
  'userId' | 'externalChannelId' | 'installationId' | 'installationRevision'
> &
  Partial<Pick<DiscordDmSource, 'installationId' | 'installationRevision'>>;
const failure = (
  code: 'forbidden' | 'unavailable' | 'disabled' | 'changed',
): { ok: false; error: { code: typeof code } } => ({ ok: false, error: { code } });
/** Browser ownership and signed application identity meet only through the canonical guild link. */
export function createDiscordDmService(deps: {
  storage: DiscordDmStorage;
  identities: Pick<ChannelIdentityStorage, 'readChannelLink'>;
  installations: Pick<DiscordInstallationStorage, 'lookupApplication'>;
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  authority: Pick<ChannelAuthority, 'resolvePrincipal'>;
  principalAllowed: (principal: DiscordManagementPrincipal) => Promise<boolean>;
  settings: () => Promise<DiscordChannelConfig['dm']>;
  now?: () => number;
}): DiscordDmService {
  const now = deps.now ?? Date.now;
  async function canUse(userId: string, source: SourceLink) {
    const channel = await deps.channels.getAgentChannelMetadata(source.channelId);
    if (
      !channel ||
      channel.type !== 'discord' ||
      !channel.discord ||
      channel.status !== 'active' ||
      channel.revision !== source.channelRevision ||
      channel.agentId !== source.agentId ||
      channel.discord.applicationId !== source.applicationId ||
      channel.discord.guildId !== source.guildId ||
      (source.installationId !== undefined && channel.installationId !== source.installationId) ||
      (source.installationRevision !== undefined &&
        channel.installationRevision !== source.installationRevision)
    )
      return false;
    const principal = await deps.authority.resolvePrincipal(channel, {
      provider: 'discord',
      applicationId: source.applicationId,
      guildId: source.guildId,
      externalUserId: source.externalUserId,
    });
    return (
      principal?.userId === userId &&
      principal.linkId === source.linkId &&
      principal.linkRevision === source.linkRevision
    );
  }
  return {
    async issue(principal, input) {
      if (!(await deps.principalAllowed(principal))) return failure('forbidden');
      if (!(await deps.settings()).enabled) return failure('disabled');
      const link = await deps.identities.readChannelLink(principal.tenantId || '_', input.linkId);
      const identity = channelExternalIdentitySchema.safeParse(link?.identity);
      if (
        !link ||
        link.userId !== principal.id ||
        link.revision !== input.expectedLinkRevision ||
        link.state !== 'active' ||
        link.expiresAtMs <= now() ||
        !identity.success ||
        !('provider' in identity.data) ||
        identity.data.provider !== 'discord'
      )
        return failure('unavailable');
      const source = { ...identity.data, linkId: link.linkId, linkRevision: link.revision };
      if (!(await canUse(principal.id, source))) return failure('forbidden');
      const issued = await deps.storage.issue(principal.id, input, now());
      if (!issued.ok) return issued;
      return (await deps.settings()).enabled && (await canUse(principal.id, source))
        ? issued
        : failure('unavailable');
    },
    async list(principal, cursor) {
      if (!(await deps.principalAllowed(principal))) return failure('forbidden');
      const [settings, page] = await Promise.all([
        deps.settings(),
        deps.storage.list(principal.id, cursor),
      ]);
      const selections = await Promise.all(
        page.selections.map(async (selection) => {
          let state: DiscordDmSelectionView['state'] = 'active';
          if (selection.state === 'revoked') state = 'revoked';
          else if (selection.expiresAtMs <= now()) state = 'expired';
          else if (!(await canUse(principal.id, selection.source))) state = 'unavailable';
          return {
            selectionId: selection.selectionId,
            revision: selection.revision,
            linkId: selection.source.linkId,
            agentId: selection.source.agentId,
            applicationId: selection.applicationId,
            dmChannelId: selection.dmChannelId,
            expiresAtMs: selection.expiresAtMs,
            state,
          };
        }),
      );
      return {
        ok: true,
        value: { enabled: settings.enabled, selections, ...(page.next ? { next: page.next } : {}) },
      };
    },
    async revoke(principal, input) {
      if (!(await deps.principalAllowed(principal))) return failure('forbidden');
      return (await deps.storage.revoke(principal.id, input.selectionId, input.revision))
        ? { ok: true, value: null }
        : failure('changed');
    },
    async select(input) {
      const parsed = discordDmConsumeSchema.parse(input);
      const app = await deps.installations.lookupApplication(parsed.applicationId);
      if (!app || app.revision !== parsed.applicationRevision) return failure('unavailable');
      return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () => {
        if (!(await deps.settings()).enabled) return failure('disabled');
        const result = await deps.storage.consume(parsed, now());
        if (!result.ok) return result;
        if (
          !(await canUse(result.value.source.userId, result.value.source)) ||
          !(await deps.settings()).enabled
        )
          return failure('unavailable');
        return {
          ok: true,
          value: {
            applicationId: result.value.applicationId,
            externalUserId: result.value.externalUserId,
            dmChannelId: result.value.dmChannelId,
            selectionId: result.value.selectionId,
            expiresAtMs: result.value.expiresAtMs,
          },
        };
      });
    },
  };
}
