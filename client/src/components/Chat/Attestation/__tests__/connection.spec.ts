import { connectVerificationReport, verificationViewerUrl } from '../connection';
import { report, modelReport, viewerUrl } from 'test/fixtures/nearai';

const origin = 'https://cloud-stg.near.ai';
let iframe: HTMLIFrameElement;
let disconnect: () => void;
let onReady: jest.Mock;
let onError: jest.Mock;
let onClose: jest.Mock;

function receive(type: string, overrides: Partial<MessageEventInit<unknown>> = {}) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source: iframe.contentWindow,
      data: { type, version: 1, requestId: 'current-request' },
      ...overrides,
    }),
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  iframe = document.createElement('iframe');
  document.body.appendChild(iframe);
  onReady = jest.fn();
  onError = jest.fn();
  onClose = jest.fn();
  disconnect = connectVerificationReport({
    iframe,
    reports: [report],
    viewerUrl,
    onReady,
    onError,
    onClose,
  });
});

afterEach(() => {
  disconnect();
  iframe.remove();
  jest.useRealTimers();
});

it('waits for the exact viewer before sending only the projected report to an explicit origin', () => {
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  expect(post).not.toHaveBeenCalled();
  expect(new URL(iframe.src).searchParams.get('canRequestReports')).toBe('false');
  expect(new URL(iframe.src).searchParams.get('canClose')).toBe('true');
  receive('NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    {
      type: 'NEAR_AI_VERIFICATION_REPORT',
      version: 1,
      requestId: 'current-request',
      reports: [report],
    },
    origin,
  );
  expect(onReady).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60_000);
  expect(onError).not.toHaveBeenCalled();
});

it.each([
  { origin: 'https://other.example' },
  { source: window },
  { data: { type: 'NEAR_AI_VERIFICATION_CENTER_READY', version: 2, requestId: 'current-request' } },
  { data: { type: 'NEAR_AI_VERIFICATION_CENTER_READY', version: 1 } },
  { data: { type: 'NEAR_AI_VERIFICATION_CENTER_READY', version: 1, requestId: '' } },
  { data: null },
])('ignores untrusted or malformed messages (%j)', (overrides) => {
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive('NEAR_AI_VERIFICATION_CENTER_READY', overrides);
  expect(post).not.toHaveBeenCalled();
  expect(onReady).not.toHaveBeenCalled();
});

it('does not let stale errors or close messages affect a new handshake', () => {
  receive('NEAR_AI_VERIFICATION_CLOSE');
  expect(onClose).not.toHaveBeenCalled();
  receive('NEAR_AI_VERIFICATION_CENTER_READY');
  receive('NEAR_AI_VERIFICATION_ERROR', {
    data: { type: 'NEAR_AI_VERIFICATION_ERROR', version: 1, requestId: 'stale' },
  });
  receive('NEAR_AI_VERIFICATION_CLOSE', {
    data: { type: 'NEAR_AI_VERIFICATION_CLOSE', version: 1, requestId: 'stale' },
  });
  expect(onError).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  receive('NEAR_AI_VERIFICATION_ERROR');
  expect(onError).toHaveBeenCalledTimes(1);
  receive('NEAR_AI_VERIFICATION_CLOSE');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(iframe).not.toHaveAttribute('src');
});

it('times out, cleans up on unmount and never delivers to a disconnected frame', () => {
  jest.advanceTimersByTime(60_000);
  expect(onError).toHaveBeenCalledTimes(1);
  disconnect();
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive('NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).not.toHaveBeenCalled();
  expect(iframe).not.toHaveAttribute('src');
  jest.advanceTimersByTime(60_000);
  expect(onError).toHaveBeenCalledTimes(1);
});

it('projects metadata again before crossing the iframe boundary', () => {
  disconnect();
  const unsafe = {
    ...report,
    apiKey: 'SECRET',
    evidence: {
      intelQuote: 'public quote',
      nonce: 'public nonce',
      eventLog: '[]',
      apiKey: 'SECRET',
    },
  };
  disconnect = connectVerificationReport({
    iframe,
    reports: [unsafe],
    viewerUrl,
    onReady,
    onError,
    onClose,
  });
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive('NEAR_AI_VERIFICATION_CENTER_READY');
  expect(JSON.stringify(post.mock.calls)).not.toContain('SECRET');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({
      reports: [
        expect.objectContaining({
          evidence: {
            intelQuote: 'public quote',
            nonce: 'public nonce',
            eventLog: '[]',
          },
        }),
      ],
    }),
    origin,
  );
});

it('sends model and gateway reports together without inventing a completion ID', () => {
  disconnect();
  const gateway = {
    ...modelReport,
    scope: 'gateway' as const,
    status: 'partial' as const,
    attestation: { ...modelReport.attestation!, tlsBinding: { kind: 'none' as const } },
  };
  disconnect = connectVerificationReport({
    iframe,
    reports: [gateway, modelReport],
    viewerUrl,
    onReady,
    onError,
    onClose,
  });
  const post = jest.spyOn(iframe.contentWindow!, 'postMessage');
  receive('NEAR_AI_VERIFICATION_CENTER_READY');
  expect(post).toHaveBeenCalledWith(
    expect.objectContaining({ reports: [gateway, modelReport] }),
    origin,
  );
});

it('bounds the combined size of multiple reports', () => {
  disconnect();
  const large = { ...modelReport, error: { code: 'test', message: 'x'.repeat(600_000) } };
  expect(() =>
    connectVerificationReport({
      iframe,
      reports: [large, large],
      viewerUrl,
      onReady,
      onError,
      onClose,
    }),
  ).toThrow('exceed the viewer limit');
});

it.each([
  'javascript:alert(1)',
  'http://cloud-stg.near.ai/verify',
  'https://user:secret@cloud-stg.near.ai/verify',
  'https://cloud-stg.near.ai/verify#receipt=old',
  'https://cloud-stg.near.ai/dashboard',
])('rejects unsupported viewer URLs (%s)', (url) => {
  expect(() => verificationViewerUrl(url)).toThrow();
});

it('allows the configured HTTPS viewer and local development', () => {
  expect(verificationViewerUrl(viewerUrl).origin).toBe(origin);
  expect(verificationViewerUrl('http://localhost:3011/verify').origin).toBe(
    'http://localhost:3011',
  );
});
