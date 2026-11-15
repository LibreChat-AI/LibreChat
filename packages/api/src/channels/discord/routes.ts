import { channelSnowflakeSchema } from 'librechat-data-provider';
import { getTenantId, tenantStorage } from '@librechat/data-schemas';
import type {
  AgentChannelMethods,
  DiscordInstallationStorage,
  DiscordRouteStorage,
} from '@librechat/data-schemas';
import type { DiscordApplicationSecurity, DiscordResolvedRoute } from 'librechat-data-provider';

export interface DiscordRouteResolver {
  security(applicationId: string): Promise<DiscordApplicationSecurity | null>;
  resolve(input: {
    applicationId: string;
    guildId: string;
    externalChannelId: string;
    expectedApplicationRevision: string;
  }): Promise<DiscordResolvedRoute | null>;
}

/** Called only by authenticated deployment services, after verifying the interaction signature. */
export function createDiscordRouteResolver(deps: {
  installations: DiscordInstallationStorage;
  routes: DiscordRouteStorage;
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  enabled: () => Promise<boolean>;
}): DiscordRouteResolver {
  async function security(applicationId: string): Promise<DiscordApplicationSecurity | null> {
    if (!channelSnowflakeSchema.safeParse(applicationId).success) return null;
    const app = await deps.installations.lookupApplication(applicationId);
    if (!app) return null;
    return tenantStorage.run({ tenantId: app.tenantId || undefined }, async () =>
      (await deps.enabled())
        ? {
            tenantId: app.tenantId || '_',
            applicationId: app.applicationId,
            applicationRevision: app.revision,
            publicKey: app.publicKey,
            botUserId: app.botUserId,
          }
        : null,
    );
  }
  return {
    security,
    async resolve(input: {
      applicationId: string;
      guildId: string;
      externalChannelId: string;
      expectedApplicationRevision: string;
    }): Promise<DiscordResolvedRoute | null> {
      if (
        !channelSnowflakeSchema.safeParse(input.guildId).success ||
        !channelSnowflakeSchema.safeParse(input.externalChannelId).success
      )
        return null;
      const app = await security(input.applicationId);
      if (!app || app.applicationRevision !== input.expectedApplicationRevision) return null;
      return tenantStorage.run(
        { tenantId: app.tenantId === '_' ? undefined : app.tenantId },
        async () => {
          const guild = await deps.installations.resolveGuild(app.applicationId, input.guildId);
          if (!guild) return null;
          const route = await deps.routes.read(guild.installationId, input.externalChannelId);
          if (!route) return null;
          const channel = await deps.channels.getAgentChannelMetadata(route.channelId);
          if (
            !channel ||
            channel.type !== 'discord' ||
            channel.status !== 'active' ||
            (channel.tenantId || '_') !== (getTenantId() || '_') ||
            channel.installationId !== guild.installationId ||
            channel.installationRevision !== guild.revision ||
            channel.discord.applicationId !== app.applicationId ||
            channel.discord.guildId !== guild.guildId ||
            channel.discord.botUserId !== app.botUserId ||
            channel.discord.externalChannelId !== input.externalChannelId ||
            !(await deps.enabled())
          )
            return null;
          const current = await deps.installations.readApplication(app.applicationId);
          if (current?.revision !== app.applicationRevision) return null;
          return {
            ...app,
            routeRevision: route.revision,
            installationId: guild.installationId,
            installationRevision: guild.revision,
            guildId: guild.guildId,
            externalChannelId: input.externalChannelId,
            channelId: channel.channelId,
            channelRevision: channel.revision,
            agentId: channel.agentId,
          };
        },
      );
    },
  };
}
