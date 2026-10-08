import { EventEmitter } from 'events';
import { DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS } from 'librechat-data-provider';
import type { SseKeepaliveResponse } from '../keepalive';
import {
  SSE_KEEPALIVE_FRAME,
  startSseKeepalive,
  loadStreamKeepaliveMs,
  resolveStreamKeepaliveMs,
} from '../keepalive';

class FakeResponse extends EventEmitter implements SseKeepaliveResponse {
  writableEnded = false;
  writes: string[] = [];
  flush = jest.fn();
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

describe('startSseKeepalive', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('writes an SSE comment frame on every interval while the response is open', () => {
    const res = new FakeResponse();
    startSseKeepalive(res, 1_000);

    jest.advanceTimersByTime(2_500);

    expect(res.writes).toEqual([SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_FRAME]);
    expect(res.flush).toHaveBeenCalledTimes(2);
  });

  it('stops when the response closes', () => {
    const res = new FakeResponse();
    startSseKeepalive(res, 1_000);

    res.emit('close');
    jest.advanceTimersByTime(5_000);

    expect(res.writes).toEqual([]);
  });

  it('stops when the returned handle is called', () => {
    const res = new FakeResponse();
    const stop = startSseKeepalive(res, 1_000);

    stop();
    jest.advanceTimersByTime(5_000);

    expect(res.writes).toEqual([]);
  });

  it('never writes after the response has ended', () => {
    const res = new FakeResponse();
    startSseKeepalive(res, 1_000);

    res.writableEnded = true;
    jest.advanceTimersByTime(5_000);

    expect(res.writes).toEqual([]);
  });

  it('does nothing when the interval is 0', () => {
    const res = new FakeResponse();
    startSseKeepalive(res, 0);

    jest.advanceTimersByTime(60_000);

    expect(res.writes).toEqual([]);
  });
});

describe('resolveStreamKeepaliveMs', () => {
  it('defaults below the shortest common proxy idle timeout', () => {
    expect(resolveStreamKeepaliveMs(undefined)).toBe(DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS);
    expect(DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS).toBeLessThan(60_000);
  });

  it('honors a configured interval, including 0 to disable', () => {
    expect(resolveStreamKeepaliveMs({ streamKeepaliveIntervalMs: 10_000 })).toBe(10_000);
    expect(resolveStreamKeepaliveMs({ streamKeepaliveIntervalMs: 0 })).toBe(0);
  });
});

describe('loadStreamKeepaliveMs', () => {
  it('reuses a config already on the request without loading', async () => {
    const load = jest.fn();
    const config = { endpoints: { agents: { streamKeepaliveIntervalMs: 5_000 } } };

    await expect(loadStreamKeepaliveMs(config, load)).resolves.toBe(5_000);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads the config when the request has none', async () => {
    const load = jest
      .fn()
      .mockResolvedValue({ endpoints: { agents: { streamKeepaliveIntervalMs: 0 } } });

    await expect(loadStreamKeepaliveMs(undefined, load)).resolves.toBe(0);
  });

  it('falls back to the default when loading fails', async () => {
    const load = jest.fn().mockRejectedValue(new Error('config unavailable'));

    await expect(loadStreamKeepaliveMs(undefined, load)).resolves.toBe(
      DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS,
    );
  });
});
