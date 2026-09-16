import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import useSpeechToTextBrowser from '../useSpeechToTextBrowser';
import store from '~/store';

/**
 * Dropping a take. The auto-send timer is the load-bearing part: a transcript
 * that already landed will fire it after the user has cancelled, sending words
 * they just discarded.
 */

const mockAbortListening = jest.fn();
const mockStopListening = jest.fn();
const mockResetTranscript = jest.fn();
let mockFinalTranscript = '';

jest.mock('react-speech-recognition', () => ({
  __esModule: true,
  default: {
    startListening: jest.fn(),
    stopListening: (...args: unknown[]) => mockStopListening(...args),
    abortListening: (...args: unknown[]) => mockAbortListening(...args),
  },
  useSpeechRecognition: () => ({
    listening: true,
    finalTranscript: mockFinalTranscript,
    interimTranscript: '',
    resetTranscript: mockResetTranscript,
    isMicrophoneAvailable: true,
    browserSupportsSpeechRecognition: true,
  }),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: () => ({ data: { sttExternal: false } }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const AUTO_SEND_SECONDS = 3;

function setup() {
  const setText = jest.fn();
  const onTranscriptionComplete = jest.fn();
  const onTranscriptionSettled = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.autoSendText, AUTO_SEND_SECONDS);
      }}
    >
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () => useSpeechToTextBrowser(setText, onTranscriptionComplete, onTranscriptionSettled),
    { wrapper },
  );
  return { ...rendered, setText, onTranscriptionComplete, onTranscriptionSettled };
}

describe('useSpeechToTextBrowser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockFinalTranscript = '';
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends a landed transcript once the auto-send delay passes', () => {
    mockFinalTranscript = 'the words that landed';
    const { onTranscriptionComplete } = setup();

    act(() => {
      jest.advanceTimersByTime(AUTO_SEND_SECONDS * 1000);
    });
    expect(onTranscriptionComplete).toHaveBeenCalledWith('the words that landed');
  });

  /* The take is cancelled after the transcript arrived but before the delay
     elapsed, which is the window where the words are already staged. */
  it('does not send a transcript after the take has been dropped', () => {
    mockFinalTranscript = 'the words that landed';
    const { result, onTranscriptionComplete } = setup();

    act(() => {
      result.current.abortRecording();
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_SEND_SECONDS * 1000);
    });

    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    expect(mockAbortListening).toHaveBeenCalled();
    expect(mockResetTranscript).toHaveBeenCalled();
  });

  /* `abortListening` is optional on the recogniser module, and stopping still
     has to drop the take rather than leaving the microphone running. */
  it('falls back to stopping when the module cannot abort', () => {
    const speech = jest.requireMock('react-speech-recognition').default as Record<string, unknown>;
    const abort = speech.abortListening;
    delete speech.abortListening;

    mockFinalTranscript = 'the words that landed';
    const { result, onTranscriptionComplete } = setup();
    act(() => {
      result.current.abortRecording();
    });
    act(() => {
      jest.advanceTimersByTime(AUTO_SEND_SECONDS * 1000);
    });

    expect(mockStopListening).toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    speech.abortListening = abort;
  });

  it('settles only after the recognizer finishes stopping', async () => {
    let finishStop: () => void = () => undefined;
    mockStopListening.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { result, onTranscriptionSettled } = setup();

    let stopping: Promise<void> | undefined;
    act(() => {
      stopping = result.current.stopRecording();
    });
    expect(onTranscriptionSettled).not.toHaveBeenCalled();

    await act(async () => {
      finishStop();
      await stopping;
    });
    expect(onTranscriptionSettled).toHaveBeenCalledTimes(1);
  });
});
