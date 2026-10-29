import { monitorSilence, SILENCE_THRESHOLD_MS } from '../silence';

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  state: AudioContextState = 'running';
  level = 0;
  close = jest.fn(() => {
    this.state = 'closed';
    return Promise.resolve();
  });

  analyser = {
    minDecibels: 0,
    frequencyBinCount: 4,
    getByteFrequencyData: jest.fn((data: Uint8Array) => data.fill(this.level)),
  };

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createMediaStreamSource() {
    return { connect: jest.fn() };
  }

  createAnalyser() {
    return this.analyser;
  }
}

describe('monitorSilence', () => {
  const stream = {} as MediaStream;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  let now: number;
  const originalAudioContext = global.AudioContext;

  const runFrame = (advanceMs: number) => {
    now += advanceMs;
    const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback];
    frames.delete(id);
    callback(now);
  };

  beforeEach(() => {
    FakeAudioContext.instances = [];
    frames = new Map();
    nextFrame = 0;
    now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id));
    (global as { AudioContext?: unknown }).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    (global as { AudioContext?: unknown }).AudioContext = originalAudioContext;
  });

  it('calls back once the stream stays quiet past the threshold, after releasing the audio graph', () => {
    const onSilence = jest.fn();
    monitorSilence(stream, { minDecibels: -50, onSilence });
    const context = FakeAudioContext.instances[0];

    expect(context.analyser.minDecibels).toBe(-50);
    runFrame(SILENCE_THRESHOLD_MS);
    expect(onSilence).not.toHaveBeenCalled();

    onSilence.mockImplementation(() => expect(context.close).toHaveBeenCalled());
    runFrame(1);

    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('keeps listening while sound keeps arriving', () => {
    const onSilence = jest.fn();
    monitorSilence(stream, { minDecibels: -45, onSilence, thresholdMs: 100 });
    const context = FakeAudioContext.instances[0];
    context.level = 10;

    for (let i = 0; i < 10; i++) {
      runFrame(60);
    }

    expect(onSilence).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
  });

  it('stops the frame loop and closes the context once, however often it is stopped', () => {
    const onSilence = jest.fn();
    const stop = monitorSilence(stream, { minDecibels: -45, onSilence });
    const context = FakeAudioContext.instances[0];

    stop();
    stop();

    expect(window.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(onSilence).not.toHaveBeenCalled();
  });
});
