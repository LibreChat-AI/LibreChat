import { act, renderHook } from '@testing-library/react';
import type { TAskFunction } from '~/common';
import useDictation from '../useDictation';

/**
 * The engines only report a completed transcription when Auto Send Text is
 * configured, so the composer's own stop-and-send cannot be built on that
 * callback alone. These cases pin the three ways a take can be spent, sent on
 * request, sent by the setting, or thrown away, against both engines.
 */

let mockSpeechEndpoint: 'browser' | 'external';
let mockSetTextCallback: (text: string) => void;
let mockOnTranscriptionComplete: (text: string) => void;
let mockOnTranscriptionSettled: () => void;
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockAbort = jest.fn();
let mockIsListening: boolean;
let mockIsLoading: boolean;

jest.mock('../useSpeechToText', () => ({
  __esModule: true,
  default: (
    setText: (text: string) => void,
    complete: (text: string) => void,
    settled: () => void,
  ) => {
    mockSetTextCallback = setText;
    mockOnTranscriptionComplete = complete;
    mockOnTranscriptionSettled = settled;
    return {
      isListening: mockIsListening,
      isLoading: mockIsLoading,
      startRecording: mockStart,
      stopRecording: mockStop,
      abortRecording: mockAbort,
    };
  },
}));

jest.mock('../useGetAudioSettings', () => ({
  __esModule: true,
  default: () => ({ speechToTextEndpoint: mockSpeechEndpoint }),
}));

const mockShowToast = jest.fn();

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('../../useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

const ask = jest.fn(() => true) as unknown as jest.Mock & TAskFunction;

function setup({
  autoSendText = -1,
  speechToText = true,
  draft = '',
  isSubmitting = false,
  filesLoading = false,
  deferComposerReset = false,
  disabled = false,
}: {
  autoSendText?: number;
  speechToText?: boolean;
  draft?: string;
  isSubmitting?: boolean;
  filesLoading?: boolean;
  deferComposerReset?: boolean;
  disabled?: boolean;
} = {}) {
  let text = draft;
  let uploading = filesLoading;
  const methods = {
    setValue: jest.fn((_name: string, value: string) => {
      text = value;
    }),
    reset: jest.fn((values: { text: string }) => {
      text = values.text;
    }),
    getValues: jest.fn(() => text),
  };
  const view = renderHook(() => {
    const dictationOptions = {
      ask: ask as unknown as TAskFunction,
      methods: methods as never,
      isSubmitting,
      filesLoading: uploading,
      deferComposerReset,
      disabled,
      autoSendText,
      speechToText,
    };
    return useDictation(dictationOptions);
  });
  return {
    ...view,
    methods,
    currentText: () => text,
    setFilesLoading: (value: boolean) => {
      uploading = value;
    },
  };
}

/** Ends the take the way an engine does: listening clears, then the engine
 * reports that its final transcript has landed. */
const settle = async (rerender: () => void) => {
  mockIsListening = false;
  act(() => {
    rerender();
  });
  act(() => mockOnTranscriptionSettled());
};

describe('useDictation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockSpeechEndpoint = 'browser';
    mockIsListening = false;
    mockIsLoading = false;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends on stop-and-send even with Auto Send Text off, which reports no transcription', async () => {
    const { result, rerender, currentText } = setup();
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('take me somewhere'));
    act(() => result.current.stopAndSend());
    await settle(rerender);

    expect(ask).toHaveBeenCalledWith({ text: 'take me somewhere' });
    expect(currentText()).toBe('');
  });

  it('waits for the final browser transcript before sending', async () => {
    const { result, rerender } = setup();
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('interim words'));
    act(() => result.current.stopAndSend());
    mockIsListening = false;
    act(() => rerender());

    expect(ask).not.toHaveBeenCalled();
    act(() => mockSetTextCallback('final words'));
    act(() => mockOnTranscriptionSettled());

    expect(ask).toHaveBeenCalledWith({ text: 'final words' });
  });

  it('owns the Shift+Alt+L shortcut through the dictation lifecycle', () => {
    const { result, rerender } = setup();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', shiftKey: true, altKey: true }),
      );
    });
    expect(mockStart).toHaveBeenCalledTimes(1);

    mockIsListening = true;
    act(() => rerender());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', shiftKey: true, altKey: true }),
      );
    });

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(result.current.transcribing).toBe(true);
  });

  it('refuses both direct and shortcut starts while the host disables speech', () => {
    const { result } = setup({ disabled: true });

    act(() => result.current.start());
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', shiftKey: true, altKey: true }),
      );
    });

    expect(result.current.startDisabled).toBe(true);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('leaves a plain stop in the composer', async () => {
    const { result, rerender, currentText } = setup();
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('just a draft'));
    act(() => result.current.stopToComposer());
    await settle(rerender);

    expect(ask).not.toHaveBeenCalled();
    expect(currentText()).toBe('just a draft');
  });

  it('still honours Auto Send Text on a plain stop', async () => {
    const { result, rerender } = setup({ autoSendText: 0 });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => result.current.stopToComposer());
    await settle(rerender);
    act(() => mockOnTranscriptionComplete('send this for me'));

    expect(ask).toHaveBeenCalledWith({ text: 'send this for me' });
  });

  it('spends a take once when the setting and the send button both reach it', async () => {
    const { result, rerender } = setup({ autoSendText: 0 });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('only once'));
    act(() => result.current.stopAndSend());
    await settle(rerender);
    act(() => mockOnTranscriptionComplete('only once'));

    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('retains an accepted transcript until its deferred reset is confirmed', async () => {
    const { result, rerender, currentText, methods } = setup({ deferComposerReset: true });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('answer after confirmation'));
    act(() => result.current.stopAndSend());
    await settle(rerender);

    expect(ask).toHaveBeenCalledWith({ text: 'answer after confirmation' });
    expect(currentText()).toBe('answer after confirmation');
    expect(methods.reset).not.toHaveBeenCalled();

    act(() => mockOnTranscriptionComplete('answer after confirmation'));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  /* The bar disables stop and send once a take is being transcribed, and the
     hook refuses them too: a second stop would rewrite how a take that was
     already committed gets spent. */
  it('ignores a stop that arrives after the take has ended', async () => {
    const { result, rerender, currentText } = setup();
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('already committed'));
    act(() => result.current.stopToComposer());
    mockIsListening = false;
    act(() => rerender());

    mockStop.mockClear();
    act(() => result.current.stopAndSend());
    await settle(rerender);

    expect(mockStop).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(currentText()).toBe('already committed');
  });

  it('keeps the draft when a cancelled external transcription lands anyway', async () => {
    mockSpeechEndpoint = 'external';
    const { result, rerender, currentText } = setup({ draft: 'my unsent draft' });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => result.current.cancel());
    expect(currentText()).toBe('my unsent draft');

    /* The mutation was already in flight, so aborting the recorder cannot stop
       its success callback from arriving. */
    act(() => mockOnTranscriptionComplete('words nobody asked for'));

    expect(ask).not.toHaveBeenCalled();
    expect(currentText()).toBe('my unsent draft');
  });

  it('exits a cancelled external transcription while its request is still loading', () => {
    mockSpeechEndpoint = 'external';
    const { result, rerender, currentText } = setup({ draft: 'my unsent draft' });
    act(() => result.current.start());
    mockIsListening = false;
    mockIsLoading = true;
    act(() => rerender());

    expect(result.current.transcribing).toBe(true);
    act(() => result.current.cancel());

    expect(result.current.transcribing).toBe(false);
    expect(result.current.startDisabled).toBe(true);
    expect(currentText()).toBe('my unsent draft');

    mockStart.mockClear();
    act(() => result.current.start());
    expect(mockStart).not.toHaveBeenCalled();

    act(() => mockOnTranscriptionComplete('discarded words'));
    expect(ask).not.toHaveBeenCalled();
    expect(currentText()).toBe('my unsent draft');

    mockIsLoading = false;
    act(() => rerender());
    expect(result.current.startDisabled).toBe(false);
    act(() => result.current.start());
    act(() => mockOnTranscriptionComplete('new words'));

    expect(currentText()).toBe('my unsent draft new words');
  });

  /* A run in flight has nothing to send into, so the take is refused outright.
     `ChatForm` reports a paused `ask_user_question` as NOT submitting for
     exactly this reason: the run is still open, but the composer has become the
     answer box and speech has to reach it the way typing does. */
  it('refuses a take while a turn is in flight', async () => {
    const { result, rerender, currentText } = setup({ draft: '', isSubmitting: true });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('answer the question'));
    act(() => result.current.stopAndSend());
    await settle(rerender);

    expect(ask).not.toHaveBeenCalled();
    expect(currentText()).toBe('answer the question');
  });

  it('sends the take when the composer is free to submit', async () => {
    const { result, rerender } = setup({ draft: '', isSubmitting: false });
    act(() => result.current.start());
    mockIsListening = true;
    act(() => rerender());

    act(() => mockSetTextCallback('answer the question'));
    act(() => result.current.stopAndSend());
    await settle(rerender);

    expect(ask).toHaveBeenCalledWith({ text: 'answer the question' });
  });

  /* Send and steer both refuse to submit while an attachment is still
     uploading, and a dictated turn must not be the one path that lets a
     half-uploaded file ride along. */
  describe('an attachment still uploading', () => {
    it('refuses the dictated turn and says why', async () => {
      const { result, rerender, currentText } = setup({ filesLoading: true });
      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());

      act(() => mockSetTextCallback('describe this file'));
      act(() => result.current.stopAndSend());
      await settle(rerender);

      expect(ask).not.toHaveBeenCalled();
      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_ui_speech_while_uploading',
        status: 'error',
      });
      /* Refused, not discarded: the words are still there to send by hand. */
      expect(currentText()).toBe('describe this file');
    });

    it('sends once the upload finishes', async () => {
      const { result, rerender, setFilesLoading } = setup({ filesLoading: true });
      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());

      act(() => mockSetTextCallback('describe this file'));
      act(() => result.current.stopAndSend());
      await settle(rerender);
      expect(ask).not.toHaveBeenCalled();

      setFilesLoading(false);
      act(() => rerender());

      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());
      act(() => mockSetTextCallback('now send it'));
      act(() => result.current.stopAndSend());
      await settle(rerender);

      expect(ask).toHaveBeenCalledWith({ text: 'describe this file now send it' });
    });
  });

  /* The armed send reads whatever the transcript left in the composer. A take
     that produced nothing leaves the draft that was there BEFORE recording, and
     sending that is the user's own unfinished words going out as if dictated. */
  describe('a take that produced nothing', () => {
    it('stands the armed send down when the transcription fails', async () => {
      mockSpeechEndpoint = 'external';
      const { result, rerender, currentText } = setup({ draft: 'half a thought' });
      act(() => result.current.start());
      mockIsListening = true;
      mockIsLoading = true;
      act(() => rerender());

      act(() => result.current.stopAndSend());
      /* The request fails: the engine toasts, clears its loading flag, and
         never reports a transcript. */
      mockIsLoading = false;
      await settle(rerender);

      expect(ask).not.toHaveBeenCalled();
      expect(currentText()).toBe('half a thought');
    });

    it('stands it down for a take too short to reach the engine', async () => {
      const { result, rerender, currentText } = setup({ draft: 'half a thought' });
      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());

      act(() => result.current.stopAndSend());
      await settle(rerender);

      expect(ask).not.toHaveBeenCalled();
      expect(currentText()).toBe('half a thought');
    });

    /* The gate is per take, not for good. */
    it('sends the next take that does produce words', async () => {
      const { result, rerender } = setup({ draft: 'half a thought' });
      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());
      act(() => result.current.stopAndSend());
      await settle(rerender);
      expect(ask).not.toHaveBeenCalled();

      act(() => result.current.start());
      mockIsListening = true;
      act(() => rerender());
      act(() => mockSetTextCallback('this time it heard me'));
      act(() => result.current.stopAndSend());
      await settle(rerender);

      expect(ask).toHaveBeenCalledWith({ text: 'half a thought this time it heard me' });
    });
  });
});
