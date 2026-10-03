import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';

const limits = { items: 100, bytes: 65_536, ttlMs: 1_000 };

async function replay(transport: InMemoryEventTransport, streamId: string) {
  const events: unknown[] = [];
  const subscription = transport.subscribe(
    streamId,
    { onChunk: (event) => events.push(event) },
    { replay: limits },
  );
  await subscription.ready;
  subscription.unsubscribe();
  return events;
}

describe('bounded local replay', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('caps total entries and timer count while retaining recent streams', async () => {
    jest.useFakeTimers();
    const transport = new InMemoryEventTransport({ maxStreams: 2, maxBytes: 65_536 });
    for (let index = 0; index < 20; index++)
      await transport.emitReplayableChunk(`task-${index}`, { text: `${index}` }, limits);
    expect(jest.getTimerCount()).toBe(2);
    expect(await replay(transport, 'task-0')).toEqual([]);
    expect(await replay(transport, 'task-18')).toEqual([{ text: '18' }]);
    expect(await replay(transport, 'task-19')).toEqual([{ text: '19' }]);
    transport.destroy();
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('caps aggregate encoded bytes separately from per-stream budgets', async () => {
    const transport = new InMemoryEventTransport({ maxStreams: 10, maxBytes: 65_536 });
    await transport.emitReplayableChunk('old', { text: 'x'.repeat(40_000) }, limits);
    await transport.emitReplayableChunk('new', { text: 'y'.repeat(40_000) }, limits);
    expect(await replay(transport, 'old')).toEqual([]);
    expect(await replay(transport, 'new')).toHaveLength(1);
    transport.destroy();
  });

  it('accounts for expiry and refresh without evicting a later replacement', async () => {
    jest.useFakeTimers();
    const transport = new InMemoryEventTransport({ maxStreams: 2, maxBytes: 65_536 });
    await transport.emitReplayableChunk('task', { text: 'first' }, limits);
    jest.advanceTimersByTime(500);
    await transport.emitReplayableChunk('task', { text: 'second' }, limits);
    jest.advanceTimersByTime(501);
    expect(await replay(transport, 'task')).toHaveLength(2);
    jest.advanceTimersByTime(500);
    expect(await replay(transport, 'task')).toEqual([]);
    jest.runAllTicks();
    expect(jest.getTimerCount()).toBe(0);
    transport.destroy();
  });

  it('deduplicates chunk and terminal retries with bounded publication state', async () => {
    const transport = new InMemoryEventTransport();
    const received: unknown[] = [];
    const onDone = jest.fn();
    const subscription = transport.subscribe(
      'task',
      { onChunk: (event) => received.push(event), onDone },
      { replay: limits },
    );
    await subscription.ready;
    await transport.emitReplayableChunk('task', { text: 'first' }, limits, {
      id: '0',
      sequence: 0,
    });
    await transport.emitReplayableChunk('task', { text: 'first' }, limits, {
      id: '0',
      sequence: 0,
    });
    await transport.emitReplayableChunk('task', { text: 'second' }, limits, {
      id: '1',
      sequence: 1,
    });
    await transport.emitReplayableChunk('task', { text: 'first' }, limits, {
      id: '0',
      sequence: 0,
    });
    await transport.emitReplayableDone('task', { final: true }, limits, { id: 'done' });
    await transport.emitReplayableDone('task', { final: true }, limits, { id: 'done' });
    expect(received).toEqual([{ text: 'first' }, { text: 'second' }]);
    expect(onDone).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    transport.destroy();
  });
});
