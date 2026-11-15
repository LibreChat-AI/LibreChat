import { channelConfigSchema } from 'librechat-data-provider';
import type {
  DiscordInboxRecord,
  DiscordFeedbackStorage,
  ChannelRunRecord,
} from '@librechat/data-schemas';
import type {
  DiscordInboxFence,
  ChannelRunPrincipal,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import type { ChannelFeedbackHostDependencies, ChannelFeedbackHost } from '../feedbackHost';
import { isFeedbackScoreEligible } from '~/langfuse/feedback';
import { traceIdForMessage } from '~/langfuse/trace';

/** Operational failures propagate to the existing inbox retry boundary; browser replies contain no source IDs. */
export function createDiscordFeedbackHandler(deps: {
  feedback: Pick<ChannelFeedbackHost, 'recordDiscordFeedback'>;
}): (
  record: DiscordInboxRecord,
  fence: DiscordInboxFence,
  principal: ChannelRunPrincipal,
) => Promise<DiscordPrivateReply> {
  return async (record, fence, principal) => {
    const result = await deps.feedback.recordDiscordFeedback({ record, fence, principal });
    return {
      content: result.ok ? 'Feedback received.' : 'Feedback is unavailable for this reply.',
    };
  };
}

/** Actual run principal and retained source policy, used before native final-answer controls are rendered. */
export function createDiscordFeedbackProjection(deps: {
  storage: Pick<DiscordFeedbackStorage, 'readDiscordFeedbackRunSource'>;
  getPolicy: ChannelFeedbackHostDependencies['getPolicy'];
}): (run: ChannelRunRecord) => Promise<boolean> {
  return async (run) => {
    const responseId = run.snapshot?.responseId;
    if (
      run.admission.actor.provider !== 'discord' ||
      run.admission.actor.scope !== undefined ||
      run.cancellationRequested ||
      !responseId
    )
      return false;
    const [policy, source] = await Promise.all([
      deps.getPolicy({ tenantId: run.tenantId, userId: run.principal.userId }),
      deps.storage.readDiscordFeedbackRunSource(run),
    ]);
    if (!policy || !source) return false;
    const config = channelConfigSchema.parse(policy.appConfig.endpoints?.agents?.channels ?? {});
    if (
      !config.enabled ||
      !config.discord?.enabled ||
      policy.appConfig.interfaceConfig?.feedback === false
    )
      return false;
    return isFeedbackScoreEligible({
      appConfig: policy.appConfig,
      traceId: traceIdForMessage(source.langfuseRunId || responseId),
      sampled: source.sampled === true,
      destinationIds: typeof source.sampled === 'boolean' ? source.destinationIds : [],
      isTemporary: source.isTemporary !== false,
      centralTraceExportEnabled:
        source.centralTraceExportEnabled === true && policy.centralTraceExportEnabled,
    });
  };
}
