import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useRecoilValue } from 'recoil';
import { useToastContext } from '@librechat/client';
import { RealtimeTranscriptionErrorCode } from 'librechat-data-provider';
import { useRealtimeTranscriptionMutation } from '~/data-provider';
import { monitorSilence } from './silence';
import useLocalize from '../useLocalize';
import store from '~/store';

/** Where the live session stands while it is not simply listening. */
export type SpeechConnection = 'connecting' | 'reconnecting' | null;

/** The event channel the Realtime API reads and writes. */
const EVENTS_CHANNEL = 'oai-events';
/** Microphone audio travels by RTP while the commit travels on the data channel, so
 *  the last words spoken before Stop can still be in flight when the commit lands. */
export const COMMIT_GRACE_MS = 300;
/** How long a committed take may wait for its final transcript before it is
 *  settled with whatever text has already arrived. */
export const COMPLETION_TIMEOUT_MS = 15000;

type LiveTake = {
  takeId?: number;
  stream: MediaStream | null;
  pc: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  /** Item ids in the order they were first heard, so text never reorders. */
  order: string[];
  text: Map<string, string>;
  completed: Set<string>;
  /** Set once Stop has asked the provider to finalize the buffer. */
  committing: boolean;
  /** The item the commit produced; its completion ends the take. */
  awaitedItem: string | null;
  timers: ReturnType<typeof setTimeout>[];
  stopSilence: (() => void) | null;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (!axios.isAxiosError(error)) {
    return undefined;
  }
  const data = error.response?.data as { error?: unknown } | undefined;
  return typeof data?.error === 'string' ? data.error : undefined;
};

const isPermissionError = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === 'NotAllowedError' || error.name === 'SecurityError');

/** The transcript so far, one item after another. */
const transcriptOf = (take: LiveTake) =>
  take.order
    .map((id) => take.text.get(id)?.trim() ?? '')
    .filter(Boolean)
    .join(' ');

/**
 * Live dictation over a Realtime transcription session. The browser streams the
 * microphone to the provider over WebRTC; the server opens the session, so no
 * credential reaches the page. Text is written into the composer as it is heard,
 * and Stop commits the buffer so the provider can finalize it.
 *
 * Live transcripts go straight from the provider to the browser: unlike recorded
 * audio, they do not pass through the server on their way into the composer.
 */
const useSpeechToTextRealtime = (
  setText: (text: string, takeId?: number) => void,
  onTranscriptionComplete: (text: string, takeId?: number) => void,
  onTranscriptionSettled: (takeId?: number) => void,
  autoSendText: number,
) => {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [connection, setConnection] = useState<SpeechConnection>(null);

  const minDecibels = useRecoilValue(store.decibelValue);
  const languageSTT = useRecoilValue<string>(store.languageSTT);
  const speechToText = useRecoilValue<boolean>(store.speechToText);
  const autoTranscribeAudio = useRecoilValue<boolean>(store.autoTranscribeAudio);

  const { mutateAsync: openSession } = useRealtimeTranscriptionMutation();

  const takeRef = useRef<LiveTake | null>(null);
  const isMountedRef = useRef(true);
  /** Cleared on unmount so a queued auto-send cannot fire into a gone composer. */
  const autoSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Session events arrive through handlers bound when the take started; they read
   *  the newest callbacks and settings from here rather than from that render. */
  const latest = useRef({
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
    autoSendText,
    speechToText,
    autoTranscribeAudio,
    minDecibels,
    showToast,
    localize,
  });
  latest.current = {
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
    autoSendText,
    speechToText,
    autoTranscribeAudio,
    minDecibels,
    showToast,
    localize,
  };

  const toastError = (key: Parameters<typeof localize>[0]) => {
    const { showToast, localize } = latest.current;
    showToast({ message: localize(key), status: 'error' });
  };

  /** Stops the microphone and closes the session; safe to call more than once. */
  const release = (take: LiveTake) => {
    take.timers.forEach(clearTimeout);
    take.timers = [];
    take.stopSilence?.();
    take.stopSilence = null;
    take.stream?.getTracks().forEach((track) => track.stop());
    take.stream = null;
    if (take.channel) {
      take.channel.onopen = null;
      take.channel.onclose = null;
      take.channel.onmessage = null;
      take.channel.close();
      take.channel = null;
    }
    if (take.pc) {
      take.pc.onconnectionstatechange = null;
      take.pc.close();
      take.pc = null;
    }
  };

  /** Ends the current take and hands its transcript to the composer. */
  const finish = (take: LiveTake, { autoSend }: { autoSend: boolean }) => {
    if (takeRef.current !== take) {
      return;
    }
    takeRef.current = null;
    release(take);
    if (!isMountedRef.current) {
      return;
    }
    setIsListening(false);
    setIsLoading(false);
    setConnection(null);

    const { autoSendText, speechToText } = latest.current;
    const text = transcriptOf(take);
    if (text) {
      latest.current.setText(text, take.takeId);
    }
    latest.current.onTranscriptionSettled(take.takeId);

    if (!autoSend || autoSendText < 0 || !speechToText || !text) {
      return;
    }
    if (autoSendTimerRef.current != null) {
      clearTimeout(autoSendTimerRef.current);
    }
    autoSendTimerRef.current = setTimeout(() => {
      autoSendTimerRef.current = null;
      latest.current.onTranscriptionComplete(text, take.takeId);
    }, autoSendText * 1000);
  };

  const publish = (take: LiveTake) => {
    latest.current.setText(transcriptOf(take), take.takeId);
  };

  const remember = (take: LiveTake, itemId: string) => {
    if (!take.text.has(itemId)) {
      take.order.push(itemId);
      take.text.set(itemId, '');
    }
  };

  const handleEvent = (take: LiveTake, raw: unknown) => {
    if (takeRef.current !== take || typeof raw !== 'string') {
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const itemId = typeof event.item_id === 'string' ? event.item_id : null;

    switch (event.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        if (itemId == null || typeof event.delta !== 'string' || take.completed.has(itemId)) {
          return;
        }
        remember(take, itemId);
        take.text.set(itemId, (take.text.get(itemId) ?? '') + event.delta);
        publish(take);
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        if (itemId == null) {
          return;
        }
        remember(take, itemId);
        take.text.set(itemId, typeof event.transcript === 'string' ? event.transcript : '');
        take.completed.add(itemId);
        publish(take);
        if (take.committing && take.awaitedItem === itemId) {
          finish(take, { autoSend: true });
        }
        return;
      }
      case 'input_audio_buffer.committed': {
        if (!take.committing || itemId == null) {
          return;
        }
        take.awaitedItem = itemId;
        remember(take, itemId);
        if (take.completed.has(itemId)) {
          finish(take, { autoSend: true });
        }
        return;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        if (itemId != null && itemId === take.awaitedItem) {
          toastError('com_ui_live_transcription_error');
          finish(take, { autoSend: false });
        }
        return;
      }
      case 'error': {
        const error = event.error as { code?: unknown } | undefined;
        /* Stop before any audio reached the provider: nothing to finalize. */
        if (take.committing && error?.code === 'input_audio_buffer_commit_empty') {
          finish(take, { autoSend: true });
          return;
        }
        toastError('com_ui_live_transcription_error');
        finish(take, { autoSend: false });
        return;
      }
      default:
        return;
    }
  };

  const handleConnectionState = (take: LiveTake) => {
    if (takeRef.current !== take || take.pc == null) {
      return;
    }
    const state = take.pc.connectionState;
    if (state === 'disconnected') {
      setConnection('reconnecting');
    } else if (state === 'connected') {
      setConnection(take.channel?.readyState === 'open' ? null : 'connecting');
    } else if (state === 'failed') {
      toastError('com_ui_live_transcription_connection_lost');
      finish(take, { autoSend: false });
    }
  };

  const handleOpen = (take: LiveTake) => {
    if (takeRef.current !== take) {
      return;
    }
    setConnection(null);
    const { autoTranscribeAudio, speechToText, minDecibels } = latest.current;
    if (autoTranscribeAudio && speechToText && take.stream) {
      take.stopSilence = monitorSilence(take.stream, {
        minDecibels,
        onSilence: () => stopTake(take),
      });
    }
  };

  /** Drops a take that never got going, without writing anything. */
  const abandon = (take: LiveTake) => {
    if (takeRef.current !== take) {
      return;
    }
    takeRef.current = null;
    release(take);
    if (!isMountedRef.current) {
      return;
    }
    setIsListening(false);
    setIsLoading(false);
    setConnection(null);
    latest.current.onTranscriptionSettled(take.takeId);
  };

  const startRecording = async (takeId?: number) => {
    if (takeRef.current) {
      return;
    }
    if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      toastError('com_ui_live_transcription_unsupported');
      return;
    }

    const take: LiveTake = {
      takeId,
      stream: null,
      pc: null,
      channel: null,
      order: [],
      text: new Map(),
      completed: new Set(),
      committing: false,
      awaitedItem: null,
      timers: [],
      stopSilence: null,
    };
    takeRef.current = take;
    setIsListening(true);
    setConnection('connecting');

    try {
      take.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (error) {
      if (takeRef.current === take) {
        toastError(
          isPermissionError(error)
            ? 'com_ui_microphone_permission_denied'
            : 'com_ui_microphone_unavailable',
        );
        abandon(take);
      }
      return;
    }
    if (takeRef.current !== take) {
      take.stream.getTracks().forEach((track) => track.stop());
      take.stream = null;
      return;
    }

    try {
      const pc = new RTCPeerConnection();
      take.pc = pc;
      const stream = take.stream;
      stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream));
      const channel = pc.createDataChannel(EVENTS_CHANNEL);
      take.channel = channel;
      channel.onmessage = (event: MessageEvent) => handleEvent(take, event.data);
      channel.onopen = () => handleOpen(take);
      channel.onclose = () => {
        if (takeRef.current === take) {
          toastError('com_ui_live_transcription_connection_lost');
          finish(take, { autoSend: false });
        }
      };
      pc.onconnectionstatechange = () => handleConnectionState(take);

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (takeRef.current !== take) {
        return;
      }
      const answer = await openSession({
        sdp: offer.sdp ?? '',
        ...(languageSTT ? { language: languageSTT } : {}),
      });
      if (takeRef.current !== take) {
        return;
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch (error) {
      if (takeRef.current !== take) {
        return;
      }
      toastError(
        getErrorCode(error) === RealtimeTranscriptionErrorCode.NOT_CONFIGURED
          ? 'com_ui_live_transcription_unavailable'
          : 'com_ui_live_transcription_start_error',
      );
      abandon(take);
    }
  };

  /** Asks the provider to finalize what it heard, then waits for the transcript. */
  const stopTake = (take: LiveTake) => {
    if (takeRef.current !== take || take.committing) {
      return;
    }
    if (take.channel?.readyState !== 'open') {
      /* Still connecting: no audio has reached the provider yet. */
      abandon(take);
      return;
    }
    take.committing = true;
    take.stopSilence?.();
    take.stopSilence = null;
    setIsListening(false);
    setIsLoading(true);
    setConnection(null);

    take.timers.push(
      setTimeout(() => {
        if (takeRef.current !== take) {
          return;
        }
        try {
          take.channel?.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        } catch {
          toastError('com_ui_live_transcription_error');
          finish(take, { autoSend: false });
          return;
        }
        take.stream?.getTracks().forEach((track) => track.stop());
      }, COMMIT_GRACE_MS),
      /* A transcript that never finalized may be cut short, so it is kept for
         review rather than sent. */
      setTimeout(() => {
        if (takeRef.current === take) {
          toastError('com_ui_live_transcription_error');
          finish(take, { autoSend: false });
        }
      }, COMMIT_GRACE_MS + COMPLETION_TIMEOUT_MS),
    );
  };

  const stopRecording = () => {
    if (takeRef.current) {
      stopTake(takeRef.current);
    }
  };

  /** Drops the take without writing or sending anything. */
  const abortRecording = () => {
    const take = takeRef.current;
    takeRef.current = null;
    if (take) {
      release(take);
    }
    setIsListening(false);
    setIsLoading(false);
    setConnection(null);
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (autoSendTimerRef.current != null) {
        clearTimeout(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
      const take = takeRef.current;
      takeRef.current = null;
      if (take) {
        release(take);
      }
    };
  }, []);

  return {
    isListening,
    isLoading,
    connection,
    startRecording,
    stopRecording,
    abortRecording,
  };
};

export default useSpeechToTextRealtime;
