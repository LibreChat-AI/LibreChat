import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import SpeechRecognition from 'react-speech-recognition';
import useSpeechToTextBrowser from '../useSpeechToTextBrowser';
import store from '~/store';

/**
 * Back-to-back takes with Auto-transcribe on. Unlike the sibling spec, the real
 * `react-speech-recognition` runs here, because the bug lives in how its
 * transcript carries over: with `continuous` listening it never clears on start.
 * Only the browser recognizer is faked.
 */

jest.mock('react-speech-recognition/lib/NativeSpeechRecognition', () => {
  /** Like Chrome, `end` arrives after `stop`/`abort` return, not during them. */
  class FakeSpeechRecognition {
    onend: (() => void) | null = null;

    start() {}

    stop() {
      Promise.resolve().then(() => this.onend?.());
    }

    abort() {
      this.stop();
    }
  }
  return {
    __esModule: true,
    default: FakeSpeechRecognition,
    isNative: (recognition: unknown) => recognition === FakeSpeechRecognition,
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

function hear(transcript: string, isFinal: boolean) {
  const result = Object.assign([{ transcript, confidence: isFinal ? 0.9 : 0 }], { isFinal });
  act(() => {
    SpeechRecognition.getRecognition()?.onresult?.({ resultIndex: 0, results: [result] });
  });
}

/** An utterance as Chrome reports it: interim words first, then the final result.
 *  The library drops a final-only result that follows another one as a duplicate,
 *  so skipping the interim step would lose words for an unrelated reason. */
function speak(transcript: string) {
  hear(transcript, false);
  hear(transcript, true);
}

function setup(autoSendText: number) {
  const setText = jest.fn();
  const onTranscriptionComplete = jest.fn();
  const onTranscriptionSettled = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.autoTranscribeAudio, true)}>
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () =>
      useSpeechToTextBrowser(
        setText,
        onTranscriptionComplete,
        onTranscriptionSettled,
        autoSendText,
      ),
    { wrapper },
  );

  const start = async (takeId: number) => {
    await act(async () => {
      rendered.result.current.startRecording(takeId);
    });
  };
  const stop = async () => {
    await act(async () => {
      await rendered.result.current.stopRecording();
    });
  };
  return { ...rendered, setText, onTranscriptionComplete, start, stop };
}

describe('useSpeechToTextBrowser across takes', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /* Auto Send Text off: nothing ever reset the transcript, so every take after
     the first was prefixed with all the ones before it. */
  it('starts each take from an empty transcript', async () => {
    const { setText, start, stop } = setup(-1);

    await start(1);
    speak('first take');
    await stop();
    expect(setText).toHaveBeenLastCalledWith('first take', 1);

    await start(2);
    speak('second take');
    await stop();
    expect(setText).toHaveBeenLastCalledWith('second take', 2);
  });

  /* The previous take's auto-send cleared the library's transcript but not the
     hook's own record of it, which then matched the repeat and swallowed it. */
  it('delivers a take that repeats the previous one word for word', async () => {
    const { setText, start, stop } = setup(3);

    await start(1);
    speak('yes');
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await stop();

    setText.mockClear();
    await start(2);
    speak('yes');
    await stop();
    expect(setText).toHaveBeenLastCalledWith('yes', 2);
  });

  /* Stopping the first take left its auto-send delay running into the next one,
     where it reset the recognizer and cut off whatever was being said. */
  it("does not let the previous take's auto-send delay cut into the next take", async () => {
    const { onTranscriptionComplete, start, stop } = setup(3);

    await start(1);
    speak('first take');
    await stop();

    await start(2);
    const abort = jest.spyOn(SpeechRecognition.getRecognition(), 'abort');
    hear('second', false);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(abort).not.toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
    await stop();
  });
});
