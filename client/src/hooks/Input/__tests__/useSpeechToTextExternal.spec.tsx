import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import useSpeechToTextExternal from '../useSpeechToTextExternal';
import translationEn from '~/locales/en/translation.json';
import store from '~/store';

/**
 * Everything this hook holds open is a device resource: the recorder, the
 * microphone tracks, the silence monitor's frame loop and its audio graph.
 * Navigating away mid-take reaches none of the stop handlers, so these cases
 * pin the teardown rather than the happy path.
 */

type SpeechMutationOptions = {
  onSuccess?: (data: { text: string }) => void;
  onError?: () => void;
};
const mockProcessAudio = jest.fn();
const mockShowToast = jest.fn();
jest.mock('~/data-provider', () => ({
  useSpeechToTextMutation: (_options: SpeechMutationOptions) => {
    return { mutate: mockProcessAudio, isLoading: false };
  },
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

/* Returns the key, so a toast that skipped localization shows up as a sentence. */
jest.mock('../../useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

/** Every toast the hook raised, checked against the English catalog: a hard-coded
 *  sentence is not a key there, so it fails here in any language. */
const toastsShown = () =>
  mockShowToast.mock.calls.map(([toast]: [{ message: string; status: string }]) => ({
    ...toast,
    localized: Object.hasOwn(translationEn, toast.message),
  }));

type RecorderListener = (event: BlobEvent) => void;

class FakeMediaRecorder {
  static supportedType = 'audio/webm';
  static instances: FakeMediaRecorder[] = [];

  static isTypeSupported(type: string): boolean {
    return type === FakeMediaRecorder.supportedType;
  }

  state: 'inactive' | 'recording' = 'inactive';
  readonly mimeType: string;
  private readonly handlers = new Map<string, RecorderListener[]>();

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? '';
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, handler: RecorderListener) {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  start() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.emit('stop');
  }

  emitData(data: Blob) {
    this.emit('dataavailable', { data } as BlobEvent);
  }

  private emit(type: string, event?: BlobEvent) {
    for (const handler of this.handlers.get(type) ?? []) {
      handler(event as BlobEvent);
    }
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  close = jest.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: jest.fn() };
  }

  createAnalyser() {
    return { minDecibels: 0, frequencyBinCount: 32, getByteFrequencyData: jest.fn() };
  }
}

const makeStream = () => {
  const track = { stop: jest.fn(), kind: 'audio' };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  return { stream, track };
};

const AUTO_SEND_SECONDS = 2;

let mockGetUserMedia: jest.Mock;
let mockCancelAnimationFrame: jest.Mock;
let currentTrack: { stop: jest.Mock };
let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
let frameId = 0;

function setup({ autoSendText = -1 }: { autoSendText?: number } = {}) {
  const setText = jest.fn();
  const onTranscriptionComplete = jest.fn();
  const onTranscriptionSettled = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.speechToText, true);
        set(store.autoTranscribeAudio, true);
      }}
    >
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () =>
      useSpeechToTextExternal(
        setText,
        onTranscriptionComplete,
        onTranscriptionSettled,
        autoSendText,
      ),
    { wrapper },
  );
  return { ...rendered, setText, onTranscriptionComplete, onTranscriptionSettled };
}

const start = async (begin: () => void) => {
  await act(async () => {
    begin();
  });
};

describe('useSpeechToTextExternal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supportedType = 'audio/webm';
    FakeAudioContext.instances = [];
    frameId = 0;

    const { stream, track } = makeStream();
    currentTrack = track;
    mockGetUserMedia = jest.fn(() => Promise.resolve(stream));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
    });

    global.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
    global.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    mockCancelAnimationFrame = jest.fn();
    /* The loop is registered but never run: what matters here is that the id it
       leaves behind is the one the teardown cancels. */
    window.requestAnimationFrame = jest.fn(() => {
      frameId += 1;
      return frameId;
    }) as unknown as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = mockCancelAnimationFrame;
  });

  afterEach(() => {
    jest.useRealTimers();
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
  });

  it('records with a mime type the browser reports as supported', async () => {
    FakeMediaRecorder.supportedType = 'audio/mp4';
    const { result } = setup();
    await start(result.current.externalStartRecording);

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(FakeMediaRecorder.instances[0].mimeType).toBe('audio/mp4');
  });

  /* A webview can expose `getUserMedia` without `MediaRecorder`. Asking for the
     microphone first left a live capture behind a UI with no Stop control,
     because construction throws before `isListening` ever turns on. */
  it('does not open the microphone where the browser has no MediaRecorder', async () => {
    Reflect.deleteProperty(globalThis, 'MediaRecorder');
    const { result } = setup();

    await start(result.current.externalStartRecording);

    expect(mockGetUserMedia).not.toHaveBeenCalled();
    expect(result.current.isListening).toBe(false);
    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_recording_not_supported', status: 'error', localized: true },
    ]);
  });

  it('releases the microphone when the recorder cannot be constructed', async () => {
    global.MediaRecorder = class {
      static isTypeSupported = FakeMediaRecorder.isTypeSupported;
      constructor() {
        throw new Error('MediaRecorder unavailable');
      }
    } as unknown as typeof MediaRecorder;
    const { result } = setup();

    await start(result.current.externalStartRecording);

    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(currentTrack.stop).toHaveBeenCalledTimes(1);
    expect(result.current.isListening).toBe(false);
    /* The browser's exception text is English and technical; it stays out of the toast. */
    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_recording_start_error', status: 'error', localized: true },
    ]);
  });

  /* The recorder's `stop` handler runs from a listener registered at start, so
     a mime type read from state there would be a render behind the recorder. */
  it('uploads the take packed as the format it was recorded in', async () => {
    FakeMediaRecorder.supportedType = 'audio/mp4';
    const { result } = setup();
    await start(result.current.externalStartRecording);

    const recorder = FakeMediaRecorder.instances[0];
    act(() => recorder.emitData(new Blob(['take'], { type: 'audio/mp4' })));
    act(() => result.current.externalStopRecording());

    expect(mockProcessAudio).toHaveBeenCalledTimes(1);
    const formData: FormData = mockProcessAudio.mock.calls[0][0];
    const uploaded = formData.get('audio') as File;
    expect(uploaded.name).toBe('audio.m4a');
    expect(uploaded.type).toBe('audio/mp4');
  });

  it('stops the recorder, the microphone and the silence monitor on unmount', async () => {
    const { result, unmount } = setup();
    await start(result.current.externalStartRecording);

    const recorder = FakeMediaRecorder.instances[0];
    expect(recorder.state).toBe('recording');
    expect(window.requestAnimationFrame).toHaveBeenCalled();

    act(() => unmount());

    expect(recorder.state).toBe('inactive');
    expect(currentTrack.stop).toHaveBeenCalled();
    expect(mockCancelAnimationFrame).toHaveBeenCalledWith(frameId);
    expect(FakeAudioContext.instances[0].close).toHaveBeenCalled();
    /* The take was dropped, not transcribed: nothing is left to submit into. */
    expect(mockProcessAudio).not.toHaveBeenCalled();
  });

  it('stops a microphone stream that arrives after the composer is gone', async () => {
    const { stream, track } = makeStream();
    let grant: () => void = () => undefined;
    mockGetUserMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          grant = () => resolve(stream);
        }),
    );

    const { result, unmount } = setup();
    act(() => result.current.externalStartRecording());
    act(() => unmount());

    await act(async () => {
      grant();
    });

    expect(track.stop).toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it('drops a queued auto-send when the composer unmounts', async () => {
    jest.useFakeTimers();
    const { result, onTranscriptionComplete, unmount } = setup({ autoSendText: AUTO_SEND_SECONDS });
    await start(result.current.externalStartRecording);

    act(() => mockProcessAudio.mock.calls[0]?.[1]?.onSuccess?.({ text: 'words in flight' }));
    act(() => unmount());
    act(() => jest.advanceTimersByTime(AUTO_SEND_SECONDS * 1000));

    expect(onTranscriptionComplete).not.toHaveBeenCalled();
  });
  it('settles after a transcription is written', async () => {
    const { result, setText, onTranscriptionSettled } = setup();
    await start(result.current.externalStartRecording);
    const recorder = FakeMediaRecorder.instances[0];
    act(() => recorder.emitData(new Blob(['take'], { type: 'audio/webm' })));
    act(() => result.current.externalStopRecording());
    act(() => mockProcessAudio.mock.calls[0]?.[1]?.onSuccess?.({ text: 'settled words' }));
    expect(setText).toHaveBeenCalledWith('settled words', undefined);
    expect(onTranscriptionSettled).toHaveBeenCalledTimes(1);
  });

  it('settles a take that is too short to upload', async () => {
    const { result, onTranscriptionSettled } = setup();
    await start(result.current.externalStartRecording);

    act(() => result.current.externalStopRecording());

    expect(mockProcessAudio).not.toHaveBeenCalled();
    expect(onTranscriptionSettled).toHaveBeenCalledTimes(1);
    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_too_short', status: 'warning', localized: true },
    ]);
  });

  /* A provider failure, an empty transcript and an unreachable server all reach
     `onError` alike, so the toast must not guess that the audio was too short. */
  it('reports a failed transcription without blaming the length of the audio', async () => {
    const { result, setText, onTranscriptionSettled } = setup();
    await start(result.current.externalStartRecording);
    const recorder = FakeMediaRecorder.instances[0];
    act(() => recorder.emitData(new Blob(['take'], { type: 'audio/webm' })));
    act(() => result.current.externalStopRecording());

    act(() => mockProcessAudio.mock.calls[0]?.[1]?.onError?.(new Error('Request failed')));

    expect(setText).not.toHaveBeenCalled();
    expect(onTranscriptionSettled).toHaveBeenCalledTimes(1);
    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_transcription_failed', status: 'error', localized: true },
    ]);
  });

  it('asks the user to wait while the previous take is still being transcribed', async () => {
    const { result } = setup();
    await start(result.current.externalStartRecording);
    const recorder = FakeMediaRecorder.instances[0];
    act(() => recorder.emitData(new Blob(['take'], { type: 'audio/webm' })));
    act(() => result.current.externalStopRecording());

    await start(result.current.externalStartRecording);

    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_transcription_pending', status: 'warning', localized: true },
    ]);
  });

  it('reports a refused microphone in the UI language', async () => {
    mockGetUserMedia.mockImplementation(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    const { result } = setup();

    await start(result.current.externalStartRecording);

    expect(result.current.isListening).toBe(false);
    expect(toastsShown()).toEqual([
      { message: 'com_ui_microphone_unavailable', status: 'error', localized: true },
    ]);
  });

  it('localizes the start and stop refusals', async () => {
    const { result } = setup();
    act(() => result.current.externalStopRecording());
    await start(result.current.externalStartRecording);
    act(() => result.current.externalStartRecording());
    /* A recorder that left the recording state without its `stop` event. */
    FakeMediaRecorder.instances[0].state = 'inactive';
    act(() => result.current.externalStopRecording());

    expect(toastsShown()).toEqual([
      { message: 'com_ui_speech_not_recording', status: 'warning', localized: true },
      { message: 'com_ui_speech_already_recording', status: 'warning', localized: true },
      { message: 'com_ui_speech_not_recording', status: 'error', localized: true },
    ]);
  });

  it('does not settle a discarded take', async () => {
    const { result, onTranscriptionSettled } = setup();
    await start(result.current.externalStartRecording);

    act(() => result.current.externalAbortRecording());

    expect(onTranscriptionSettled).not.toHaveBeenCalled();
  });

  /* The request outlives the composer, so its callback still arrives. */
  it('ignores a transcription that lands after the composer is gone', async () => {
    jest.useFakeTimers();
    const { result, setText, onTranscriptionComplete, unmount } = setup({
      autoSendText: AUTO_SEND_SECONDS,
    });
    await start(result.current.externalStartRecording);

    act(() => unmount());
    act(() =>
      mockProcessAudio.mock.calls[0]?.[1]?.onSuccess?.({ text: 'words nobody is waiting for' }),
    );
    act(() => jest.advanceTimersByTime(AUTO_SEND_SECONDS * 1000));

    expect(setText).not.toHaveBeenCalled();
    expect(onTranscriptionComplete).not.toHaveBeenCalled();
  });
});
