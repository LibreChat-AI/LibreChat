import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { RealtimeTranscriptionErrorCode } from 'librechat-data-provider';
import useSpeechToTextRealtime, {
  COMMIT_GRACE_MS,
  COMPLETION_TIMEOUT_MS,
} from '../useSpeechToTextRealtime';
import { monitorSilence } from '../silence';
import store from '~/store';

const mockOpenSession = jest.fn();
const mockShowToast = jest.fn();
const mockStopSilence = jest.fn();

jest.mock('~/data-provider', () => ({
  useRealtimeTranscriptionMutation: () => ({ mutateAsync: mockOpenSession }),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('../silence', () => ({
  monitorSilence: jest.fn(() => mockStopSilence),
}));

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send = jest.fn();
  close = jest.fn(() => {
    this.readyState = 'closed';
  });

  constructor(readonly label: string) {}

  open() {
    this.readyState = 'open';
    this.onopen?.();
  }

  emit(event: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent);
  }

  drop() {
    this.readyState = 'closed';
    this.onclose?.();
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  channel: FakeDataChannel | null = null;
  addTrack = jest.fn();
  createDataChannel = jest.fn((label: string) => {
    this.channel = new FakeDataChannel(label);
    return this.channel;
  });

  createOffer = jest.fn(async () => ({ type: 'offer', sdp: 'v=0\r\noffer' }));
  setLocalDescription = jest.fn(async () => undefined);
  setRemoteDescription = jest.fn(async () => undefined);
  close = jest.fn(() => {
    this.connectionState = 'closed';
  });

  constructor() {
    FakePeerConnection.instances.push(this);
  }

  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const providerError = (code: string) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: { status: 404, data: { error: code } },
  });

let mockGetUserMedia: jest.Mock;
let track: { stop: jest.Mock; kind: string };

function setup({
  autoSendText = -1,
  autoTranscribeAudio = false,
  languageSTT = '',
}: { autoSendText?: number; autoTranscribeAudio?: boolean; languageSTT?: string } = {}) {
  const setText = jest.fn();
  const onTranscriptionComplete = jest.fn();
  const onTranscriptionSettled = jest.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.speechToText, true);
        set(store.autoTranscribeAudio, autoTranscribeAudio);
        set(store.languageSTT, languageSTT);
      }}
    >
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () =>
      useSpeechToTextRealtime(
        setText,
        onTranscriptionComplete,
        onTranscriptionSettled,
        autoSendText,
      ),
    { wrapper },
  );
  return { ...rendered, setText, onTranscriptionComplete, onTranscriptionSettled };
}

type Rendered = ReturnType<typeof setup>;

const TAKE = 7;

/** Starts a take and lets the offer/answer exchange finish. */
const begin = async (rendered: Rendered) => {
  await act(async () => {
    await rendered.result.current.startRecording(TAKE);
  });
  const pc = FakePeerConnection.instances[FakePeerConnection.instances.length - 1];
  return { pc, channel: pc?.channel as FakeDataChannel };
};

const connect = (pc: FakePeerConnection, channel: FakeDataChannel) =>
  act(() => {
    pc.setState('connected');
    channel.open();
  });

const emit = (channel: FakeDataChannel, event: Record<string, unknown>) =>
  act(() => channel.emit(event));

const delta = (item_id: string, text: string) => ({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id,
  delta: text,
});

const completed = (item_id: string, transcript: string) => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id,
  transcript,
});

const committed = (item_id: string) => ({ type: 'input_audio_buffer.committed', item_id });

/** Stops the take and lets the commit go out. */
const stopAndCommit = (rendered: Rendered) => {
  act(() => rendered.result.current.stopRecording());
  act(() => {
    jest.advanceTimersByTime(COMMIT_GRACE_MS);
  });
};

describe('useSpeechToTextRealtime', () => {
  const originalPeerConnection = global.RTCPeerConnection;
  const originalMediaDevices = navigator.mediaDevices;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    FakePeerConnection.instances = [];
    track = { stop: jest.fn(), kind: 'audio' };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    mockGetUserMedia = jest.fn().mockResolvedValue(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: mockGetUserMedia },
    });
    (global as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;
    mockOpenSession.mockResolvedValue({ sdp: 'v=0\r\nanswer' });
  });

  afterEach(() => {
    jest.useRealTimers();
    (global as { RTCPeerConnection?: unknown }).RTCPeerConnection = originalPeerConnection;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: originalMediaDevices,
    });
  });

  it('opens the session through the server with the offer and the speech language', async () => {
    const rendered = setup({ languageSTT: 'de-DE' });
    const { pc, channel } = await begin(rendered);

    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(pc.addTrack).toHaveBeenCalledWith(track, expect.anything());
    expect(channel.label).toBe('oai-events');
    expect(mockOpenSession).toHaveBeenCalledWith({ sdp: 'v=0\r\noffer', language: 'de-DE' });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'v=0\r\nanswer' });
    expect(rendered.result.current.isListening).toBe(true);
    expect(rendered.result.current.connection).toBe('connecting');

    connect(pc, channel);

    expect(rendered.result.current.connection).toBeNull();
  });

  it('leaves the language out when the user has not chosen one', async () => {
    const rendered = setup();
    await begin(rendered);

    expect(mockOpenSession).toHaveBeenCalledWith({ sdp: 'v=0\r\noffer' });
  });

  it('writes transcript deltas into the composer while the user speaks', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);

    emit(channel, delta('item_1', 'Hello'));
    emit(channel, delta('item_1', ' world'));
    emit(channel, delta('item_2', 'again'));

    expect(rendered.setText.mock.calls).toEqual([
      ['Hello', TAKE],
      ['Hello world', TAKE],
      ['Hello world again', TAKE],
    ]);
  });

  it('commits on stop and settles once the committed item is transcribed', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    emit(channel, delta('item_1', 'Hello wor'));

    act(() => rendered.result.current.stopRecording());

    expect(rendered.result.current.isListening).toBe(false);
    expect(rendered.result.current.isLoading).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(COMMIT_GRACE_MS);
    });

    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input_audio_buffer.commit' }),
    );
    expect(track.stop).toHaveBeenCalled();
    expect(rendered.onTranscriptionSettled).not.toHaveBeenCalled();

    emit(channel, committed('item_1'));
    emit(channel, completed('item_1', 'Hello world.'));

    expect(rendered.setText).toHaveBeenLastCalledWith('Hello world.', TAKE);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    expect(rendered.result.current.isLoading).toBe(false);
    expect(pc.close).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('settles when the transcript arrives before the commit is acknowledged', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    stopAndCommit(rendered);

    emit(channel, completed('item_1', 'Out of order.'));
    expect(rendered.onTranscriptionSettled).not.toHaveBeenCalled();

    emit(channel, committed('item_1'));

    expect(rendered.setText).toHaveBeenLastCalledWith('Out of order.', TAKE);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
  });

  it('auto-sends the final transcript after the configured delay', async () => {
    const rendered = setup({ autoSendText: 2 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    stopAndCommit(rendered);
    emit(channel, committed('item_1'));
    emit(channel, completed('item_1', 'Send this.'));

    act(() => {
      jest.advanceTimersByTime(1999);
    });
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(rendered.onTranscriptionComplete).toHaveBeenCalledWith('Send this.', TAKE);
  });

  it('settles quietly when stop arrives before any audio reached the provider', async () => {
    const rendered = setup({ autoSendText: 0 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    stopAndCommit(rendered);

    emit(channel, { type: 'error', error: { code: 'input_audio_buffer_commit_empty' } });

    expect(mockShowToast).not.toHaveBeenCalled();
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    expect(rendered.setText).not.toHaveBeenCalled();
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('drops a cancelled take without writing, settling, or sending anything', async () => {
    const rendered = setup({ autoSendText: 0 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    emit(channel, delta('item_1', 'Never mind'));
    rendered.setText.mockClear();

    act(() => rendered.result.current.abortRecording());

    expect(track.stop).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(rendered.result.current.isListening).toBe(false);

    channel.emit(completed('item_1', 'Never mind.'));
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(rendered.setText).not.toHaveBeenCalled();
    expect(rendered.onTranscriptionSettled).not.toHaveBeenCalled();
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('abandons a take stopped while still connecting, without committing', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);

    act(() => rendered.result.current.stopRecording());

    expect(channel.send).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(rendered.result.current.isListening).toBe(false);
    expect(rendered.result.current.connection).toBeNull();
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it.each([
    ['NotAllowedError', 'com_ui_microphone_permission_denied'],
    ['SecurityError', 'com_ui_microphone_permission_denied'],
    ['NotFoundError', 'com_ui_microphone_unavailable'],
  ])('reports a %s from the microphone as %s', async (name, message) => {
    mockGetUserMedia.mockRejectedValueOnce(new DOMException('denied', name));
    const rendered = setup();

    await begin(rendered);

    expect(mockShowToast).toHaveBeenCalledWith({ message, status: 'error' });
    expect(mockOpenSession).not.toHaveBeenCalled();
    expect(rendered.result.current.isListening).toBe(false);
    expect(rendered.result.current.connection).toBeNull();
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
  });

  it.each([
    [RealtimeTranscriptionErrorCode.NOT_CONFIGURED, 'com_ui_live_transcription_unavailable'],
    [RealtimeTranscriptionErrorCode.PROVIDER_ERROR, 'com_ui_live_transcription_start_error'],
  ])('reports a %s session refusal and releases the microphone', async (code, message) => {
    mockOpenSession.mockRejectedValueOnce(providerError(code));
    const rendered = setup();

    const { pc } = await begin(rendered);

    expect(mockShowToast).toHaveBeenCalledWith({ message, status: 'error' });
    expect(track.stop).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(rendered.result.current.isListening).toBe(false);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
  });

  it('does not touch the microphone where the browser has no WebRTC', async () => {
    (global as { RTCPeerConnection?: unknown }).RTCPeerConnection = undefined;
    const rendered = setup();

    await act(async () => {
      await rendered.result.current.startRecording(TAKE);
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_live_transcription_unsupported',
      status: 'error',
    });
    expect(mockGetUserMedia).not.toHaveBeenCalled();
    expect(rendered.result.current.isListening).toBe(false);
  });

  it('shows a reconnect and recovers from it', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);

    act(() => pc.setState('disconnected'));
    expect(rendered.result.current.connection).toBe('reconnecting');
    expect(rendered.result.current.isListening).toBe(true);

    act(() => pc.setState('connected'));
    expect(rendered.result.current.connection).toBeNull();
  });

  it('keeps the text heard so far, without sending it, when the connection is lost', async () => {
    const rendered = setup({ autoSendText: 0 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    emit(channel, delta('item_1', 'Half a'));

    act(() => pc.setState('failed'));

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_live_transcription_connection_lost',
      status: 'error',
    });
    expect(rendered.setText).toHaveBeenLastCalledWith('Half a', TAKE);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    expect(rendered.result.current.isListening).toBe(false);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('treats a session the provider closes as a lost connection', async () => {
    const rendered = setup();
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);

    act(() => channel.drop());

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_live_transcription_connection_lost',
      status: 'error',
    });
    expect(track.stop).toHaveBeenCalled();
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
  });

  it('keeps the text heard so far, without sending it, when the provider reports an error', async () => {
    const rendered = setup({ autoSendText: 0 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    emit(channel, delta('item_1', 'Partial'));

    emit(channel, { type: 'error', error: { code: 'server_error', message: 'boom' } });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_live_transcription_error',
      status: 'error',
    });
    expect(rendered.setText).toHaveBeenLastCalledWith('Partial', TAKE);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('settles a commit that never finalizes, keeping its text for review', async () => {
    const rendered = setup({ autoSendText: 0 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    emit(channel, delta('item_1', 'Still waiting'));
    stopAndCommit(rendered);

    act(() => {
      jest.advanceTimersByTime(COMPLETION_TIMEOUT_MS - 1);
    });
    expect(rendered.onTranscriptionSettled).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(1);
    });

    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_live_transcription_error',
      status: 'error',
    });
    expect(rendered.setText).toHaveBeenLastCalledWith('Still waiting', TAKE);
    expect(rendered.onTranscriptionSettled).toHaveBeenCalledWith(TAKE);
    expect(rendered.result.current.isLoading).toBe(false);
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });

  it('stops itself after silence when Auto Transcribe is on', async () => {
    const rendered = setup({ autoTranscribeAudio: true });
    const { pc, channel } = await begin(rendered);

    expect(monitorSilence).not.toHaveBeenCalled();
    connect(pc, channel);
    expect(monitorSilence).toHaveBeenCalledWith(expect.anything(), {
      minDecibels: -45,
      onSilence: expect.any(Function),
    });

    const { onSilence } = jest.mocked(monitorSilence).mock.calls[0][1];
    act(() => onSilence());
    act(() => {
      jest.advanceTimersByTime(COMMIT_GRACE_MS);
    });

    expect(channel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'input_audio_buffer.commit' }),
    );
    expect(rendered.result.current.isLoading).toBe(true);
  });

  it('releases the microphone, session, and silence monitor on unmount', async () => {
    const rendered = setup({ autoTranscribeAudio: true });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);

    rendered.unmount();

    expect(track.stop).toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalled();
    expect(channel.close).toHaveBeenCalled();
    expect(mockStopSilence).toHaveBeenCalled();
  });

  it('stops a microphone stream that arrives after the composer is gone', async () => {
    let grant: (stream: unknown) => void = () => undefined;
    mockGetUserMedia.mockReturnValueOnce(new Promise((resolve) => (grant = resolve)));
    const rendered = setup();

    let pending: Promise<void> | undefined;
    act(() => {
      pending = rendered.result.current.startRecording(TAKE);
    });
    rendered.unmount();
    await act(async () => {
      grant({ getTracks: () => [track], getAudioTracks: () => [track] });
      await pending;
    });

    expect(track.stop).toHaveBeenCalled();
    expect(FakePeerConnection.instances).toHaveLength(0);
  });

  it('drops a queued auto-send when the composer unmounts', async () => {
    const rendered = setup({ autoSendText: 2 });
    const { pc, channel } = await begin(rendered);
    connect(pc, channel);
    stopAndCommit(rendered);
    emit(channel, committed('item_1'));
    emit(channel, completed('item_1', 'Queued.'));

    rendered.unmount();
    act(() => {
      jest.runOnlyPendingTimers();
    });

    expect(rendered.onTranscriptionComplete).not.toHaveBeenCalled();
  });
});
