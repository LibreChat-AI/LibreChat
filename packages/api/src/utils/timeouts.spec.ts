import { logger } from '@librechat/data-schemas';
import {
  outboundTimeoutMessage,
  getOutboundTimeout,
  getOutboundTimeoutMs,
  outboundRequestBudget,
  DEFAULT_OUTBOUND_TIMEOUTS_MS,
} from './timeouts';
import { isAbortError } from './errors';
import { logAxiosError } from './axios';

describe('outbound timeouts', () => {
  it('uses the default when the config omits the key', () => {
    expect(getOutboundTimeoutMs(undefined, 'ragMs')).toBe(DEFAULT_OUTBOUND_TIMEOUTS_MS.ragMs);
    expect(getOutboundTimeoutMs({ timeouts: { ocrMs: 1_000 } }, 'ragMs')).toBe(
      DEFAULT_OUTBOUND_TIMEOUTS_MS.ragMs,
    );
  });

  it('uses the configured value when present', () => {
    expect(getOutboundTimeoutMs({ timeouts: { moderationMs: 2_500 } }, 'moderationMs')).toBe(2_500);
  });
});

describe('outboundRequestBudget', () => {
  it('aborts at the wall-clock deadline and names the key to raise', async () => {
    const { timeout, timeoutErrorMessage, signal } = outboundRequestBudget(20, 'ragMs');

    expect(timeout).toBe(20);
    expect(timeoutErrorMessage).toBe(outboundTimeoutMessage('ragMs', 20));
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
  });

  it('also follows the caller signal', () => {
    const controller = new AbortController();
    const { signal } = outboundRequestBudget(60_000, 'actionsMs', controller.signal);

    controller.abort();

    expect(signal.aborted).toBe(true);
  });
});

describe('getOutboundTimeout', () => {
  const timeoutErrorMessage = outboundTimeoutMessage('actionsMs', 5);

  it('recognizes a request cancelled by its deadline', () => {
    const canceled = {
      code: 'ERR_CANCELED',
      message: 'canceled',
      config: {
        timeoutErrorMessage,
        signal: { reason: new DOMException('timed out', 'TimeoutError') },
      },
    };

    expect(getOutboundTimeout(canceled)?.message).toBe(timeoutErrorMessage);
    expect(isAbortError(canceled)).toBe(false);
  });

  it('recognizes an idle timeout carrying the budget message', () => {
    const idle = {
      code: 'ECONNABORTED',
      message: timeoutErrorMessage,
      config: { timeoutErrorMessage },
    };

    expect(getOutboundTimeout(idle)).toBe(idle);
  });

  it('leaves a user stop as an abort', () => {
    const stopped = {
      code: 'ERR_CANCELED',
      message: 'canceled',
      config: {
        timeoutErrorMessage,
        signal: { reason: new DOMException('stopped', 'AbortError') },
      },
    };

    expect(getOutboundTimeout(stopped)).toBeUndefined();
    expect(isAbortError(stopped)).toBe(true);
  });

  it('still reports a deadline wrapped in a cause as a failure', () => {
    const canceled = {
      code: 'ERR_CANCELED',
      message: 'canceled',
      config: {
        timeoutErrorMessage,
        signal: { reason: new DOMException('timed out', 'TimeoutError') },
      },
    };

    expect(isAbortError(new Error('tool failed', { cause: canceled }))).toBe(false);
  });

  it('does not read the message of an error without a budget', () => {
    const guarded = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('message must not be read');
      },
    });

    expect(getOutboundTimeout(guarded)).toBeUndefined();
  });
});

describe('logAxiosError on a budget overrun', () => {
  it('warns with the key to raise instead of logging a generic failure', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const timeoutErrorMessage = outboundTimeoutMessage('ragMs', 30_000);
    const idle = {
      code: 'ECONNABORTED',
      message: timeoutErrorMessage,
      config: { timeoutErrorMessage },
    };

    const message = logAxiosError({ message: 'RAG query failed:', error: idle });

    expect(message).toContain('timeouts.ragMs (30000 ms)');
    expect(warn).toHaveBeenCalledWith(message);
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });
});
