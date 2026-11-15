import type {
  DiscordInboxFence,
  ChannelRunPrincipal,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import type { DiscordInboxRecord } from '@librechat/data-schemas';
import type { ChannelFeedbackHost } from '../feedbackHost';

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
