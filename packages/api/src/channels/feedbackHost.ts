import { channelConfigSchema } from 'librechat-data-provider';
import { discordCommandAdmission } from '@librechat/data-schemas';
import type {
  AgentChannelMethods,
  ChannelFeedbackStorage,
  DiscordFeedbackStorage,
  DiscordCommandScope,
} from '@librechat/data-schemas';
import type {
  ChannelFeedbackActor,
  ChannelReplyMapping,
  ChannelFeedbackResult,
  ChannelFeedbackView,
} from 'librechat-data-provider';
import type { ChannelPolicySubject, ChannelFeedbackPolicySnapshot } from './settings';
import type { SendFeedbackScoreParams } from '~/langfuse/feedback';
import type { ChannelMessage } from './types';
import { isFeedbackScoreEligible } from '~/langfuse/feedback';
import { createChannelFeedbackService } from './feedback';
import { traceIdForMessage } from '~/langfuse/trace';

export type ChannelFeedbackMessage = ChannelMessage;
export interface ChannelFeedbackHostDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  storage: ChannelFeedbackStorage & Partial<DiscordFeedbackStorage>;
  /** One current scoped policy read; null is expected denial, operational failures throw. */
  getPolicy: (subject: ChannelPolicySubject) => Promise<ChannelFeedbackPolicySnapshot | null>;
  sendScore: (input: SendFeedbackScoreParams) => Promise<void>;
  maxConflictRetries: number;
  exportTimeoutMs: number;
  exportLeaseMs: number;
  exportRetryMs: number;
  now?: () => number;
}

function traceRouting(source: Pick<ChannelReplyMapping, 'sampled' | 'destinationIds'>) {
  // A known sampling decision can deliberately leave destination identity unresolved.
  return {
    sampled: source.sampled === true,
    destinationIds: typeof source.sampled === 'boolean' ? source.destinationIds : [],
  };
}

export type ChannelFeedbackHost = ReturnType<typeof createChannelFeedbackService> & {
  recordDiscordFeedback(
    scope: DiscordCommandScope,
  ): Promise<ChannelFeedbackResult<ChannelFeedbackView>>;
};

/** One trusted source projection resolves receipt and owned message without loading answer text or keys. */
export function createChannelFeedbackHost(
  deps: ChannelFeedbackHostDependencies,
): ChannelFeedbackHost {
  function matchesSource(
    channel: Awaited<ReturnType<typeof deps.channels.getAgentChannelMetadata>>,
    actor: ChannelFeedbackActor,
  ) {
    if (
      !channel ||
      channel.status !== 'active' ||
      (channel.tenantId || '_') !== actor.tenantId ||
      channel.revision !== actor.channelRevision ||
      channel.agentId !== actor.agentId
    )
      return false;
    return actor.provider === 'discord'
      ? channel.type === 'discord' &&
          channel.discord.applicationId === actor.applicationId &&
          channel.discord.guildId ===
            (actor.scope === 'dm' ? actor.sourceGuildId : actor.guildId) &&
          (actor.scope !== 'dm' || channel.discord.externalChannelId === actor.parentChannelId)
      : channel.type === 'slack' && channel.slack?.teamId === actor.teamId;
  }
  async function authorizedPolicy(
    actor: ChannelFeedbackActor & Partial<Pick<ChannelReplyMapping, 'principalId'>>,
  ): Promise<ChannelFeedbackPolicySnapshot | null> {
    const channelRead = deps.channels.getAgentChannelMetadata(actor.channelId);
    // Initial ingress needs the canonical creator; persisted replies already name their source principal.
    const policyRead = actor.principalId
      ? deps.getPolicy({ tenantId: actor.tenantId, userId: actor.principalId })
      : channelRead.then((channel) =>
          channel && matchesSource(channel, actor)
            ? deps.getPolicy({ tenantId: actor.tenantId, userId: channel.createdBy })
            : null,
        );
    const [channel, policy] = await Promise.all([channelRead, policyRead]);
    if (!policy || !matchesSource(channel, actor)) return null;
    if (actor.provider === 'discord') {
      const config = channelConfigSchema.parse(policy.appConfig.endpoints?.agents?.channels ?? {});
      if (
        !config.enabled ||
        !config.discord?.enabled ||
        policy.appConfig.interfaceConfig?.feedback === false
      )
        return null;
    }
    return policy;
  }
  async function canRecord(actor: ChannelFeedbackActor): Promise<boolean> {
    return Boolean(await authorizedPolicy(actor));
  }
  const service = createChannelFeedbackService({
    storage: deps.storage,
    maxConflictRetries: deps.maxConflictRetries,
    exportTimeoutMs: deps.exportTimeoutMs,
    exportLeaseMs: deps.exportLeaseMs,
    exportRetryMs: deps.exportRetryMs,
    now: deps.now,
    canRecord,
    resolveReply: async (actor, key) => {
      const source = await deps.storage.readReplySource(actor, key);
      if (!source) return null;
      return {
        ...source,
        ...traceRouting(source),
        traceId: traceIdForMessage(source.langfuseRunId || source.messageId),
        centralTraceExportEnabled: source.centralTraceExportEnabled === true,
      };
    },
    sendScore: async (input, mapping) => {
      input.assertActive();
      const policy = await authorizedPolicy(mapping);
      if (!policy) throw new Error('Channel feedback policy changed');
      input.assertActive();
      const source = await deps.storage.readChannelReplyTrace(mapping);
      if (!source) throw new Error('Channel feedback authority changed');
      if (traceIdForMessage(source.langfuseRunId || mapping.messageId) !== input.traceId)
        throw new Error('Channel feedback trace identity changed');
      const assertActive = () => {
        input.assertActive();
        if (source.expiredAt && source.expiredAt.getTime() <= Date.now())
          throw new Error('Channel feedback authority changed');
      };
      assertActive();
      const centralTraceExportEnabled =
        source.centralTraceExportEnabled === true && policy.centralTraceExportEnabled;
      const delivery = {
        ...input,
        ...traceRouting(source),
        assertActive,
        appConfig: policy.appConfig,
        isTemporary:
          (mapping.provider === 'discord' ? source.isTemporary : mapping.isTemporary) !== false,
        centralTraceExportEnabled,
      };
      if (mapping.provider === 'discord' && !(await isFeedbackScoreEligible(delivery))) return;
      assertActive();
      await deps.sendScore(delivery);
    },
  });
  return {
    ...service,
    async recordDiscordFeedback(scope): Promise<ChannelFeedbackResult<ChannelFeedbackView>> {
      const denied = (): ChannelFeedbackResult<ChannelFeedbackView> => ({
        ok: false,
        error: { code: 'forbidden' },
      });
      const { record, principal } = scope;
      const action = record.action;
      if (action?.kind !== 'feedback' || !deps.storage.recordDiscordFeedback) return denied();
      const admission = discordCommandAdmission(record);
      if (!admission || admission.actor.provider !== 'discord') return denied();
      const common = {
        provider: 'discord' as const,
        tenantId: record.tenantId || '_',
        channelId: record.channelId,
        channelRevision: record.channelRevision,
        agentId: record.agentId,
        applicationId: record.applicationId,
        principalId: principal.userId,
      };
      let actor: ChannelFeedbackActor & { principalId: string };
      if (record.dm)
        actor = {
          ...common,
          scope: 'dm',
          selectionId: record.dm.selectionId,
          selectionRevision: record.dm.selectionRevision,
          sourceGuildId: record.dm.source.guildId,
          parentChannelId: record.dm.parentChannelId,
          confirmationEventId: record.dm.confirmationEventId,
          externalChannelId: record.externalChannelId,
          externalUserId: record.externalUserId,
          linkId: principal.linkId || '',
          linkRevision: principal.linkRevision || '',
        };
      else {
        if (admission.actor.scope === 'dm') return denied();
        actor = { ...common, guildId: admission.actor.guildId };
      }
      const policy = await authorizedPolicy(actor);
      if (!policy) return denied();
      const source = await deps.storage.readReplySource(
        actor,
        `${record.externalChannelId}:${action.messageId}`,
      );
      if (
        !source ||
        source.provider !== 'discord' ||
        source.runId !== action.reference ||
        source.principalId !== principal.userId ||
        source.externalUserId !== record.externalUserId ||
        source.linkId !== principal.linkId ||
        source.linkRevision !== principal.linkRevision
      )
        return denied();
      const mapping = {
        ...source,
        ...traceRouting(source),
        traceId: traceIdForMessage(source.langfuseRunId || source.messageId),
        centralTraceExportEnabled: source.centralTraceExportEnabled === true,
      };
      if (
        !(await isFeedbackScoreEligible({
          ...mapping,
          appConfig: policy.appConfig,
          isTemporary: mapping.isTemporary !== false,
          centralTraceExportEnabled:
            mapping.centralTraceExportEnabled && policy.centralTraceExportEnabled,
        }))
      )
        return denied();
      if (!(await authorizedPolicy(mapping))) return denied();
      return deps.storage.recordDiscordFeedback(scope, mapping, deps.now?.() ?? Date.now());
    },
  };
}
