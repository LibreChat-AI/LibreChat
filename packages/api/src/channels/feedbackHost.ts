import type { AgentChannelMethods, ChannelFeedbackStorage } from '@librechat/data-schemas';
import type { ChannelFeedbackActor, ChannelReplyMapping } from 'librechat-data-provider';
import type { ChannelPolicySubject, ChannelFeedbackPolicySnapshot } from './settings';
import type { SendFeedbackScoreParams } from '~/langfuse/feedback';
import type { ChannelMessage } from './types';
import { createChannelFeedbackService } from './feedback';
import { traceIdForMessage } from '~/langfuse/trace';

export type ChannelFeedbackMessage = ChannelMessage;
export interface ChannelFeedbackHostDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  storage: ChannelFeedbackStorage;
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

/** One trusted source projection resolves receipt and owned message without loading answer text or keys. */
export function createChannelFeedbackHost(
  deps: ChannelFeedbackHostDependencies,
): ReturnType<typeof createChannelFeedbackService> {
  function matchesSource(
    channel: Awaited<ReturnType<typeof deps.channels.getAgentChannelMetadata>>,
    actor: ChannelFeedbackActor,
  ) {
    return (
      channel?.status === 'active' &&
      (channel.tenantId || '_') === actor.tenantId &&
      channel.revision === actor.channelRevision &&
      channel.agentId === actor.agentId &&
      channel.slack?.teamId === actor.teamId
    );
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
    return policy && matchesSource(channel, actor) ? policy : null;
  }
  async function canRecord(actor: ChannelFeedbackActor): Promise<boolean> {
    return Boolean(await authorizedPolicy(actor));
  }
  return createChannelFeedbackService({
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
      await deps.sendScore({
        ...input,
        ...traceRouting(source),
        assertActive,
        appConfig: policy.appConfig,
        isTemporary: mapping.isTemporary !== false,
        centralTraceExportEnabled,
      });
    },
  });
}
