import type {
  AppConfig,
  AgentChannelMethods,
  ChannelFeedbackStorage,
  ChannelRunStorage,
} from '@librechat/data-schemas';
import type { ChannelFeedbackActor, ChannelReplyMapping } from 'librechat-data-provider';
import type { SendFeedbackScoreParams } from '~/langfuse/feedback';
import type { ChannelMessage } from './types';
import { createChannelFeedbackService } from './feedback';
import { traceIdForMessage } from '~/langfuse/trace';

export type ChannelFeedbackMessage = ChannelMessage;

export interface ChannelFeedbackHostDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannel'>;
  runs: Pick<ChannelRunStorage, 'findDeliveredReply'>;
  storage: ChannelFeedbackStorage;
  getAppConfig: (tenantId: string) => Promise<AppConfig | undefined>;
  getMessage: (filter: {
    user: string;
    tenantId: string;
    conversationId: string;
    messageId: string;
  }) => Promise<ChannelFeedbackMessage | null>;
  /** An absent or unavailable export policy is not permission to export feedback. */
  currentTracePolicy: (principal: {
    tenantId: string;
    userId: string;
  }) => Promise<{ centralTraceExportEnabled: boolean } | null>;
  sendScore: (input: SendFeedbackScoreParams) => Promise<void>;
  maxConflictRetries: number;
  exportTimeoutMs: number;
  exportLeaseMs: number;
  exportRetryMs: number;
}

/** Resolves only stored, delivered assistant messages; never trusts gateway conversation/trace IDs. */
export function createChannelFeedbackHost(
  deps: ChannelFeedbackHostDependencies,
): ReturnType<typeof createChannelFeedbackService> {
  async function canRecord(actor: ChannelFeedbackActor): Promise<boolean> {
    const [channel, config] = await Promise.all([
      deps.channels.getAgentChannel(actor.channelId),
      deps.getAppConfig(actor.tenantId),
    ]);
    return (
      !!config &&
      config.interfaceConfig?.feedback !== false &&
      config.endpoints?.agents?.channels?.enabled === true &&
      channel?.status === 'active' &&
      (channel.tenantId ?? '_') === actor.tenantId &&
      channel.revision === actor.channelRevision &&
      channel.agentId === actor.agentId &&
      channel.slack?.teamId === actor.teamId
    );
  }
  async function centralAllowed(
    mapping: Pick<ChannelReplyMapping, 'tenantId' | 'principalId'>,
  ): Promise<boolean> {
    try {
      return (
        (await deps.currentTracePolicy({ tenantId: mapping.tenantId, userId: mapping.principalId }))
          ?.centralTraceExportEnabled === true
      );
    } catch {
      return false;
    }
  }
  return createChannelFeedbackService({
    storage: deps.storage,
    maxConflictRetries: deps.maxConflictRetries,
    exportTimeoutMs: deps.exportTimeoutMs,
    exportLeaseMs: deps.exportLeaseMs,
    exportRetryMs: deps.exportRetryMs,
    canRecord,
    resolveReply: async (actor, runId, externalMessageKey) => {
      const run = await deps.runs.findDeliveredReply(
        actor.tenantId,
        actor.channelId,
        externalMessageKey,
      );
      if (
        !run ||
        run.runId !== runId ||
        run.state !== 'delivered' ||
        run.tenantId !== actor.tenantId ||
        run.channelId !== actor.channelId ||
        run.agentId !== actor.agentId ||
        run.principal.channelRevision !== actor.channelRevision ||
        run.admission.actor.teamId !== actor.teamId ||
        !run.receipts.some(
          (receipt) =>
            receipt.outcome === 'confirmed' && receipt.externalMessageKey === externalMessageKey,
        ) ||
        !run.snapshot?.responseId ||
        !run.execution?.conversationId
      )
        return null;
      const message = await deps.getMessage({
        tenantId: actor.tenantId,
        user: run.principal.userId,
        conversationId: run.execution.conversationId,
        messageId: run.snapshot.responseId,
      });
      if (
        !message ||
        message.isCreatedByUser !== false ||
        message.user !== run.principal.userId ||
        (message.tenantId ?? '_') !== actor.tenantId ||
        message.messageId !== run.snapshot.responseId ||
        message.conversationId !== run.execution.conversationId
      )
        return null;
      return {
        ...actor,
        externalMessageKey,
        runId,
        responseId: run.snapshot.responseId,
        messageId: message.messageId,
        conversationId: message.conversationId,
        principalId: run.principal.userId,
        traceId: traceIdForMessage(message.langfuseRunId || message.messageId),
        isTemporary: message.isTemporary,
        sampled: message.langfuseSampled === true,
        // Missing destination provenance is unavailable, not permission to route to newly configured projects.
        destinationIds: message.langfuseDestinationIds ?? [],
        centralTraceExportEnabled: await centralAllowed({
          tenantId: actor.tenantId,
          principalId: run.principal.userId,
        }),
      };
    },
    sendScore: async (input, mapping) => {
      if (!(await canRecord(mapping))) throw new Error('Channel feedback policy changed');
      const appConfig = await deps.getAppConfig(mapping.tenantId);
      await deps.sendScore({
        ...input,
        appConfig,
        // Legacy mappings without privacy provenance require explicit temporary-chat export consent.
        isTemporary: mapping.isTemporary !== false,
        centralTraceExportEnabled:
          input.centralTraceExportEnabled === true && (await centralAllowed(mapping)),
      });
    },
  });
}
