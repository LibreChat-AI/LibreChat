import { useRef, useMemo, useEffect, useState } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { parseTextParts } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { Option } from '~/common';
import useTextToSpeechExternal from '~/hooks/Input/useTextToSpeechExternal';
import useTextToSpeechBrowser from '~/hooks/Input/useTextToSpeechBrowser';
import useGetAudioSettings from '~/hooks/Input/useGetAudioSettings';
import useAudioRef from '~/hooks/Audio/useAudioRef';
import { usePauseGlobalAudio } from '../Audio';
import { logger } from '~/utils';
import store from '~/store';

type TUseTextToSpeech = {
  messageId?: string;
  content?: TMessageContentParts[] | string;
  isLast?: boolean;
  index?: number;
};

const useTextToSpeech = (props?: TUseTextToSpeech) => {
  const { messageId, content, isLast = false, index = 0 } = props ?? {};

  const isMouseDownRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const [isSpeakingState, setIsSpeaking] = useState(false);
  const { audioRef } = useAudioRef({ setIsPlaying: setIsSpeaking });

  const { textToSpeechEndpoint } = useGetAudioSettings();
  const { pauseGlobalAudio } = usePauseGlobalAudio(index);
  const [voice, setVoice] = useRecoilState(store.voice);
  const globalIsPlaying = useRecoilValue(store.globalAudioPlayingFamily(index));

  const isSpeaking = isSpeakingState || (isLast && globalIsPlaying);

  const {
    generateSpeechLocal,
    cancelSpeechLocal,
    voices: voicesLocal,
  } = useTextToSpeechBrowser({ setIsSpeaking });

  const {
    generateSpeechExternal,
    cancelSpeech: cancelSpeechExternal,
    isLoading: isLoadingExternal,
    voices: voicesExternal,
  } = useTextToSpeechExternal({
    setIsSpeaking,
    audioRef,
    messageId,
    isLast,
    index,
  });

  const generateSpeech = useMemo(() => {
    const map = {
      browser: generateSpeechLocal,
      external: generateSpeechExternal,
    };

    return map[textToSpeechEndpoint];
  }, [generateSpeechExternal, generateSpeechLocal, textToSpeechEndpoint]);

  const cancelSpeech = useMemo(() => {
    const map = {
      browser: cancelSpeechLocal,
      external: cancelSpeechExternal,
    };
    return map[textToSpeechEndpoint];
  }, [cancelSpeechExternal, cancelSpeechLocal, textToSpeechEndpoint]);

  const isLoading = useMemo(() => {
    const map = {
      browser: false,
      external: isLoadingExternal,
    };
    return map[textToSpeechEndpoint];
  }, [isLoadingExternal, textToSpeechEndpoint]);

  const voices: Option[] | string[] = useMemo(() => {
    const voiceMap = {
      browser: voicesLocal,
      external: voicesExternal,
    };

    return voiceMap[textToSpeechEndpoint];
  }, [textToSpeechEndpoint, voicesExternal, voicesLocal]);

  useEffect(() => {
    const firstVoice = voices[0];
    if (voices.length && typeof firstVoice === 'object') {
      const lastSelectedVoice = voices.find((v) =>
        typeof v === 'object' ? v.value === voice : v === voice,
      );
      if (lastSelectedVoice != null) {
        const currentVoice =
          typeof lastSelectedVoice === 'object' ? lastSelectedVoice.value : lastSelectedVoice;
        logger.log('useTextToSpeech.ts - Effect:', { voices, voice: currentVoice });
        setVoice(currentVoice?.toString() ?? undefined);
        return;
      }

      logger.log('useTextToSpeech.ts - Effect:', { voices, voice: firstVoice.value });
      setVoice(firstVoice.value?.toString() ?? undefined);
    } else if (voices.length) {
      const lastSelectedVoice = voices.find((v) => v === voice);
      if (lastSelectedVoice != null) {
        logger.log('useTextToSpeech.ts - Effect:', { voices, voice: lastSelectedVoice });
        setVoice(lastSelectedVoice.toString());
        return;
      }
      logger.log('useTextToSpeech.ts - Effect:', { voices, voice: firstVoice });
      setVoice(firstVoice.toString());
    }
  }, [setVoice, textToSpeechEndpoint, voice, voices]);

  const handleMouseDown = () => {
    isMouseDownRef.current = true;
    timerRef.current = window.setTimeout(() => {
      if (isMouseDownRef.current) {
        const messageContent = content ?? '';
        const parsedMessage =
          typeof messageContent === 'string'
            ? messageContent
            : parseTextParts(messageContent, true);
        generateSpeech(parsedMessage, false);
      }
    }, 1000);
  };

  const handleMouseUp = () => {
    isMouseDownRef.current = false;
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }
  };

  const toggleSpeech = () => {
    if (isSpeaking === true) {
      cancelSpeech();
      pauseGlobalAudio();
    } else {
      const messageContent = content ?? '';
      const parsedMessage =
        typeof messageContent === 'string' ? messageContent : parseTextParts(messageContent, true);
      generateSpeech(parsedMessage, false);
    }
  };

  return {
    handleMouseDown,
    handleMouseUp,
    toggleSpeech,
    isSpeaking,
    isLoading,
    audioRef,
    voices,
  };
};

export default useTextToSpeech;
