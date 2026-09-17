import { useState, useEffect, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useSpeechToTextMutation } from '~/data-provider';
import store from '~/store';

export const getBestSupportedMimeType = (
  isTypeSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type),
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
) => {
  const types = [
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/mp4',
  ];

  for (const type of types) {
    if (isTypeSupported(type)) {
      return type;
    }
  }

  const ua = userAgent.toLowerCase();
  if (ua.indexOf('safari') !== -1 && ua.indexOf('chrome') === -1) {
    return 'audio/mp4';
  } else if (ua.indexOf('firefox') !== -1) {
    return 'audio/ogg';
  }

  return 'audio/webm';
};

const useSpeechToTextExternal = (
  setText: (text: string, takeId?: number) => void,
  onTranscriptionComplete: (text: string, takeId?: number) => void,
  onTranscriptionSettled: (takeId?: number) => void,
) => {
  const { showToast } = useToastContext();
  const audioStream = useRef<MediaStream | null>(null);
  const animationFrameIdRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  const audioChunksRef = useRef<Blob[]>([]);
  /** Read by the recorder's `stop` handler, which fires a tick after the call
   *  that ended capture and cannot otherwise tell an abort from a stop. */
  const abortedRef = useRef(false);
  /** Cleared on unmount so a queued auto-send cannot fire into a gone composer. */
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards the async permission request: a stream that resolves after unmount
   *  would otherwise hold the microphone open with nothing left to stop it. */
  const isMountedRef = useRef(true);
  /** The type the recorder was actually constructed with. `handleStop` runs
   *  from a listener registered at start, so state read there is a render
   *  behind and could pack the blob as a format the audio is not in. */
  const audioMimeTypeRef = useRef<string>('');
  const recordingTakeIdRef = useRef<number | undefined>(undefined);
  const [isListening, setIsListening] = useState(false);
  const [isRequestBeingMade, setIsRequestBeingMade] = useState(false);

  const [minDecibels] = useRecoilState(store.decibelValue);
  const [autoSendText] = useRecoilState(store.autoSendText);
  const [languageSTT] = useRecoilState<string>(store.languageSTT);
  const [speechToText] = useRecoilState<boolean>(store.speechToText);
  const [autoTranscribeAudio] = useRecoilState<boolean>(store.autoTranscribeAudio);

  const { mutate: processAudio, isLoading: isProcessing } = useSpeechToTextMutation();

  const getFileExtension = (mimeType: string) => {
    if (mimeType.includes('mp4')) {
      return 'm4a';
    } else if (mimeType.includes('ogg')) {
      return 'ogg';
    } else if (mimeType.includes('wav')) {
      return 'wav';
    } else {
      return 'webm';
    }
  };

  const cleanup = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current = null;
    }
  };

  const getMicrophonePermission = async () => {
    try {
      const streamData = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      if (!isMountedRef.current) {
        streamData?.getTracks().forEach((track) => track.stop());
        return;
      }
      audioStream.current = streamData ?? null;
    } catch {
      audioStream.current = null;
    }
  };

  const handleStop = () => {
    if (abortedRef.current) {
      abortedRef.current = false;
      audioChunksRef.current = [];
      cleanup();
      return;
    }

    if (audioChunksRef.current.length > 0) {
      const audioBlob = new Blob(audioChunksRef.current, { type: audioMimeTypeRef.current });
      const fileExtension = getFileExtension(audioMimeTypeRef.current);

      audioChunksRef.current = [];

      const formData = new FormData();
      formData.append('audio', audioBlob, `audio.${fileExtension}`);
      if (languageSTT) {
        formData.append('language', languageSTT);
      }
      setIsRequestBeingMade(true);
      cleanup();
      const takeId = recordingTakeIdRef.current;
      processAudio(formData, {
        onSuccess: (data) => {
          if (!isMountedRef.current) {
            return;
          }
          const extractedText = data.text;
          setText(extractedText, takeId);
          setIsRequestBeingMade(false);
          onTranscriptionSettled(takeId);
          if (autoSendText > -1 && speechToText && extractedText.length > 0) {
            if (autoSendTimerRef.current != null) {
              clearTimeout(autoSendTimerRef.current);
              autoSendTimerRef.current = null;
            }
            autoSendTimerRef.current = setTimeout(() => {
              autoSendTimerRef.current = null;
              onTranscriptionComplete(extractedText, takeId);
            }, autoSendText * 1000);
          }
        },
        onError: () => {
          showToast({
            message: 'An error occurred while processing the audio, maybe the audio was too short',
            status: 'error',
          });
          setIsRequestBeingMade(false);
          onTranscriptionSettled(takeId);
        },
      });
    } else {
      showToast({ message: 'The audio was too short', status: 'warning' });
      onTranscriptionSettled(recordingTakeIdRef.current);
    }
  };

  const monitorSilence = (stream: MediaStream, stopRecording: () => void) => {
    /* Held so it can be closed again: without this the ref below is never
       assigned, its guard is always true, and every take leaves another audio
       context open until the browser refuses to grant one. */
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const audioStreamSource = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.minDecibels = minDecibels;
    audioStreamSource.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const domainData = new Uint8Array(bufferLength);
    let lastSoundTime = Date.now();

    const detectSound = () => {
      analyser.getByteFrequencyData(domainData);
      const isSoundDetected = domainData.some((value) => value > 0);

      if (isSoundDetected) {
        lastSoundTime = Date.now();
      }

      const timeSinceLastSound = Date.now() - lastSoundTime;
      const isOverSilenceThreshold = timeSinceLastSound > 3000;

      if (isOverSilenceThreshold) {
        stopRecording();
        return;
      }

      animationFrameIdRef.current = window.requestAnimationFrame(detectSound);
    };

    animationFrameIdRef.current = window.requestAnimationFrame(detectSound);
  };

  /** Stops and drops the capture this hook owns; safe to call more than once. */
  const releaseAudioStream = () => {
    audioStream.current?.getTracks().forEach((track) => track.stop());
    audioStream.current = null;
  };

  const startRecording = async (takeId?: number) => {
    recordingTakeIdRef.current = takeId;
    if (isRequestBeingMade) {
      showToast({ message: 'A request is already being made. Please wait.', status: 'warning' });
      return;
    }

    /* Checked before the microphone is requested, and here rather than in
       `externalStartRecording`, so every caller — the mic button, the dictation
       shortcut, an auto-start — is covered. A webview that exposes
       `getUserMedia` without `MediaRecorder` would otherwise hold a live
       capture that no Stop control can reach: construction throws after
       permission is granted, `isListening` stays false, and the tracks run
       until the composer unmounts. */
    if (typeof MediaRecorder === 'undefined') {
      showToast({ message: 'MediaRecorder is not supported in this browser', status: 'error' });
      return;
    }

    if (!audioStream.current) {
      await getMicrophonePermission();
    }

    if (audioStream.current) {
      try {
        audioChunksRef.current = [];
        abortedRef.current = false;
        const bestMimeType = getBestSupportedMimeType();
        audioMimeTypeRef.current = bestMimeType;

        mediaRecorderRef.current = new MediaRecorder(audioStream.current, {
          mimeType: bestMimeType,
        });
        mediaRecorderRef.current.addEventListener('dataavailable', (event: BlobEvent) => {
          audioChunksRef.current.push(event.data);
        });
        mediaRecorderRef.current.addEventListener('stop', handleStop);
        mediaRecorderRef.current.start(100);
        if (!audioContextRef.current && autoTranscribeAudio && speechToText) {
          monitorSilence(audioStream.current, stopRecording);
        }
        setIsListening(true);
      } catch (error) {
        /* The recorder never started, so nothing else will release the stream:
           `stopRecording` returns early without a recorder and unmount cleanup
           is the only other path. Leaving it open keeps the microphone light on
           behind a UI that offers no way to stop it. */
        releaseAudioStream();
        cleanup();
        showToast({ message: `Error starting recording: ${error}`, status: 'error' });
      }
    } else {
      showToast({ message: 'Microphone permission not granted', status: 'error' });
    }
  };

  /** Releases the silence monitor's audio graph; safe to call more than once. */
  const closeAudioContext = () => {
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context != null && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
  };

  const stopRecording = () => {
    if (!mediaRecorderRef.current) {
      return;
    }

    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();

      audioStream.current?.getTracks().forEach((track) => track.stop());
      audioStream.current = null;

      if (animationFrameIdRef.current !== null) {
        window.cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }
      closeAudioContext();

      setIsListening(false);
    } else {
      showToast({ message: 'MediaRecorder is not recording', status: 'error' });
    }
  };
  const externalStartRecording = (takeId?: number) => {
    if (isListening) {
      showToast({ message: 'Already listening. Please stop recording first.', status: 'warning' });
      return;
    }

    void startRecording(takeId);
  };

  const externalStopRecording = () => {
    if (!isListening) {
      showToast({
        message: 'Not currently recording. Please start recording first.',
        status: 'warning',
      });
      return;
    }

    stopRecording();
  };

  /**
   * Drops the take without transcribing it. `handleStop` is where the audio is
   * packed into a FormData and uploaded, so an abort has to reach it: the flag
   * is what stops a discarded take from spending a transcription request.
   */
  const externalAbortRecording = () => {
    abortedRef.current = true;
    audioChunksRef.current = [];

    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }

    audioStream.current?.getTracks().forEach((track) => track.stop());
    audioStream.current = null;

    if (animationFrameIdRef.current !== null) {
      window.cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    closeAudioContext();

    setIsListening(false);
  };

  /* Navigating away mid-take ends neither path above: the recorder keeps
     running, the microphone tracks stay live, the silence monitor keeps
     scheduling frames, and the audio graph outlives the page that opened it.
     Refs only, so the empty dependency list holds no stale closure. */
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;

      if (autoSendTimerRef.current) {
        clearTimeout(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }

      abortedRef.current = true;
      audioChunksRef.current = [];

      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      mediaRecorderRef.current = null;

      audioStream.current?.getTracks().forEach((track) => track.stop());
      audioStream.current = null;

      if (animationFrameIdRef.current !== null) {
        window.cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }

      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context != null && context.state !== 'closed') {
        void context.close().catch(() => undefined);
      }
    };
  }, []);

  return {
    isListening,
    externalStopRecording,
    externalAbortRecording,
    externalStartRecording,
    isLoading: isProcessing,
  };
};

export default useSpeechToTextExternal;
