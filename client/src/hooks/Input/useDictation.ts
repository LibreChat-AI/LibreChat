import { useRef, useMemo, useState, useEffect, useCallback } from 'react';
import { useToastContext } from '@librechat/client';
import type { TAskFunction } from '~/common';
import useGetAudioSettings from './useGetAudioSettings';
import { useChatFormContext } from '~/Providers';
import useSpeechToText from './useSpeechToText';
import { globalAudioId } from '~/common';
import useLocalize from '../useLocalize';

const isExternalSTT = (speechToTextEndpoint: string) => speechToTextEndpoint === 'external';

/** How the in-flight transcription should be spent once recording ends. */
type StopMode = 'compose' | 'send' | 'cancel';

export interface Dictation {
  active: boolean;
  transcribing: boolean;
  /** The composer is free, but a discarded external request still owns STT. */
  startDisabled: boolean;
  elapsed: number;
  start: () => void;
  /** Drop the take and restore whatever draft was there before. */
  cancel: () => void;
  /** Transcribe into the composer and stop, leaving the turn unsent. */
  stopToComposer: () => void;
  /** Transcribe and send in one action. */
  stopAndSend: () => void;
}

/**
 * Speech capture for the composer, owning the whole recording lifecycle so the
 * bar can hand its existing buttons over to it: `+` becomes cancel, the mic
 * becomes stop, and send transcribes and sends in one action.
 *
 * Stopping and sending are deliberately separate. Previously the only control
 * submitted whatever had been heard, with no way to review it first and no way
 * to back out at all.
 */
export default function useDictation({
  ask,
  methods,
  isSubmitting,
  filesLoading = false,
  deferComposerReset = false,
  disabled = false,
  autoSendText,
  speechToText,
}: {
  ask: TAskFunction;
  methods: ReturnType<typeof useChatFormContext>;
  isSubmitting: boolean;
  /** Attachments still uploading. Send and steer both refuse to submit while
   *  this is true, and a dictated turn must not be the one path that lets a
   *  half-uploaded file ride along. */
  filesLoading?: boolean;
  /** The accepted submission owns composer cleanup asynchronously. Keep this
   *  take spent while leaving its transcript until that owner confirms it. */
  deferComposerReset?: boolean;
  /** Host-owned speech and composer gates, including settings hydration. */
  disabled?: boolean;
  /** Host-owned Auto Send Text preference. */
  autoSendText: number;
  /** Host-owned Speech to Text preference. */
  speechToText: boolean;
}): Dictation {
  const { setValue, reset, getValues } = methods;
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { speechToTextEndpoint } = useGetAudioSettings();
  /** The Auto Send Text setting, which submits a plain recording once its
   *  transcript settles. A stop that was never asked to send still honours it. */
  const autoSendEnabled = autoSendText > -1;

  const existingTextRef = useRef<string>('');
  const isSubmittingRef = useRef(isSubmitting);
  isSubmittingRef.current = isSubmitting;
  const filesLoadingRef = useRef(filesLoading);
  filesLoadingRef.current = filesLoading;
  const deferComposerResetRef = useRef(deferComposerReset);
  deferComposerResetRef.current = deferComposerReset;
  /** Read when the transcription lands, which is after the stop that set it.
   *  The speech hooks have no notion of cancelling or of deferring a send. */
  const modeRef = useRef<StopMode>('compose');
  /** One submission per take. Both the settle fallback below and a late
   *  auto-send callback can reach the same transcript, and whichever gets
   *  there first is the one that spends it. */
  const spentRef = useRef(false);
  /** Whether this take produced any words at all. A transcription that fails,
   *  or a take too short to reach the engine, reports nothing back and leaves
   *  the composer holding the draft that was there before recording, which an
   *  armed stop-and-send would then send as if it had been dictated. */
  const heardRef = useRef(false);

  const submit = useCallback(
    (text: string) => {
      if (spentRef.current || !text) {
        return;
      }
      if (isSubmittingRef.current) {
        showToast({ message: localize('com_ui_speech_while_submitting'), status: 'error' });
        return;
      }
      /* The transcript stays in the composer so the turn can be sent by hand
         once the upload finishes, rather than going out without its file. */
      if (filesLoadingRef.current) {
        showToast({ message: localize('com_ui_speech_while_uploading'), status: 'error' });
        return;
      }
      spentRef.current = true;
      const globalAudio = document.getElementById(globalAudioId) as HTMLAudioElement | null;
      if (globalAudio) {
        globalAudio.muted = false;
      }
      const submitted = ask({ text });
      if (submitted === false) {
        spentRef.current = false;
        return;
      }
      if (deferComposerResetRef.current) {
        return;
      }
      reset({ text: '' });
      existingTextRef.current = '';
    },
    [ask, reset, showToast, localize],
  );

  const onTranscriptionComplete = useCallback(
    (text: string) => {
      const mode = modeRef.current;

      if (text) {
        heardRef.current = true;
      }

      if (mode === 'cancel') {
        /* The draft stays on the ref until a take is actually spent: an
           external transcription already in flight cannot be recalled, and
           clearing it at cancel time left this reset wiping the very draft the
           cancel had just put back. */
        reset({ text: existingTextRef.current });
        return;
      }

      /** For external STT, append existing text to the transcription */
      const finalText =
        isExternalSTT(speechToTextEndpoint) && existingTextRef.current
          ? `${existingTextRef.current} ${text}`
          : text;

      if (mode === 'compose' && !autoSendEnabled) {
        if (finalText) {
          setValue('text', finalText, { shouldValidate: true });
        }
        existingTextRef.current = '';
        return;
      }

      submit(finalText);
    },
    [reset, setValue, submit, autoSendEnabled, speechToTextEndpoint],
  );

  const setText = useCallback(
    (text: string) => {
      if (modeRef.current === 'cancel') {
        return;
      }
      if (text) {
        heardRef.current = true;
      }
      setValue('text', existingTextRef.current ? `${existingTextRef.current} ${text}` : text, {
        shouldValidate: true,
      });
    },
    [setValue],
  );

  const [settling, setSettling] = useState(false);
  const onTranscriptionSettled = useCallback(() => setSettling(false), []);
  const { isListening, isLoading, startRecording, stopRecording, abortRecording } = useSpeechToText(
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
  );

  const active = isListening === true;

  /* Bridges the gap between the recorder being told to stop and the upload
     starting: `isListening` clears synchronously, while the recorder's own
     `stop` event, which is what begins the transcription request, arrives a
     tick later. Without this the composer reads as idle for that tick and every
     control it had put away flashes back in and out again. */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [active]);

  /* The engines only report a completed transcription when Auto Send Text is
     configured, so an explicit stop-and-send cannot wait for that callback:
     with the default setting it never arrives. Instead the send is armed here
     and spent once the take has fully settled, reading whatever the transcript
     put in the composer. */
  const [pendingSend, setPendingSend] = useState(false);
  useEffect(() => {
    if (!pendingSend || active || isLoading === true || settling) {
      return;
    }
    setPendingSend(false);
    /* Nothing was heard: the request failed, or the take never reached the
       engine. The engines report that themselves, so the send simply stands
       down rather than sending the pre-recording draft in its place. */
    if (!heardRef.current) {
      return;
    }
    submit(getValues('text') || '');
  }, [pendingSend, active, isLoading, settling, submit, getValues]);

  /* A discarded request can remain in React Query's loading state until the
     network settles. It no longer owns the composer once cancel is pressed. */
  const [discarded, setDiscarded] = useState(false);

  const start = useCallback(() => {
    if (disabled || isLoading === true || settling) {
      /* Do not re-arm the canceled take before its late callback arrives. */
      return;
    }
    modeRef.current = 'compose';
    spentRef.current = false;
    heardRef.current = false;
    setDiscarded(false);
    setPendingSend(false);
    existingTextRef.current = getValues('text') || '';
    startRecording();
  }, [disabled, getValues, isLoading, settling, startRecording]);

  /* Only a running take can be stopped. The bar disables these controls once a
     transcription is in flight, and this is the same rule stated where the mode
     is actually written: a second stop would otherwise rewrite how a take that
     was already committed gets spent. */
  const activeRef = useRef(active);
  activeRef.current = active;
  const stopWith = useCallback(
    (mode: StopMode) => {
      if (!activeRef.current) {
        return;
      }
      modeRef.current = mode;
      setSettling(true);
      if (mode === 'send') {
        setPendingSend(true);
      }
      stopRecording();
    },
    [stopRecording],
  );

  /* A real abort, not a stop that throws the result away: stopping would still
     hand the audio to the transcription request and flash "Transcribing" before
     discarding it. The mode flag stays set as a backstop in case a transcript
     that was already in flight lands anyway. */
  const cancel = useCallback(() => {
    modeRef.current = 'cancel';
    spentRef.current = true;
    setDiscarded(true);
    setSettling(false);
    setPendingSend(false);
    abortRecording();
    reset({ text: existingTextRef.current });
  }, [abortRecording, reset]);

  const stopToComposer = useCallback(() => stopWith('compose'), [stopWith]);
  const stopAndSend = useCallback(() => stopWith('send'), [stopWith]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        disabled ||
        speechToText !== true ||
        event.code !== 'KeyL' ||
        !event.shiftKey ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      event.preventDefault();
      if (activeRef.current) {
        stopToComposer();
      } else {
        start();
      }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, [disabled, speechToText, start, stopToComposer]);

  /* Memoized so `memo(Bar)` has something that can compare equal: a fresh
     object here re-rendered the whole bar on every keystroke in the composer. */
  return useMemo(
    () => ({
      active,
      transcribing: !discarded && (isLoading === true || settling),
      startDisabled: disabled || isLoading === true || settling,
      elapsed,
      start,
      cancel,
      stopToComposer,
      stopAndSend,
    }),
    [
      active,
      discarded,
      disabled,
      isLoading,
      settling,
      elapsed,
      start,
      cancel,
      stopToComposer,
      stopAndSend,
    ],
  );
}
