import type { ClientLogsOptions } from './logs';
import {
  testExports,
  stopClientLogs,
  startClientLogs,
  CLIENT_LOG_LIMITS,
  recordClientEvent,
  reportBoundaryError,
  createClientLogExporter,
} from './logs';
import logger from '~/utils/logger';

type KeyValue = {
  key: string;
  value: { stringValue?: string; intValue?: string; boolValue?: boolean };
};
type SentRecord = {
  severityText: string;
  body: { stringValue: string };
  attributes: KeyValue[];
  traceId?: string;
  spanId?: string;
};
type SentPayload = {
  resourceLogs: Array<{
    resource: { attributes: KeyValue[] };
    scopeLogs: Array<{ logRecords: SentRecord[] }>;
  }>;
};

const fetchMock = jest.fn<Promise<{ status: number }>, [string, RequestInit]>();

function respond(status: number) {
  return Promise.resolve({ status });
}

function options(overrides: Partial<ClientLogsOptions> = {}): ClientLogsOptions {
  return {
    endpoint: '/api/rum/v1/logs',
    serviceName: 'librechat-web',
    environment: 'demo',
    buildId: 'index-Ab12Cd.js',
    getToken: () => 'session-jwt',
    getSessionId: () => 'hdx-session-1',
    fetch: fetchMock,
    ...overrides,
  };
}

function payloadAt(index: number): SentPayload {
  const init = fetchMock.mock.calls[index]?.[1];
  return JSON.parse(String(init?.body));
}

function recordsAt(index: number): SentRecord[] {
  return payloadAt(index).resourceLogs[0].scopeLogs[0].logRecords;
}

function allRecords(): SentRecord[] {
  return fetchMock.mock.calls.flatMap((_call, index) => recordsAt(index));
}

function attributesOf(entries: KeyValue[]): Record<string, string | boolean | undefined> {
  return Object.fromEntries(
    entries.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]),
  );
}

async function flushInterval() {
  await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.flushIntervalMs);
}

beforeEach(() => {
  jest.useFakeTimers();
  testExports.resetPageState();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => respond(200));
});

afterEach(() => {
  stopClientLogs();
  jest.useRealTimers();
});

describe('createClientLogExporter', () => {
  it('batches records as OTLP/JSON to the proxy with session auth and resource attributes', async () => {
    const exporter = createClientLogExporter(options());

    exporter.log('error', [
      'conversation',
      'Error fetching conversation',
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    ]);
    exporter.log('warn', ['[useChatFunctions] Refusing to send']);
    await flushInterval();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/rum/v1/logs');
    expect(init?.method).toBe('POST');
    expect(init?.keepalive).toBe(false);
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer session-jwt',
    });

    const payload = payloadAt(0);
    expect(attributesOf(payload.resourceLogs[0].resource.attributes)).toEqual(
      expect.objectContaining({
        'service.name': 'librechat-web',
        'service.version': 'index-Ab12Cd.js',
        'deployment.environment': 'demo',
      }),
    );
    const [first, second] = recordsAt(0);
    expect(first.severityText).toBe('ERROR');
    expect(first.body.stringValue).toBe('Error fetching conversation');
    expect(attributesOf(first.attributes)).toEqual(
      expect.objectContaining({
        'log.source': 'logger',
        'logger.name': 'conversation',
        'exception.type': 'TypeError',
        'exception.message': "Cannot read properties of undefined (reading 'id')",
        'session.id': 'hdx-session-1',
        'url.template': '/',
      }),
    );
    expect(second.severityText).toBe('WARN');
    exporter.dispose();
  });

  it('never sends non-error arguments and scrubs free text', async () => {
    const exporter = createClientLogExporter(options());

    exporter.log('warn', [
      'Saving failed for jane@example.com',
      { prompt: 'my secret prompt', headers: { authorization: 'Bearer abc' } },
      'second string with response text',
    ]);
    exporter.log('error', [
      Object.assign(new TypeError('token=abcdef123456 rejected'), { config: { data: 'body' } }),
    ]);
    exporter.log('error', [new Error('Model rejected prompt: my medical history')]);
    await flushInterval();

    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain('Saving failed for [email]');
    expect(body).not.toMatch(
      /jane@example\.com|my secret prompt|response text|abcdef123456|medical history/,
    );
    const [, , applicationError] = recordsAt(0);
    expect(applicationError.body.stringValue).toBe('Error');
    exporter.dispose();
  });

  it('collapses duplicates into one record with a repeat count, then summarizes later repeats', async () => {
    const exporter = createClientLogExporter(options());
    const failUpload = () => exporter.log('error', ['Upload failed', new Error('Network Error')]);

    for (let i = 0; i < 5; i += 1) {
      failUpload();
    }
    await flushInterval();

    expect(recordsAt(0)).toHaveLength(1);
    expect(attributesOf(recordsAt(0)[0].attributes)['log.repeat_count']).toBe('5');

    for (let i = 0; i < 3; i += 1) {
      failUpload();
    }
    await flushInterval();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.dedupeWindowMs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const summary = attributesOf(recordsAt(1)[0].attributes);
    expect(summary['log.repeat_count']).toBe('3');
    expect(summary['log.deduplicated']).toBe(true);
    exporter.dispose();
  });

  it('caps distinct records per minute', async () => {
    const exporter = createClientLogExporter(options());

    for (let i = 0; i < 50; i += 1) {
      exporter.log('error', [`Distinct failure ${i}`]);
    }
    await flushInterval();
    await flushInterval();
    await flushInterval();

    expect(allRecords()).toHaveLength(CLIENT_LOG_LIMITS.recordsPerMinute);
    exporter.dispose();
  });

  it('retries retryable failures with backoff and drops the batch after the attempt limit', async () => {
    fetchMock.mockImplementation(() => respond(503));
    const exporter = createClientLogExporter(options());

    exporter.log('error', ['Transient failure']);
    await flushInterval();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.maxBackoffMs * 4);
    expect(fetchMock).toHaveBeenCalledTimes(CLIENT_LOG_LIMITS.maxAttempts);

    await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.maxBackoffMs * 4);
    expect(fetchMock).toHaveBeenCalledTimes(CLIENT_LOG_LIMITS.maxAttempts);
    exporter.dispose();
  });

  it('stops exporting for the page after a fatal proxy status', async () => {
    fetchMock.mockImplementation(() => respond(404));
    const exporter = createClientLogExporter(options());

    exporter.log('error', ['First']);
    await flushInterval();
    exporter.log('error', ['Second']);
    await flushInterval();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    exporter.dispose();
  });

  it('turns itself off after repeated network failures instead of retrying forever', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const exporter = createClientLogExporter(options());

    for (let i = 0; i < 20; i += 1) {
      exporter.log('error', [`Offline ${i}`]);
      await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.maxBackoffMs);
    }

    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(
      CLIENT_LOG_LIMITS.maxConsecutiveFailures,
    );
    exporter.dispose();
  });

  it('reports admission failure when the budget is exhausted or export is disabled', async () => {
    const exporter = createClientLogExporter(options());
    for (let i = 0; i < CLIENT_LOG_LIMITS.recordsPerMinute; i += 1) {
      exporter.log('error', [`Budget ${i}`]);
    }
    const dropped = jest.fn();
    expect(exporter.event('stale-asset-recovery-start', {}, jest.fn(), dropped)).toBe(false);
    expect(dropped).toHaveBeenCalledTimes(1);
    exporter.dispose();
    expect(exporter.event('stale-asset-recovery-reload')).toBe(false);
  });

  it.each(['queued', 'sending', 'suppressed'])(
    'settles %s deliveries on dispose and ignores late responses',
    async (state) => {
      let answer: (value: { status: number }) => void = () => undefined;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      );
      const exporter = createClientLogExporter(options());
      const delivered = jest.fn();
      const dropped = jest.fn();
      exporter.event('stale-asset-recovery-start', {}, delivered, dropped);
      if (state !== 'queued') {
        await flushInterval();
      }
      if (state === 'suppressed') {
        exporter.event('stale-asset-recovery-start', {}, delivered, dropped);
      }
      exporter.dispose();
      expect(dropped).toHaveBeenCalledTimes(state === 'suppressed' ? 2 : 1);
      answer({ status: 200 });
      await flushInterval();
      expect(delivered).not.toHaveBeenCalled();
      expect(dropped).toHaveBeenCalledTimes(state === 'suppressed' ? 2 : 1);
    },
  );

  it('settles dropped deliveries when retries are exhausted', async () => {
    fetchMock.mockImplementation(() => respond(503));
    const exporter = createClientLogExporter(options());
    const dropped = jest.fn();
    exporter.event('stale-asset-recovery-start', {}, jest.fn(), dropped);
    await jest.advanceTimersByTimeAsync(CLIENT_LOG_LIMITS.maxBackoffMs * 4);
    expect(dropped).toHaveBeenCalledTimes(1);
    exporter.dispose();
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it('drops silent auth responses without acknowledging delivery, but accepts collector 204s', async () => {
    fetchMock.mockImplementationOnce(() => respond(204));
    const exporter = createClientLogExporter(options());
    const delivered = jest.fn();
    const dropped = jest.fn();
    exporter.event('stale-asset-recovery-start', {}, delivered, dropped);
    await flushInterval();
    expect(delivered).not.toHaveBeenCalled();
    expect(dropped).toHaveBeenCalledTimes(1);
    exporter.dispose();
    const accepted = createClientLogExporter({
      ...options(),
      fetch: () => Promise.resolve({ status: 204, headers: { get: () => 'true' } }),
    });
    accepted.event('stale-asset-recovery-reload', {}, delivered, dropped);
    await flushInterval();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(dropped).toHaveBeenCalledTimes(1);
    accepted.dispose();
  });

  it('attaches the active trace and span ids from the RUM SDK context', async () => {
    const spanKey = Symbol.for('OpenTelemetry Context Key SPAN');
    const apiKey = Symbol.for('opentelemetry.js.api.1');
    const span = {
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    };
    Reflect.set(globalThis, apiKey, {
      context: {
        active: () => ({ getValue: (key: symbol) => (key === spanKey ? span : undefined) }),
      },
    });
    const exporter = createClientLogExporter(options());

    exporter.log('error', ['Traced failure']);
    await flushInterval();

    expect(recordsAt(0)[0]).toEqual(
      expect.objectContaining({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    );
    Reflect.deleteProperty(globalThis, apiKey);
    exporter.dispose();
  });
});

describe('client log lifecycle', () => {
  it('sends nothing when exporting was never started or has been stopped', async () => {
    logger.error('Not exported', new Error('boom'));
    reportBoundaryError('route', new Error('boom'));
    recordClientEvent('stale-asset-recovery-start');
    await flushInterval();
    expect(fetchMock).not.toHaveBeenCalled();

    startClientLogs(options());
    stopClientLogs();
    logger.error('Still not exported');
    await flushInterval();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes logger warn/error, boundary catches and stale-asset events once started', async () => {
    startClientLogs(options());
    const boundaryError = new TypeError('Failed to fetch dynamically imported module');

    logger.warn('[Example] Something degraded');
    logger.info('info is not exported');
    reportBoundaryError('route', boundaryError, true);
    reportBoundaryError('route', boundaryError, true);
    recordClientEvent('stale-asset-recovery-declined', {
      assetPath: '/assets/SubagentThreadPanel-x.js',
      clientBuildId: 'index-Old1.js',
    });
    recordClientEvent('spa-route-change', { assetPath: '/c/new' });
    await flushInterval();

    const records = allRecords();
    expect(records.map((record) => attributesOf(record.attributes)['log.source'])).toEqual([
      'logger',
      'boundary',
      'asset',
    ]);
    expect(attributesOf(records[1].attributes)).toEqual(
      expect.objectContaining({ 'error.boundary': 'route', 'error.chunk_load': true }),
    );
    expect(records[1].severityText).toBe('WARN');
    expect(attributesOf(records[2].attributes)).toEqual(
      expect.objectContaining({
        'event.name': 'stale_asset.recovery_declined',
        'asset.path': '/assets/SubagentThreadPanel-x.js',
        'event.build_id': 'index-Old1.js',
      }),
    );
  });

  it('flushes with keepalive when the page is hidden', async () => {
    startClientLogs(options());

    logger.error('Pending at unload');
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.keepalive).toBe(true);
  });

  it('drains every queued record that fits the keepalive quota on page hide', async () => {
    startClientLogs(options());

    for (let i = 0; i < 25; i += 1) {
      logger.error(`Queued before unload ${i}`);
    }
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordsAt(0)).toHaveLength(25);
  });

  it('measures batches in encoded bytes so multibyte text stays under the keepalive quota', async () => {
    startClientLogs(options());

    for (let i = 0; i < CLIENT_LOG_LIMITS.recordsPerMinute; i += 1) {
      logger.error(`${'界'.repeat(60)}${i}`, `${i} ${'界'.repeat(500)}`, new Error('x'));
    }
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);

    const sizes = fetchMock.mock.calls.map(
      ([, init]) => new TextEncoder().encode(String(init.body)).length,
    );
    expect(sizes.length).toBeGreaterThan(1);
    sizes.forEach((size) => expect(size).toBeLessThanOrEqual(CLIENT_LOG_LIMITS.maxPayloadBytes));
    expect(allRecords()).toHaveLength(CLIENT_LOG_LIMITS.recordsPerMinute);
  });

  it('re-sends an unanswered in-flight batch with keepalive when the page is hidden', async () => {
    let answer: (value: { status: number }) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    startClientLogs(options());

    logger.error('In flight at unload');
    await flushInterval();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.keepalive).toBe(true);
    expect(recordsAt(1).map((record) => record.body.stringValue)).toEqual(['In flight at unload']);

    answer({ status: 503 });
    await flushInterval();
    await flushInterval();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('hands the active batch to keepalive only once across visibilitychange and pagehide', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    startClientLogs(options());
    logger.error('In flight during both unload signals');
    await flushInterval();
    const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].keepalive).toBe(true);
    visibility.mockRestore();
  });

  it.each(['fulfilled', 'rejected'])(
    'reserves keepalive bytes across restarts until the old request is %s',
    async (outcome) => {
      let resolve: (value: { status: number }) => void = () => undefined;
      let reject: (error: Error) => void = () => undefined;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise((res, rej) => {
            resolve = res;
            reject = rej;
          }),
      );
      startClientLogs(options());
      const logLargeRecord = (i: number) =>
        logger.error(
          `Large record ${i}`,
          `${i} ${'界'.repeat(500)}`,
          Object.assign(new Error('x'), {
            stack: [
              'Error: x',
              ...Array.from(
                { length: 12 },
                (_, frame) => `    at frame${frame} (/assets/${'a'.repeat(170)}.js:1:2)`,
              ),
            ].join('\n'),
          }),
        );
      for (let i = 0; i < 20; i += 1) {
        logLargeRecord(i);
      }
      window.dispatchEvent(new Event('pagehide'));
      await jest.advanceTimersByTimeAsync(0);
      expect(recordsAt(0)).toHaveLength(20);
      stopClientLogs();
      startClientLogs(options());
      for (let i = 20; i < 30; i += 1) {
        logLargeRecord(i);
      }
      window.dispatchEvent(new Event('pagehide'));
      const encodedBytes = () =>
        fetchMock.mock.calls.reduce(
          (bytes, [, init]) => bytes + new TextEncoder().encode(String(init.body)).length,
          0,
        );
      expect(encodedBytes()).toBeLessThanOrEqual(CLIENT_LOG_LIMITS.maxPayloadBytes);
      await jest.advanceTimersByTimeAsync(0);
      expect(allRecords().length).toBeLessThan(30);
      if (outcome === 'fulfilled') {
        resolve({ status: 200 });
      } else {
        reject(new Error('cancelled'));
      }
      await jest.advanceTimersByTimeAsync(0);
      window.dispatchEvent(new Event('pagehide'));
      await jest.advanceTimersByTimeAsync(0);
      expect(allRecords()).toHaveLength(30);
      expect(
        fetchMock.mock.calls
          .slice(1)
          .reduce(
            (bytes, [, init]) => bytes + new TextEncoder().encode(String(init.body)).length,
            0,
          ),
      ).toBeLessThanOrEqual(CLIENT_LOG_LIMITS.maxPayloadBytes);
    },
  );

  it('preserves the minute and page record budgets across exporter restarts', async () => {
    for (let pageWindow = 0; pageWindow < 10; pageWindow += 1) {
      if (pageWindow > 0) {
        await jest.advanceTimersByTimeAsync(60_000);
      }
      startClientLogs(options());
      for (let i = 0; i < 30; i += 1) {
        logger.error(`Budget window ${pageWindow} record ${i}`);
      }
      await flushInterval();
      await flushInterval();
      stopClientLogs();
      startClientLogs(options());
      logger.error(`Restart bypass ${pageWindow}`);
      await flushInterval();
      stopClientLogs();
    }
    expect(allRecords()).toHaveLength(CLIENT_LOG_LIMITS.recordsPerPage);
    await jest.advanceTimersByTimeAsync(60_000);
    startClientLogs(options());
    logger.error('Page budget must remain exhausted');
    await flushInterval();
    expect(allRecords()).toHaveLength(CLIENT_LOG_LIMITS.recordsPerPage);
  });

  it('does not resume after a fatal page shutdown when the exporter is restarted', async () => {
    fetchMock.mockImplementation(() => respond(404));
    startClientLogs(options());
    logger.error('Proxy has been revoked');
    await flushInterval();
    stopClientLogs();
    startClientLogs(options());
    logger.error('Restart must not bypass revocation');
    await flushInterval();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses a cross-origin endpoint', async () => {
    startClientLogs(options({ endpoint: 'https://collector.example.com/v1/logs' }));

    logger.error('Should not leave');
    await flushInterval();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
