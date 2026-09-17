import useSpeechToTextExternal from './useSpeechToTextExternal';
import useSpeechToTextBrowser from './useSpeechToTextBrowser';
import useGetAudioSettings from './useGetAudioSettings';

const useSpeechToText = (
  setText: (text: string, takeId?: number) => void,
  onTranscriptionComplete: (text: string, takeId?: number) => void,
  onTranscriptionSettled: (takeId?: number) => void,
): {
  isLoading?: boolean;
  isListening?: boolean;
  stopRecording: () => void | Promise<void>;
  startRecording: (takeId?: number) => void | Promise<void>;
  /** Ends capture without producing a transcript. */
  abortRecording: () => void;
} => {
  const { speechToTextEndpoint } = useGetAudioSettings();
  const externalSpeechToText = speechToTextEndpoint === 'external';

  const {
    isListening: speechIsListeningBrowser,
    isLoading: speechIsLoadingBrowser,
    startRecording: startSpeechRecordingBrowser,
    stopRecording: stopSpeechRecordingBrowser,
    abortRecording: abortSpeechRecordingBrowser,
  } = useSpeechToTextBrowser(setText, onTranscriptionComplete, onTranscriptionSettled);

  const {
    isListening: speechIsListeningExternal,
    isLoading: speechIsLoadingExternal,
    externalStartRecording: startSpeechRecordingExternal,
    externalStopRecording: stopSpeechRecordingExternal,
    externalAbortRecording: abortSpeechRecordingExternal,
  } = useSpeechToTextExternal(setText, onTranscriptionComplete, onTranscriptionSettled);

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
  };
};

export default useSpeechToText;
