import { MediaSourceAppender } from '../MediaSourceAppender';

type Listener = () => void;

class FakeSourceBuffer {
  public updating = false;
  public readonly appended: ArrayBuffer[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(event: string, handler: Listener) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  appendBuffer(data: ArrayBuffer) {
    this.updating = true;
    this.appended.push(data);
    queueMicrotask(() => {
      this.updating = false;
      this.listeners.get('updateend')?.forEach((handler) => handler());
    });
  }
}

const createdSources: FakeMediaSource[] = [];

class FakeMediaSource {
  public readyState: 'closed' | 'open' | 'ended' = 'closed';
  public readonly sourceBuffers: FakeSourceBuffer[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    createdSources.push(this);
  }

  addEventListener(event: string, handler: Listener) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  addSourceBuffer(_type: string) {
    const sourceBuffer = new FakeSourceBuffer();
    this.sourceBuffers.push(sourceBuffer);
    return sourceBuffer;
  }

  endOfStream() {
    this.readyState = 'ended';
  }

  /** A MediaSource stays `closed` until a media element attaches its object URL */
  attach() {
    this.readyState = 'open';
    this.listeners.get('sourceopen')?.forEach((handler) => handler());
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const chunk = (byte: number) => new Uint8Array([byte]).buffer as ArrayBuffer;
const appendedBytes = (source: FakeMediaSource) =>
  (source.sourceBuffers[0]?.appended ?? []).map((buffer) => new Uint8Array(buffer)[0]);

describe('MediaSourceAppender', () => {
  let objectUrlCount = 0;

  beforeEach(() => {
    createdSources.length = 0;
    objectUrlCount = 0;
    Object.defineProperty(global, 'MediaSource', {
      writable: true,
      configurable: true,
      value: FakeMediaSource,
    });
    Object.defineProperty(global.URL, 'createObjectURL', {
      writable: true,
      configurable: true,
      value: () => `blob:media-source-${++objectUrlCount}`,
    });
  });

  it('appends chunks that were queued before the media element attached', async () => {
    const appender = new MediaSourceAppender('audio/mpeg');
    const source = createdSources[0];
    appender.mediaSourceUrl;

    /** A short response can be read in full before `sourceopen` fires */
    appender.addData(chunk(1));
    appender.addData(chunk(2));
    expect(appendedBytes(source)).toEqual([]);

    source.attach();
    await flush();

    expect(appendedBytes(source)).toEqual([1, 2]);
  });

  it('appends chunks that arrive after the media element attached', async () => {
    const appender = new MediaSourceAppender('audio/mpeg');
    const source = createdSources[0];
    appender.mediaSourceUrl;

    source.attach();
    appender.addData(chunk(1));
    await flush();
    appender.addData(chunk(2));
    await flush();

    expect(appendedBytes(source)).toEqual([1, 2]);
  });

  it('only ends the stream once every queued chunk has been appended', async () => {
    const appender = new MediaSourceAppender('audio/mpeg');
    const source = createdSources[0];
    appender.mediaSourceUrl;

    appender.addData(chunk(1));
    appender.addData(chunk(2));
    appender.close();
    expect(source.readyState).toBe('closed');

    source.attach();
    await flush();

    expect(appendedBytes(source)).toEqual([1, 2]);
    expect(source.readyState).toBe('ended');
  });

  it('ends a closed stream that never received data', async () => {
    const appender = new MediaSourceAppender('audio/mpeg');
    const source = createdSources[0];
    appender.mediaSourceUrl;

    /** An empty response, or a read timeout before the first byte, still has to end —
     *  otherwise the element waits on a source that can never receive data. */
    source.attach();
    appender.close();
    await flush();

    expect(source.readyState).toBe('ended');
  });

  it('ends a stream closed before the media element attached', async () => {
    const appender = new MediaSourceAppender('audio/mpeg');
    const source = createdSources[0];
    appender.mediaSourceUrl;

    appender.close();
    expect(source.readyState).toBe('closed');

    source.attach();
    await flush();

    expect(source.readyState).toBe('ended');
  });

  it('reuses a single object URL for the lifetime of the appender', () => {
    const appender = new MediaSourceAppender('audio/mpeg');

    expect(appender.mediaSourceUrl).toBe(appender.mediaSourceUrl);
    expect(objectUrlCount).toBe(1);
  });
});
