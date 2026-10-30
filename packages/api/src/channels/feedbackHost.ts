import type {
  ChannelFeedbackActor,
  ChannelReplyMapping,
  ChannelConfig,
} from 'librechat-data-provider';
import type {
  AppConfig,
  AgentChannelMethods,
  ChannelFeedbackStorage,
} from '@librechat/data-schemas';
import type { SendFeedbackScoreParams } from '~/langfuse/feedback';
import type { ChannelMessage } from './types';
import { createChannelFeedbackService } from './feedback';
import { traceIdForMessage } from '~/langfuse/trace';

export type ChannelFeedbackMessage = ChannelMessage;
export interface ChannelFeedbackHostDependencies {
  channels: Pick<AgentChannelMethods, 'getAgentChannelMetadata'>;
  storage: ChannelFeedbackStorage;
  getConfig: () => Promise<Pick<ChannelConfig, 'enabled'>>;
  getAppConfig: (tenantId: string, principalId?: string) => Promise<AppConfig | undefined>;
  currentTracePolicy: (principal: {
    tenantId: string;
    userId: string;
  }) => Promise<{ centralTraceExportEnabled: boolean } | null>;
  sendScore: (input: SendFeedbackScoreParams) => Promise<void>;
  maxConflictRetries: number;
  exportTimeoutMs: number;
  exportLeaseMs: number;
  exportRetryMs: number;
  now?: () => number;
}

/** One trusted source projection resolves receipt and owned message without loading answer text or keys. */
export function createChannelFeedbackHost(
  deps: ChannelFeedbackHostDependencies,
): ReturnType<typeof createChannelFeedbackService> {
  async function authorizedConfig(
    actor: ChannelFeedbackActor & Partial<Pick<ChannelReplyMapping, 'principalId'>>,
  ): Promise<AppConfig | undefined> {
    const [channel, config, runtime] = await Promise.all([
      deps.channels.getAgentChannelMetadata(actor.channelId),
      deps.getAppConfig(actor.tenantId, actor.principalId),
      deps.getConfig(),
    ]);
    return runtime.enabled &&
      config &&
      config.interfaceConfig?.feedback !== false &&
      channel?.status === 'active' &&
      (channel.tenantId || '_') === actor.tenantId &&
      channel.revision === actor.channelRevision &&
      channel.agentId === actor.agentId &&
      channel.slack?.teamId === actor.teamId
      ? config
      : undefined;
  }
  async function canRecord(actor: ChannelFeedbackActor): Promise<boolean> {
    return Boolean(await authorizedConfig(actor));
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
    now: deps.now,
    canRecord,
    resolveReply: async (actor, key) => {
      const source = await deps.storage.readReplySource(actor, key);
      if (!source) return null;
      return {
        ...source,
        sampled: source.sampled === true,
        destinationIds: source.destinationIds ?? [],
        traceId: traceIdForMessage(source.langfuseRunId || source.messageId),
        centralTraceExportEnabled: await centralAllowed(source),
      };
    },
    sendScore: async (input, mapping) => {
      input.assertActive();
      const appConfig = await authorizedConfig(mapping);
      if (!appConfig) throw new Error('Channel feedback policy changed');
      input.assertActive();
      const centralTraceExportEnabled =
        input.centralTraceExportEnabled === true && (await centralAllowed(mapping));
      input.assertActive();
      if (!(await deps.storage.isAuthorityCurrent(mapping)))
        throw new Error('Channel feedback authority changed');
      input.assertActive();
      await deps.sendScore({
        ...input,
        appConfig,
        isTemporary: mapping.isTemporary !== false,
        centralTraceExportEnabled,
      });
    },
  });
}
