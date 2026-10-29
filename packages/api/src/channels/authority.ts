import { z } from 'zod';
import { runAsSystem, tenantStorage } from '@librechat/data-schemas';
import {
  Permissions,
  PermissionTypes,
  PermissionBits,
  channelConfigSchema,
} from 'librechat-data-provider';
import type {
  IUser,
  IRole,
  AgentChannelMethods,
  ChannelIdentityStorage,
  ChannelRunStorage,
} from '@librechat/data-schemas';
import type {
  ChannelExternalIdentity,
  ChannelRunAdmission,
  ChannelRunPrincipal,
} from 'librechat-data-provider';
import type { AgentChannelRecord } from '@librechat/data-schemas';
import type { AgentTriggerEnvelope } from '~/agents/triggers/envelope';
import type { ChannelIdentityDependencies } from './identity';
import type { GenerationJob } from '~/types/stream';
import { AgentTriggerExecutionError } from '~/agents/triggers/host';
import { createChannelIdentityService } from './identity';

export interface ChannelAuthorityDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannel'>;
  identityStorage: ChannelIdentityStorage;
  runs: ChannelRunStorage;
  findUser: (userId: string) => Promise<IUser | null>;
  getRole: (role: string) => Promise<IRole | null>;
  isPrincipalActive: (userId: string) => Promise<boolean>;
  getAgentPermissions: (agentId: string, user: { id: string; role: string }) => Promise<number>;
  publicBaseUrl: string;
  getLifetimes?: ChannelIdentityDependencies['getLifetimes'];
}

export interface ChannelGenerationAuthority {
  channelExecution: unknown;
  userId: string;
  tenantId?: string;
  conversationId: string;
  agentId: string;
  clientRequestId: string;
}

export interface ChannelGenerationAdmissionInput extends ChannelGenerationAuthority {
  /** Server-populated trigger marker, never a request-body claim. */
  isAgentTrigger: unknown;
}

export type ChannelGenerationAdmissionResult =
  | { ok: true; channelExecution?: { channelId: string; runId: string } }
  | {
      ok: false;
      status: 403 | 503;
      body: {
        code: 'CHANNEL_AUTHORITY_CHANGED' | 'CHANNEL_AUTHORITY_UNAVAILABLE';
        error: string;
      };
    };

const channelExecutionSchema = z
  .object({
    channelId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\w-]+$/),
    runId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\w-]+$/),
  })
  .strict();

/** Lazily invoke authority only for server-marked channel triggers; ignore browser metadata. */
export async function admitChannelGeneration(
  input: ChannelGenerationAdmissionInput,
  authorize: (input: ChannelGenerationAuthority) => Promise<boolean>,
): Promise<ChannelGenerationAdmissionResult> {
  if (input.isAgentTrigger !== true || input.channelExecution == null) return { ok: true };
  const marker = channelExecutionSchema.safeParse(input.channelExecution);
  const denied: ChannelGenerationAdmissionResult = {
    ok: false,
    status: 403,
    body: { code: 'CHANNEL_AUTHORITY_CHANGED', error: 'Channel authority is no longer valid.' },
  };
  if (!marker.success) return denied;
  try {
    const allowed = await authorize({
      channelExecution: marker.data,
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      clientRequestId: input.clientRequestId,
    });
    return allowed === true ? { ok: true, channelExecution: marker.data } : denied;
  } catch {
    return {
      ok: false,
      status: 503,
      body: { code: 'CHANNEL_AUTHORITY_UNAVAILABLE', error: 'Channel authority is unavailable.' },
    };
  }
}

export function channelExternalIdentity(
  channel: AgentChannelRecord,
  externalUserId: string,
): ChannelExternalIdentity {
  return {
    tenantId: channel.tenantId ?? '_',
    channelId: channel.channelId,
    channelRevision: channel.revision ?? channel.channelId,
    teamId: channel.slack?.teamId ?? '',
    externalUserId,
    agentId: channel.agentId,
  };
}

/** A Slack actor is never mapped from thread history or from an activator's exported API key. */
export interface ChannelAuthority {
  identity: ReturnType<typeof createChannelIdentityService>;
  resolvePrincipal(
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
  ): Promise<ChannelRunPrincipal | null>;
  authorizeTrigger(envelope: AgentTriggerEnvelope): Promise<void>;
  authorizeGeneration(
    input: ChannelGenerationAuthority,
    job?: Pick<GenerationJob, 'createdAt'>,
  ): Promise<boolean>;
  authorizeResume(input: {
    job: Pick<GenerationJob, 'createdAt' | 'metadata'>;
    userId: string;
    tenantId?: string;
  }): Promise<boolean>;
}

export function createChannelAuthority(deps: ChannelAuthorityDependencies): ChannelAuthority {
  const defaults = channelConfigSchema.parse({});
  async function current(identity: ChannelExternalIdentity) {
    const channel = await deps.channels.getAgentChannel(identity.channelId);
    return channel &&
      channel.status === 'active' &&
      (channel.tenantId ?? '_') === identity.tenantId &&
      channel.agentId === identity.agentId &&
      channel.slack?.teamId === identity.teamId &&
      (channel.revision ?? channel.channelId) === identity.channelRevision
      ? channel
      : null;
  }
  const identity = createChannelIdentityService({
    storage: deps.identityStorage,
    channelIsCurrent: async (actor) => Boolean(await current(actor)),
    canUse: async (actor, userId) => {
      const channel = await current(actor);
      if (!channel || (channel.credentialMode === 'shared' && channel.createdBy !== userId))
        return false;
      const user = await deps.findUser(userId);
      if (
        !user ||
        String(user._id) !== userId ||
        (user.tenantId ?? '_') !== actor.tenantId ||
        !(await deps.isPrincipalActive(userId))
      )
        return false;
      if (!user.role) return false;
      const role = await deps.getRole(user.role);
      if (role?.permissions?.[PermissionTypes.REMOTE_AGENTS]?.[Permissions.USE] !== true)
        return false;
      // findUser returns a lean row: Mongoose's `id` virtual is not authoritative here.
      const permissions = await deps.getAgentPermissions(channel.agentId, {
        id: userId,
        role: user.role,
      });
      return (permissions & PermissionBits.VIEW) === PermissionBits.VIEW;
    },
    publicBaseUrl: deps.publicBaseUrl,
    ticketLifetimeMs: defaults.ticketLifetimeMs,
    linkLifetimeMs: defaults.linkLifetimeMs,
    getLifetimes: deps.getLifetimes,
  });
  async function resolvePrincipal(
    channel: AgentChannelRecord,
    actor: ChannelRunAdmission['actor'],
  ): Promise<ChannelRunPrincipal | null> {
    if (actor.teamId !== channel.slack?.teamId || actor.appId !== channel.slack?.appId) return null;
    const linked = await identity.resolve(channelExternalIdentity(channel, actor.externalUserId));
    if (!linked.ok) return null;
    return {
      userId: linked.value.userId,
      channelRevision: channel.revision ?? channel.channelId,
      linkId: linked.value.linkId,
      linkRevision: linked.value.revision,
    };
  }
  async function authorizeTrigger(envelope: AgentTriggerEnvelope): Promise<void> {
    if (envelope.event.source.type !== 'channel') return;
    const channel = await runAsSystem(() =>
      deps.channels.getAgentChannel(envelope.event.source.id),
    );
    let allowed = false;
    if (
      channel?.status === 'active' &&
      (channel.tenantId ?? '_') === (envelope.principal.tenantId ?? '_')
    ) {
      allowed = await tenantStorage.run({ tenantId: channel.tenantId }, async () => {
        const run = await deps.runs.read(
          channel.tenantId ?? '_',
          channel.channelId,
          envelope.event.id,
        );
        if (!run?.execution || run.cancellationRequested || run.state !== 'executing') return false;
        const principal = await resolvePrincipal(channel, run.admission.actor);
        const conversationId =
          envelope.mode === 'fire' ? envelope.run?.conversationId : envelope.target.conversationId;
        return Boolean(
          principal &&
            principal.userId === run.principal.userId &&
            principal.linkId === run.principal.linkId &&
            principal.linkRevision === run.principal.linkRevision &&
            principal.channelRevision === run.principal.channelRevision &&
            envelope.principal.userId === principal.userId &&
            envelope.target.agentId === run.agentId &&
            conversationId === run.execution.conversationId &&
            envelope.input === run.admission.input &&
            envelope.requestId === run.execution.requestId,
        );
      });
    }
    if (!allowed)
      throw new AgentTriggerExecutionError('Channel authority is no longer valid', {
        mode: envelope.mode,
        certainty: 'definite',
        retryable: false,
        code: 'CHANNEL_AUTHORITY_CHANGED',
      });
  }
  async function authorizeGeneration(
    input: ChannelGenerationAuthority,
    job?: Pick<GenerationJob, 'createdAt'>,
  ): Promise<boolean> {
    const marker = channelExecutionSchema.safeParse(input.channelExecution);
    if (!marker.success) return false;
    const channel = await deps.channels.getAgentChannel(marker.data.channelId);
    if (
      !channel ||
      channel.status !== 'active' ||
      (channel.tenantId ?? '_') !== (input.tenantId ?? '_')
    )
      return false;
    const run = await deps.runs.read(channel.tenantId ?? '_', channel.channelId, marker.data.runId);
    if (
      !run?.execution ||
      run.cancellationRequested ||
      !['executing', 'requires_action'].includes(run.state)
    )
      return false;
    if (
      input.userId !== run.principal.userId ||
      input.conversationId !== run.execution.conversationId ||
      input.agentId !== run.agentId ||
      input.clientRequestId !== run.execution.deliveryKey
    )
      return false;
    if (
      job &&
      run.execution.generationCreatedAt != null &&
      job.createdAt !== run.execution.generationCreatedAt
    )
      return false;
    const principal = await resolvePrincipal(channel, run.admission.actor);
    return Boolean(
      principal &&
        principal.userId === run.principal.userId &&
        principal.channelRevision === run.principal.channelRevision &&
        principal.linkId === run.principal.linkId &&
        principal.linkRevision === run.principal.linkRevision,
    );
  }
  async function authorizeResume(input: {
    job: Pick<GenerationJob, 'createdAt' | 'metadata'>;
    userId: string;
    tenantId?: string;
  }): Promise<boolean> {
    const { job, userId, tenantId } = input;
    if (!job.metadata.channelExecution) return true;
    if (
      job.metadata.userId !== userId ||
      (job.metadata.tenantId ?? '_') !== (tenantId ?? '_') ||
      !job.metadata.conversationId ||
      !job.metadata.agent_id ||
      !job.metadata.idempotencyClientRequestId
    )
      return false;
    return authorizeGeneration(
      {
        channelExecution: job.metadata.channelExecution,
        userId,
        tenantId,
        conversationId: job.metadata.conversationId,
        agentId: job.metadata.agent_id,
        clientRequestId: job.metadata.idempotencyClientRequestId,
      },
      job,
    );
  }
  return { identity, resolvePrincipal, authorizeTrigger, authorizeGeneration, authorizeResume };
}
