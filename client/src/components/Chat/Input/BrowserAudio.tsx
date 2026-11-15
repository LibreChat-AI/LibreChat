import { useCallback } from 'react';
import { useSetRecoilState } from 'recoil';
import { useParams } from 'react-router-dom';
import { BrowserAudio as BrowserAudioDriver } from '@librechat/chat/components';
import useTextToSpeechBrowser from '~/hooks/Input/useTextToSpeechBrowser';
import useAutoplayTrigger from '~/hooks/Audio/useAutoplayTrigger';
import { logger } from '~/utils';
import store from '~/store';

/**
 * Autoplay driver for the Browser TTS engine. `StreamAudio` covers the external engine by
 * streaming server audio into the global `<audio>` element; the Web Speech API has no such
 * element, so the utterance is spoken directly off the shared autoplay gate.
 */
export default function BrowserAudio({ index = 0 }) {
  const { conversationId: paramId } = useParams();
  const setIsSpeaking = useSetRecoilState(store.globalAudioPlayingFamily(index));
  const setAudioRunId = useSetRecoilState(store.audioRunFamily(index));

  const { shouldPlay, activeRunId, latestMessage } = useAutoplayTrigger(index);
  const { generateSpeechLocal, cancelSpeechLocal } = useTextToSpeechBrowser({ setIsSpeaking });

  const messageId = latestMessage?.messageId;
  const speak = useCallback(
    (text: string) => {
      logger.log('BrowserAudio.tsx - speaking message:', messageId);
      return generateSpeechLocal(text);
    },
    [generateSpeechLocal, messageId],
  );

  return (
    <BrowserAudioDriver
      routeKey={paramId}
      shouldPlay={shouldPlay}
      activeRunId={activeRunId}
      latestMessage={latestMessage}
      speak={speak}
      cancel={cancelSpeechLocal}
      onStarted={setAudioRunId}
    />
  );
}
