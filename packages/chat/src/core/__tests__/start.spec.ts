import type { TSubmission } from 'librechat-data-provider';
import {
  getReconnectDelay,
  waitForRetryDelay,
  getRecoverySteerId,
  getRetryAfterDelay,
  isServerNotReadyError,
  isSettledStartResponse,
  isResumedStartResponse,
  isRetryableNetworkError,
  isReplacedStartResponse,
  getStreamStartFailureText,
  getStartGenerationStreamId,
  getStartGenerationCreatedAt,
  isUnnegotiatedV2StartControl,
  getPredecessorMismatchStartResponse,
} from '../resumable';
import { supportsGenerationProtocolV2, getGenerationProtocolVersion } from '../protocol';

/** An HTTP failure as the generation POST rejects with it. */
const httpError = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error('request failed'), { response: { status, data, headers } });

describe('generation protocol negotiation', () => {
  it.each([
    [{ generationProtocolVersion: 2 }, 2],
    [{ generationProtocolVersion: 1 }, 1],
    [{ generationProtocolVersion: '2' }, 1],
    [{}, 1],
    [undefined, 1],
  ] as const)('fails closed for protocol echo %#', (value, expected) => {
    expect(getGenerationProtocolVersion(value)).toBe(expected);
    expect(supportsGenerationProtocolV2(value)).toBe(expected === 2);
  });
});

describe('start responses', () => {
  it('reads the stream id and the generation epoch only when well formed', () => {
    expect(getStartGenerationStreamId({ streamId: 's-1' })).toBe('s-1');
    expect(getStartGenerationStreamId({ streamId: '' })).toBeNull();
    expect(getStartGenerationStreamId(null)).toBeNull();
    expect(getStartGenerationCreatedAt({ generationCreatedAt: 1000 })).toBe(1000);
    expect(getStartGenerationCreatedAt({ generationCreatedAt: -1 })).toBeNull();
    expect(getStartGenerationCreatedAt({ generationCreatedAt: 1.5 })).toBeNull();
  });

  it('honors settled and replaced only on a negotiated v2 response', () => {
    const v2 = { generationProtocolVersion: 2 };
    expect(isSettledStartResponse({ ...v2, status: 'settled' })).toBe(true);
    expect(isReplacedStartResponse({ ...v2, status: 'replaced' })).toBe(true);
    expect(isSettledStartResponse({ status: 'settled' })).toBe(false);
    expect(isUnnegotiatedV2StartControl({ status: 'replaced' })).toBe(true);
    expect(isUnnegotiatedV2StartControl({ ...v2, status: 'replaced' })).toBe(false);
    expect(isResumedStartResponse({ status: 'resumed' })).toBe(true);
  });

  it('reads a predecessor mismatch only from its complete 409 body', () => {
    const body = {
      status: 'predecessor_mismatch',
      code: 'GENERATION_PREDECESSOR_MISMATCH',
      streamId: 's-1',
      conversationId: 'c-1',
      generationCreatedAt: 5,
      active: true,
    };
    expect(getPredecessorMismatchStartResponse(httpError(409, body))).toEqual({
      streamId: 's-1',
      conversationId: 'c-1',
      generationCreatedAt: 5,
      active: true,
    });
    expect(getPredecessorMismatchStartResponse(httpError(400, body))).toBeNull();
    expect(
      getPredecessorMismatchStartResponse(httpError(409, { ...body, active: 'yes' })),
    ).toBeNull();
  });

  it('names the parked steer a recovery submission replays', () => {
    const submission = (fields: Partial<TSubmission>) => fields as TSubmission;
    expect(getRecoverySteerId(submission({ recoverySteerId: 'steer-1' }))).toBe('steer-1');
    expect(getRecoverySteerId(submission({ clientRequestId: 'steer-recovery:steer-2' }))).toBe(
      'steer-2',
    );
    expect(getRecoverySteerId(submission({ clientRequestId: 'steer-recovery:' }))).toBeNull();
    expect(getRecoverySteerId(submission({ clientRequestId: 'other' }))).toBeNull();
  });
});

describe('start retries', () => {
  it('backs off exponentially up to the cap', () => {
    expect([1, 2, 3, 6, 10].map(getReconnectDelay)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });

  it('retries network failures and a server that is not ready yet', () => {
    expect(isRetryableNetworkError(Object.assign(new Error(), { code: 'ERR_NETWORK' }))).toBe(true);
    expect(isRetryableNetworkError({ code: 'ERR_NETWORK' })).toBe(false);
    expect(isServerNotReadyError(httpError(503, { code: 'SERVER_NOT_READY' }))).toBe(true);
    expect(isServerNotReadyError(httpError(503, {}))).toBe(false);
  });

  it('waits as long as Retry-After asks, within bounds', () => {
    expect(getRetryAfterDelay(httpError(503, {}, { 'retry-after': '3' }), 500)).toBe(3000);
    expect(getRetryAfterDelay(httpError(503, {}, { 'Retry-After': '90' }), 500)).toBe(30000);
    expect(getRetryAfterDelay(httpError(503, {}, { 'retry-after': 'soon' }), 500)).toBe(500);
  });

  it('resolves false when the wait is aborted', async () => {
    const controller = new AbortController();
    const waiting = waitForRetryDelay(60000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    await expect(waitForRetryDelay(0)).resolves.toBe(true);
  });
});

describe('getStreamStartFailureText', () => {
  it('reads the error event out of an SSE body', () => {
    const body = 'event: message\ndata: {}\n\nevent: error\ndata: {"message":"quota"}\n\n';
    expect(getStreamStartFailureText(body)).toBe('quota');
  });

  it('falls back to the raw body, the JSON payload, or the connection message', () => {
    expect(getStreamStartFailureText('plain failure')).toBe('plain failure');
    expect(getStreamStartFailureText({ code: 1 })).toBe('{"code":1}');
    expect(getStreamStartFailureText()).toBe(
      'Error connecting to server, try refreshing the page.',
    );
  });
});
