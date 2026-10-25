import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useIsSubmitting } from '@librechat/chat/react';
import { getSpeechText } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import store from '~/store';

export type TAutoplayTrigger = {
  /** Whether the latest assistant message is finalized and its run has not been played yet */
  shouldPlay: boolean;
  activeRunId: string | null;
  latestMessage: TMessage | null;
};

/**
 * Shared "Autoplay Latest Message" gate so every TTS engine autoplays on identical terms:
 * the run must be finished, the branch tail must be a persisted assistant message carrying
 * speakable text (reasoning alone is not), and its run must not have been played already.
 */
export default function useAutoplayTrigger(index: string | number = 0): TAutoplayTrigger {
  const activeRunId = useAtomValue(activeRunFamily(index));
  const audioRunId = useRecoilValue(store.audioRunFamily(index));
  const isSubmitting = useIsSubmitting(index);
  const latestMessage = useLatestMessage(index);

  const shouldPlay = !!(
    !isSubmitting &&
    latestMessage &&
    latestMessage.isCreatedByUser !== true &&
    getSpeechText(latestMessage) &&
    latestMessage.messageId &&
    !latestMessage.messageId.includes('_') &&
    activeRunId != null &&
    activeRunId !== audioRunId
  );

  return { shouldPlay, activeRunId, latestMessage };
}
