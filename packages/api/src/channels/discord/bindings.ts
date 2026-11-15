import { z } from 'zod';
import { nanoid } from 'nanoid';
import { channelSnowflakeSchema } from 'librechat-data-provider';
import { getTenantId, SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type {
  DiscordGuild,
  DiscordBindingStatus,
  DiscordBindingView,
  DiscordBindingTarget,
  BindDiscordChannel,
  RemoveDiscordBinding,
} from 'librechat-data-provider';
import type {
  AgentChannelMethods,
  DiscordInstallationStorage,
  DiscordRouteStorage,
  DiscordRouteError,
} from '@librechat/data-schemas';
import type { DiscordProviderClient, DiscordProviderError } from './client';
import type { DiscordManagementPrincipal } from './service';
import type { SafeErrorMetadata } from '~/utils/errors';
import { getSafeErrorMetadata } from '~/utils/errors';

const id: z.ZodString = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/);
export const discordBindingTargetSchema: z.ZodObject<{
  agentId: typeof id;
  installationId: typeof id;
  externalChannelId: typeof channelSnowflakeSchema;
}> = z
  .object({
    agentId: id,
    installationId: id,
    externalChannelId: channelSnowflakeSchema,
  })
  .strict();
export const bindDiscordChannelSchema: z.ZodType<BindDiscordChannel> =
  discordBindingTargetSchema.extend({
    expectedRevision: id.optional(),
  });
export const removeDiscordBindingSchema: z.ZodType<RemoveDiscordBinding> =
  discordBindingTargetSchema.extend({
    expectedRevision: id,
  });
type BindingError =
  | DiscordRouteError
  | DiscordProviderError
  | 'forbidden'
  | 'not_configured'
  | 'application_changed'
  | 'binding_uncertain'
  | 'unavailable';
export type DiscordBindingResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: BindingError } };
const failure = (code: BindingError): { ok: false; error: { code: BindingError } } => ({
  ok: false,
  error: { code },
});

export function createDiscordBindingService(deps: {
  installations: DiscordInstallationStorage;
  routes: DiscordRouteStorage;
  channels: AgentChannelMethods;
  provider: Pick<DiscordProviderClient, 'inspectChannel'>;
  enabled: () => Promise<boolean>;
  /** Both guards check the current active principal; agent permission is SHARE/editor. */
  canEditAgent: (principal: DiscordManagementPrincipal, agentId: string) => Promise<boolean>;
  canManageInstallation: (
    principal: DiscordManagementPrincipal,
    guild: DiscordGuild,
  ) => Promise<boolean>;
  /** Returns a name only after checking the viewer's current agent VIEW permission. */
  getAgentName: (
    principal: DiscordManagementPrincipal,
    agentId: string,
  ) => Promise<string | undefined>;
  decrypt: (value: string) => Promise<string>;
  logError?: (metadata: SafeErrorMetadata) => void;
}) {
  async function authorized(
    principal: DiscordManagementPrincipal,
    agentId: string,
    guild: DiscordGuild,
  ) {
    const tenant = getTenantId();
    if (
      tenant === SYSTEM_TENANT_ID ||
      (tenant || undefined) !== (principal.tenantId || undefined) ||
      (guild.tenantId || undefined) !== (principal.tenantId || undefined)
    )
      return false;
    const [edit, manage] = await Promise.all([
      deps.canEditAgent(principal, agentId),
      deps.canManageInstallation(principal, guild),
    ]);
    return edit && manage;
  }
  async function protect<T>(
    action: () => Promise<DiscordBindingResult<T>>,
  ): Promise<DiscordBindingResult<T>> {
    try {
      return await action();
    } catch (error) {
      deps.logError?.(getSafeErrorMetadata(error));
      return failure('unavailable');
    }
  }
  return {
    status(
      principal: DiscordManagementPrincipal,
      input: DiscordBindingTarget,
    ): Promise<DiscordBindingResult<DiscordBindingStatus>> {
      return protect(async () => {
        if (!discordBindingTargetSchema.safeParse(input).success) return failure('invalid_input');
        const guild = await deps.installations.readGuild(input.installationId);
        if (!guild || !(await authorized(principal, input.agentId, guild)))
          return failure('forbidden');
        const route = await deps.routes.read(guild.installationId, input.externalChannelId);
        const channel = route ? await deps.channels.getAgentChannelMetadata(route.channelId) : null;
        const name = channel ? await deps.getAgentName(principal, channel.agentId) : undefined;
        return {
          ok: true,
          value: {
            occupied: Boolean(route),
            assignedToThisAgent: channel?.agentId === input.agentId,
            canReplace: Boolean(await deps.enabled()) && guild.status === 'active',
            ...(route ? { revision: route.revision } : {}),
            ...(name ? { assignedAgentName: name } : {}),
          },
        };
      });
    },
    bind(
      principal: DiscordManagementPrincipal,
      input: BindDiscordChannel,
    ): Promise<DiscordBindingResult<DiscordBindingView>> {
      return protect(async () => {
        if (!bindDiscordChannelSchema.safeParse(input).success) return failure('invalid_input');
        const guild = await deps.installations.readGuild(input.installationId);
        if (!guild || !(await authorized(principal, input.agentId, guild)))
          return failure('forbidden');
        if (!(await deps.enabled())) return failure('not_configured');
        if (guild.status !== 'active') return failure('installation_unavailable');
        const app = await deps.installations.readApplicationCredentials(guild.applicationId);
        if (!app) return failure('installation_unavailable');
        const checked = await deps.provider.inspectChannel({
          application: {
            applicationId: app.applicationId,
            botUserId: app.botUserId,
            publicKey: app.publicKey,
            name: app.name ?? '',
          },
          botToken: await deps.decrypt(app.encryptedBotToken),
          guildId: guild.guildId,
          externalChannelId: input.externalChannelId,
        });
        const [current, currentApplication] = await Promise.all([
          deps.installations.readGuild(guild.installationId),
          deps.installations.readApplication(guild.applicationId),
        ]);
        if (!current || !(await authorized(principal, input.agentId, current)))
          return failure('forbidden');
        if (!(await deps.enabled())) return failure('not_configured');
        if (current.revision !== guild.revision || current.status !== 'active')
          return failure('installation_unavailable');
        if (currentApplication?.revision !== app.revision) return failure('application_changed');
        if (!checked.ok) return checked;
        if (
          checked.value.guildId !== guild.guildId ||
          checked.value.externalChannelId !== input.externalChannelId
        )
          return failure('guild_changed');
        const candidate = await deps.channels.createAgentChannel({
          channelId: nanoid(),
          tenantId: principal.tenantId,
          agentId: input.agentId,
          createdBy: principal.id,
          revision: nanoid(),
          type: 'discord',
          status: 'pending_install',
          credentialMode: 'per_user',
          installationId: guild.installationId,
          installationRevision: guild.revision,
          applicationRevision: app.revision,
          discord: {
            applicationId: app.applicationId,
            guildId: guild.guildId,
            botUserId: app.botUserId,
            externalChannelId: input.externalChannelId,
          },
        });
        const assignment = {
          actorId: principal.id,
          installationId: guild.installationId,
          installationRevision: guild.revision,
          applicationRevision: app.revision,
          externalChannelId: input.externalChannelId,
          channelId: candidate.channelId,
          channelRevision: candidate.revision,
          expectedRevision: input.expectedRevision,
        };
        let assigned: Awaited<ReturnType<DiscordRouteStorage['assign']>>;
        try {
          assigned = await deps.routes.assign(assignment);
        } catch (error) {
          deps.logError?.(getSafeErrorMetadata(error));
          // A lost acknowledgement may follow a committed replacement. Never retire its successor.
          try {
            const observed = await deps.routes.read(guild.installationId, input.externalChannelId);
            if (!observed || observed.channelId !== candidate.channelId)
              return failure('binding_uncertain');
            assigned = { ok: true as const, value: observed };
          } catch {
            return failure('binding_uncertain');
          }
        }
        if (!assigned.ok) {
          await deps.channels.beginAgentChannelDeletion(candidate.channelId, principal.id);
          await deps.channels.deleteAgentChannel(candidate.channelId, principal.id);
          return assigned;
        }
        const channel = await deps.channels.getAgentChannelMetadata(candidate.channelId);
        if (!channel || channel.type !== 'discord' || channel.status !== 'active')
          return failure('unavailable');
        return { ok: true, value: { channel, routeRevision: assigned.value.revision } };
      });
    },
    remove(
      principal: DiscordManagementPrincipal,
      input: RemoveDiscordBinding,
    ): Promise<DiscordBindingResult<null>> {
      return protect(async () => {
        if (!removeDiscordBindingSchema.safeParse(input).success) return failure('invalid_input');
        const guild = await deps.installations.readGuild(input.installationId);
        if (!guild || !(await authorized(principal, input.agentId, guild)))
          return failure('forbidden');
        const route = await deps.routes.read(guild.installationId, input.externalChannelId);
        const channel = route ? await deps.channels.getAgentChannelMetadata(route.channelId) : null;
        if (!route || !channel || channel.agentId !== input.agentId)
          return failure('route_changed');
        return deps.routes.remove({
          actorId: principal.id,
          installationId: guild.installationId,
          externalChannelId: input.externalChannelId,
          expectedRevision: input.expectedRevision,
        });
      });
    },
  };
}
export type DiscordBindingService = ReturnType<typeof createDiscordBindingService>;
