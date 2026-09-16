import { useCallback, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useGetCustomConfigSpeechQuery } from 'librechat-data-provider/react-query';
import SpeechRecognitionImport, { useSpeechRecognition } from 'react-speech-recognition';
import { useLocalize } from '~/hooks';
import store from '~/store';

/** `abortListening` stays optional: it is not part of what makes a module a
 *  usable controller, so a build without it must still count as supported. */
type SpeechRecognitionController = Pick<
  typeof SpeechRecognitionImport,
  'startListening' | 'stopListening'
> &
  Partial<Pick<typeof SpeechRecognitionImport, 'abortListening'>>;
type SpeechRecognitionModule = Partial<SpeechRecognitionController> & {
  default?: Partial<SpeechRecognitionController>;
};

const hasSpeechRecognitionController = (
  controller?: Partial<SpeechRecognitionController>,
): controller is SpeechRecognitionController =>
  typeof controller?.startListening === 'function' &&
  typeof controller.stopListening === 'function';

const speechRecognitionModule = SpeechRecognitionImport as SpeechRecognitionModule;
const SpeechRecognition = hasSpeechRecognitionController(speechRecognitionModule)
  ? speechRecognitionModule
  : speechRecognitionModule.default;

const useSpeechToTextBrowser = (
  setText: (text: string) => void,
  onTranscriptionComplete: (text: string) => void,
  onTranscriptionSettled: () => void,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);

  const lastTranscript = useRef<string | null>(null);
  const lastInterim = useRef<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>();
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  const {
    listening,
    finalTranscript,
    resetTranscript,
    interimTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition();
  const isListening = listening;

  useEffect(() => {
    if (interimTranscript == null || interimTranscript === '') {
      return;
    }

    if (lastInterim.current === interimTranscript) {
      return;
    }

    setText(interimTranscript);
    lastInterim.current = interimTranscript;
  }, [setText, interimTranscript]);

  useEffect(() => {
    if (finalTranscript == null || finalTranscript === '') {
      return;
    }

    if (lastTranscript.current === finalTranscript) {
      return;
    }

    setText(finalTranscript);
    lastTranscript.current = finalTranscript;
    if (autoSendText > -1 && finalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(finalTranscript);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [setText, onTranscriptionComplete, resetTranscript, finalTranscript, autoSendText]);

  const startRecording = useCallback(() => {
    if (!browserSupportsSpeechRecognition) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    if (!isMicrophoneAvailable) {
      showToast({
        message: localize('com_ui_microphone_unavailable'),
        status: 'error',
      });
      return;
    }

    if (!hasSpeechRecognitionController(SpeechRecognition)) {
      showToast({
        message: sttExternal
          ? localize('com_ui_speech_not_supported_use_external')
          : localize('com_ui_speech_not_supported'),
        status: 'error',
      });
      return;
    }

    SpeechRecognition.startListening({
      language: languageSTT,
      continuous: autoTranscribeAudio,
    });
  }, [
    autoTranscribeAudio,
    browserSupportsSpeechRecognition,
    isMicrophoneAvailable,
    languageSTT,
    localize,
    showToast,
    sttExternal,
  ]);

  const stopRecording = useCallback(async () => {
    try {
      if (hasSpeechRecognitionController(SpeechRecognition)) {
        await SpeechRecognition.stopListening();
      }
    } finally {
      onTranscriptionSettled();
    }
  }, [onTranscriptionSettled]);

  /**
   * Drops the take without emitting a transcript. `abortListening` discards the
   * recogniser's buffered result, and the pending auto-send timer is cleared so
   * a transcript that already landed cannot fire after the user cancelled.
   */
  const abortListening = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    lastTranscript.current = null;
    lastInterim.current = null;
    if (hasSpeechRecognitionController(SpeechRecognition)) {
      if (typeof SpeechRecognition.abortListening === 'function') {
        SpeechRecognition.abortListening();
      } else {
        SpeechRecognition.stopListening();
      }
    }
    resetTranscript();
  }, [resetTranscript]);

  return {
    isListening,
    isLoading: false,
    startRecording,
    stopRecording,
    abortRecording: abortListening,
  };
};

export default useSpeechToTextBrowser;
