import { useState, useCallback, useEffect, useRef } from 'react';
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

/**
 * The composer holding the page's recognizer. There is one microphone to listen to, so one
 * composer at a time: a second one that claimed it too would be handed the first one's words.
 */
let holder: object | null = null;

const useSpeechToTextBrowser = (
  setText: (text: string, takeId?: number) => void,
  onTranscriptionComplete: (text: string, takeId?: number) => void,
  onTranscriptionSettled: (takeId?: number) => void,
  autoSendText: number,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { data: speechConfig } = useGetCustomConfigSpeechQuery({ enabled: true });
  const sttExternal = Boolean(speechConfig?.sttExternal);

  const lastTranscript = useRef<string | null>(null);
  const lastInterim = useRef<string | null>(null);
  const activeTakeIdRef = useRef<number | undefined>(undefined);
  const timeoutRef = useRef<NodeJS.Timeout | null>();
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  /**
   * Whether this composer asked for the take in progress. The page has one recognizer, and
   * every composer on it is told what it hears. Only the one that started the take collects its
   * transcript and shows itself listening, so a take in one composer is never written into
   * another, or sent from it.
   */
  const [owns, setOwnsState] = useState(false);
  /** Read where no render has caught up yet: a take started and the composer gone at once. */
  const ownsRef = useRef(false);
  const self = useRef({}).current;
  const setOwns = useCallback(
    (value: boolean) => {
      if (value) {
        holder = self;
      } else if (holder === self) {
        holder = null;
      }
      ownsRef.current = value;
      setOwnsState(value);
    },
    [self],
  );
  const {
    listening,
    finalTranscript,
    resetTranscript,
    interimTranscript,
    isMicrophoneAvailable,
    browserSupportsSpeechRecognition,
  } = useSpeechRecognition({ transcribing: owns });
  const isListening = listening && owns;

  useEffect(() => {
    if (interimTranscript == null || interimTranscript === '') {
      return;
    }

    if (lastInterim.current === interimTranscript) {
      return;
    }

    setText(interimTranscript, activeTakeIdRef.current);
    lastInterim.current = interimTranscript;
  }, [setText, interimTranscript]);

  useEffect(() => {
    if (finalTranscript == null || finalTranscript === '') {
      return;
    }

    if (lastTranscript.current === finalTranscript) {
      return;
    }

    const takeId = activeTakeIdRef.current;
    setText(finalTranscript, takeId);
    lastTranscript.current = finalTranscript;
    if (autoSendText > -1 && finalTranscript.length > 0) {
      timeoutRef.current = setTimeout(() => {
        onTranscriptionComplete(finalTranscript, takeId);
        resetTranscript();
      }, autoSendText * 1000);
    }

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [setText, onTranscriptionComplete, resetTranscript, finalTranscript, autoSendText]);

  /**
   * The recognizer's final result lands in `useSpeechRecognition`'s reducer before
   * `stopListening` resolves, but reaches `setText` only through the effect above.
   * Settling from an effect declared after it, off a state update queued behind that
   * result, keeps the take busy until the final transcript is in the composer.
   */
  const [stoppedTake, setStoppedTake] = useState<{ takeId?: number } | null>(null);
  useEffect(() => {
    if (stoppedTake == null) {
      return;
    }
    setStoppedTake(null);
    onTranscriptionSettled(stoppedTake.takeId);
    setOwns(false);
  }, [stoppedTake, onTranscriptionSettled, setOwns]);

  /**
   * A take the recognizer ended by itself is over too. Declared after the effects that write a
   * transcript down, so the last words of the take, which arrive with its end, are in first.
   */
  const heard = useRef(false);
  useEffect(() => {
    if (!owns) {
      heard.current = false;
      return;
    }
    if (listening) {
      heard.current = true;
      return;
    }
    if (heard.current) {
      setOwns(false);
    }
  }, [listening, owns, setOwns]);

  const startRecording = useCallback(
    (takeId?: number) => {
      activeTakeIdRef.current = takeId;
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

      /** Another composer is recording. Its take is not this one's to share or to end. */
      if (holder != null && holder !== self) {
        showToast({ message: localize('com_ui_speech_in_use'), status: 'warning' });
        return;
      }
      setOwns(true);
      SpeechRecognition.startListening({
        language: languageSTT,
        continuous: autoTranscribeAudio,
      });
    },
    [
      self,
      setOwns,
      autoTranscribeAudio,
      browserSupportsSpeechRecognition,
      isMicrophoneAvailable,
      languageSTT,
      localize,
      showToast,
      sttExternal,
    ],
  );

  const stopRecording = useCallback(async () => {
    const takeId = activeTakeIdRef.current;
    try {
      if (hasSpeechRecognitionController(SpeechRecognition)) {
        await SpeechRecognition.stopListening();
      }
    } finally {
      setStoppedTake({ takeId });
    }
  }, []);

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
    setOwns(false);
  }, [resetTranscript, setOwns]);

  /**
   * A composer that goes away while its take is running ends it: the recognizer is the page's,
   * and would otherwise keep the microphone open with no composer showing that it is, or
   * offering to stop it. A take another composer owns is not this one's to end.
   */
  useEffect(
    () => () => {
      if (!ownsRef.current) {
        return;
      }
      ownsRef.current = false;
      if (holder === self) {
        holder = null;
      }
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (!hasSpeechRecognitionController(SpeechRecognition)) {
        return;
      }
      if (typeof SpeechRecognition.abortListening === 'function') {
        SpeechRecognition.abortListening();
      } else {
        SpeechRecognition.stopListening();
      }
    },
    [self],
  );

  return {
    isListening,
    isLoading: false,
    startRecording,
    stopRecording,
    abortRecording: abortListening,
  };
};

export default useSpeechToTextBrowser;
