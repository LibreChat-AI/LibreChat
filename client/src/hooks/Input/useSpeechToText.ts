import type { SpeechConnection } from './useSpeechToTextRealtime';
import useSpeechToTextRealtime from './useSpeechToTextRealtime';
import useSpeechToTextExternal from './useSpeechToTextExternal';
import useSpeechToTextBrowser from './useSpeechToTextBrowser';
import useGetAudioSettings from './useGetAudioSettings';

const useSpeechToText = (
  setText: (text: string, takeId?: number) => void,
  onTranscriptionComplete: (text: string, takeId?: number) => void,
  onTranscriptionSettled: (takeId?: number) => void,
  /** Host-owned Auto Send Text preference. */
  autoSendText: number,
): {
  isLoading?: boolean;
  isListening?: boolean;
  stopRecording: () => void | Promise<void>;
  startRecording: (takeId?: number) => void | Promise<void>;
  /** Ends capture without producing a transcript. */
  abortRecording: () => void;
  /** Set while a live session is still being established or recovering. */
  connection: SpeechConnection;
} => {
  const { speechToTextEndpoint } = useGetAudioSettings();
  const externalSpeechToText = speechToTextEndpoint === 'external';
  const realtimeSpeechToText = speechToTextEndpoint === 'realtime';

  const {
    isListening: speechIsListeningBrowser,
    isLoading: speechIsLoadingBrowser,
    startRecording: startSpeechRecordingBrowser,
    stopRecording: stopSpeechRecordingBrowser,
    abortRecording: abortSpeechRecordingBrowser,
  } = useSpeechToTextBrowser(
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
    autoSendText,
  );

  const {
    isListening: speechIsListeningExternal,
    isLoading: speechIsLoadingExternal,
    externalStartRecording: startSpeechRecordingExternal,
    externalStopRecording: stopSpeechRecordingExternal,
    externalAbortRecording: abortSpeechRecordingExternal,
  } = useSpeechToTextExternal(
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
    autoSendText,
  );

  const realtime = useSpeechToTextRealtime(
    setText,
    onTranscriptionComplete,
    onTranscriptionSettled,
    autoSendText,
  );

  if (realtimeSpeechToText) {
    return {
      isLoading: realtime.isLoading,
      isListening: realtime.isListening,
      stopRecording: realtime.stopRecording,
      startRecording: realtime.startRecording,
      abortRecording: realtime.abortRecording,
      connection: realtime.connection,
    };
  }

  const isListening = externalSpeechToText ? speechIsListeningExternal : speechIsListeningBrowser;
  const isLoading = externalSpeechToText ? speechIsLoadingExternal : speechIsLoadingBrowser;

  const startRecording = externalSpeechToText
    ? startSpeechRecordingExternal
    : startSpeechRecordingBrowser;
  const stopRecording = externalSpeechToText
    ? stopSpeechRecordingExternal
    : stopSpeechRecordingBrowser;

  const abortRecording = externalSpeechToText
    ? abortSpeechRecordingExternal
    : abortSpeechRecordingBrowser;

  return {
    isLoading,
    isListening,
    stopRecording,
    startRecording,
    abortRecording,
    connection: null,
  };
};

export default useSpeechToText;
