import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import useSpeechToTextBrowser from '../useSpeechToTextBrowser';

/**
 * Dropping a take. The auto-send timer is the load-bearing part: a transcript
 * that already landed will fire it after the user has cancelled, sending words
 * they just discarded.
 */

const mockAbortListening = jest.fn();
const mockStopListening = jest.fn();
const mockResetTranscript = jest.fn();
let mockFinalTranscript = '';
/** Delivers a recognizer result the way the library does: a reducer update that
 *  reaches the consumer only on React's next commit. */
let mockDeliverFinal: (transcript: string) => void = () => undefined;
/** Whether the hook last asked the library to collect what the page's recognizer hears. */
let mockTranscribing: boolean | undefined;

jest.mock('react-speech-recognition', () => {
  const { useState } = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: {
      startListening: jest.fn(),
      stopListening: (...args: unknown[]) => mockStopListening(...args),
      abortListening: (...args: unknown[]) => mockAbortListening(...args),
    },
    useSpeechRecognition: (options?: { transcribing?: boolean }) => {
      const [finalTranscript, setFinalTranscript] = useState(mockFinalTranscript);
      mockDeliverFinal = setFinalTranscript;
      mockTranscribing = options?.transcribing;
      return {
        listening: true,
        finalTranscript,
        interimTranscript: '',
        resetTranscript: mockResetTranscript,
        isMicrophoneAvailable: true,
        browserSupportsSpeechRecognition: true,
      };
    },
  };
});

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
    <RecoilRoot>{children}</RecoilRoot>
  );
  const rendered = renderHook(
    () =>
      useSpeechToTextBrowser(
        setText,
        onTranscriptionComplete,
        onTranscriptionSettled,
        AUTO_SEND_SECONDS,
      ),
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
    expect(onTranscriptionComplete).toHaveBeenCalledWith('the words that landed', undefined);
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

  /* The recognizer is one per page and reports to every composer on it. With a second
     composer mounted (a conversation open beside the chat), a take started in one must not be
     written into the other, sent from it, or shown there as recording. */
  it('collects a take, and shows itself listening, only in the composer that started it', async () => {
    const { result } = setup();

    /** Another composer is recording: the page's recognizer is listening, this one is not. */
    expect(mockTranscribing).toBe(false);
    expect(result.current.isListening).toBe(false);

    act(() => {
      result.current.startRecording(7);
    });
    expect(mockTranscribing).toBe(true);
    expect(result.current.isListening).toBe(true);

    await act(async () => {
      await result.current.stopRecording();
    });
    expect(mockTranscribing).toBe(false);
    expect(result.current.isListening).toBe(false);

    act(() => {
      result.current.startRecording(8);
    });
    expect(mockTranscribing).toBe(true);
    act(() => {
      result.current.abortRecording();
    });
    expect(mockTranscribing).toBe(false);
  });

  /* Ownership is exclusive, not only per composer: with one composer recording, a second one
     that starts must not become an owner too, or both would write the same speech down. */
  it('refuses to start while another composer is recording, and can once that one is done', async () => {
    const speech = jest.requireMock('react-speech-recognition').default as {
      startListening: jest.Mock;
    };
    const first = setup();
    const second = setup();
    act(() => {
      first.result.current.startRecording(1);
    });
    expect(speech.startListening).toHaveBeenCalledTimes(1);

    act(() => {
      second.result.current.startRecording(2);
    });
    expect(speech.startListening).toHaveBeenCalledTimes(1);
    expect(second.result.current.isListening).toBe(false);
    expect(first.result.current.isListening).toBe(true);

    await act(async () => {
      await first.result.current.stopRecording();
    });
    act(() => {
      second.result.current.startRecording(3);
    });
    expect(speech.startListening).toHaveBeenCalledTimes(2);
    expect(second.result.current.isListening).toBe(true);
  });

  /* The recognizer outlives any one composer. One that goes away mid-take has to end the take,
     or the microphone stays open with nothing on the page showing it or able to stop it. */
  it('ends its own take when the composer goes away, and leaves one it does not own', () => {
    const idle = setup();
    idle.unmount();
    expect(mockAbortListening).not.toHaveBeenCalled();

    const recording = setup();
    act(() => {
      recording.result.current.startRecording(9);
    });
    recording.unmount();
    expect(mockAbortListening).toHaveBeenCalledTimes(1);
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

  /* The final result arrives before the stop resolves, as the Web Speech API orders
     `result` ahead of `end`, but React has not committed it yet. Settling in that gap
     let an armed stop-and-send read the interim text, or nothing at all. */
  it('settles only after the final transcript reaches the composer', async () => {
    let finishStop: () => void = () => undefined;
    mockStopListening.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishStop = resolve;
      }),
    );
    const { result, setText, onTranscriptionSettled } = setup();

    let stopping: Promise<void> | undefined;
    act(() => {
      stopping = result.current.stopRecording();
    });

    await act(async () => {
      mockDeliverFinal('the final words');
      finishStop();
      await stopping;
      expect(onTranscriptionSettled).not.toHaveBeenCalled();
    });

    expect(setText).toHaveBeenCalledWith('the final words', undefined);
    expect(onTranscriptionSettled).toHaveBeenCalledTimes(1);
    expect(setText.mock.invocationCallOrder[0]).toBeLessThan(
      onTranscriptionSettled.mock.invocationCallOrder[0],
    );
  });
});
