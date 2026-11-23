import React from 'react';
import { dataService } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getTTSCacheKey, getCachedTTSAudio, setCachedTTSAudio } from '~/utils';
import useTextToSpeechExternal from '../useTextToSpeechExternal';

let mockCache = false;
jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => (key === 'cacheTTS' ? mockCache : false),
}));
beforeEach(() => {
  mockCache = false;
});
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'user' } }),
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    cacheTTS: 'cacheTTS',
    globalAudioFetchingFamily: jest.fn(),
    globalAudioPlayingFamily: jest.fn(),
  },
}));
jest.mock('~/utils', () => ({
  getTTSCacheGeneration: () => 0,
  getTTSCacheKey: jest.fn().mockResolvedValue('key'),
  getCachedTTSAudio: jest.fn(),
  setCachedTTSAudio: jest.fn(),
}));
jest.mock('~/data-provider', () => ({
  useVoicesQuery: () => ({ data: [] }),
}));
jest.mock('librechat-data-provider', () => ({
  MutationKeys: { textToSpeech: 'textToSpeech' },
  getClientLimit: () => 60000,
  dataService: { streamTextToSpeech: jest.fn() },
}));
class FakeSourceBuffer extends EventTarget {
  updating = false;
  appendBuffer = jest.fn((_data: ArrayBuffer) => {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event('updateend'));
    });
  });
}

function setup(supported = true) {
  const sourceBuffer = new FakeSourceBuffer();
  class FakeMediaSource extends EventTarget {
    static isTypeSupported = () => supported;
    readyState = 'open';
    addSourceBuffer = () => sourceBuffer;
    endOfStream = jest.fn();
  }
  const play = jest.fn().mockResolvedValue(undefined);
  const audio = {
    play,
    pause: jest.fn(),
    removeAttribute: jest.fn(),
    load: jest.fn(),
    src: 'blob:stream',
  };
  jest.spyOn(window, 'Audio').mockImplementation(() => audio as unknown as HTMLAudioElement);
  URL.createObjectURL = jest.fn((object: Blob | MediaSource) => {
    if (object instanceof FakeMediaSource) {
      queueMicrotask(() => object.dispatchEvent(new Event('sourceopen')));
      return 'blob:stream';
    }
    return 'blob:complete';
  });
  URL.revokeObjectURL = jest.fn();
  Object.defineProperty(window, 'MediaSource', {
    configurable: true,
    value: FakeMediaSource,
  });
  let finish: (value: ReadableStreamReadResult<Uint8Array>) => void;
  let signal: AbortSignal;
  jest.mocked(dataService.streamTextToSpeech).mockImplementation(async (_data, requestSignal) => {
    signal = requestSignal;
    const read = jest
      .fn()
      .mockResolvedValueOnce({ value: new Uint8Array([1]), done: false })
      .mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
    return {
      ok: true,
      body: { getReader: () => ({ read, releaseLock: jest.fn() }) },
    } as unknown as Response;
  });
  const client = new QueryClient();
  const setIsSpeaking = jest.fn();
  const hook = renderHook(
    () =>
      useTextToSpeechExternal({
        setIsSpeaking,
        audioRef: { current: null },
        isLast: false,
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return {
    ...hook,
    audio,
    sourceBuffer,
    setIsSpeaking,
    end: () => finish({ done: true, value: undefined }),
    aborted: () => signal.aborted,
  };
}

it('starts manual playback before the speech response finishes', async () => {
  const { result, audio, sourceBuffer, end } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  expect(audio.play).toHaveBeenCalled();
  expect(sourceBuffer.appendBuffer).toHaveBeenCalledWith(new Uint8Array([1]).buffer);
  await act(async () => {
    end();
  });
});

it('buffers unsupported media until completion', async () => {
  const { result, audio, end } = setup(false);
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  expect(audio.play).not.toHaveBeenCalled();
  await act(async () => {
    end();
  });
  expect(audio.play).toHaveBeenCalledTimes(1);
});

it('downloads only the complete response without playback', async () => {
  const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const { result, audio, end } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', true);
  });
  expect(click).not.toHaveBeenCalled();
  await act(async () => {
    end();
  });
  expect(click).toHaveBeenCalledTimes(1);
  expect(audio.play).not.toHaveBeenCalled();
});

it('aborts and releases audio on cancellation', async () => {
  const { result, audio, aborted, setIsSpeaking } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  await act(async () => {
    result.current.cancelSpeech();
  });
  expect(aborted()).toBe(true);
  expect(audio.pause).toHaveBeenCalled();
  expect(setIsSpeaking).toHaveBeenLastCalledWith(false);
});

it('aborts pending playback on unmount', async () => {
  const { result, audio, aborted, unmount } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  await act(async () => {
    unmount();
  });
  expect(aborted()).toBe(true);
  expect(audio.pause).toHaveBeenCalled();
});

it('caches only completed audio and replays a cache hit without a request', async () => {
  mockCache = true;
  const { result, end } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  expect(setCachedTTSAudio).not.toHaveBeenCalled();
  await act(async () => {
    end();
  });
  expect(setCachedTTSAudio).toHaveBeenCalledWith('key', expect.any(Blob), 0);
  jest.mocked(getCachedTTSAudio).mockReturnValueOnce(new Blob(['audio']));
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  expect(dataService.streamTextToSpeech).toHaveBeenCalledTimes(1);
});

it('does not request audio after cancellation during cache lookup', async () => {
  mockCache = true;
  let resolveKey: (key: string) => void;
  jest.mocked(getTTSCacheKey).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveKey = resolve;
      }),
  );
  const { result, audio } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  await act(async () => {
    result.current.cancelSpeech();
    resolveKey('key');
  });
  expect(dataService.streamTextToSpeech).not.toHaveBeenCalled();
  expect(audio.play).not.toHaveBeenCalled();
});

it('aborts a replaced request before starting its successor', async () => {
  const { result, end } = setup();
  await act(async () => {
    result.current.generateSpeechExternal('First', false);
  });
  const oldSignal = jest.mocked(dataService.streamTextToSpeech).mock.calls[0][1];
  await act(async () => {
    result.current.generateSpeechExternal('Second', false);
  });
  expect(oldSignal.aborted).toBe(true);
  expect(dataService.streamTextToSpeech).toHaveBeenCalledTimes(2);
  await act(async () => {
    end();
  });
});

it('clears speaking state for an empty response', async () => {
  const { result, setIsSpeaking, audio } = setup();
  jest.mocked(dataService.streamTextToSpeech).mockResolvedValueOnce({
    ok: true,
    body: { getReader: () => ({ read: async () => ({ done: true }), releaseLock: jest.fn() }) },
  } as unknown as Response);
  await act(async () => {
    result.current.generateSpeechExternal('', false);
  });
  expect(audio.pause).toHaveBeenCalled();
  expect(setIsSpeaking).toHaveBeenLastCalledWith(false);
  expect(result.current.isLoading).toBe(false);
});

it('clears loading and speaking state after an unsuccessful response', async () => {
  const { result, setIsSpeaking, audio } = setup();
  jest.mocked(dataService.streamTextToSpeech).mockResolvedValueOnce({ ok: false } as Response);
  await act(async () => {
    result.current.generateSpeechExternal('Long speech', false);
  });
  expect(audio.play).not.toHaveBeenCalled();
  expect(setIsSpeaking).toHaveBeenLastCalledWith(false);
  expect(result.current.isLoading).toBe(false);
});

it('does not abort an active stream after the initial request deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  try {
    const { result, aborted, end, unmount } = setup();
    await act(async () => {
      result.current.generateSpeechExternal('Long speech', false);
    });
    await act(async () => {
      jest.advanceTimersByTime(61000);
    });
    expect(aborted()).toBe(false);
    await act(async () => {
      end();
    });
    unmount();
  } finally {
    jest.useRealTimers();
  }
});
