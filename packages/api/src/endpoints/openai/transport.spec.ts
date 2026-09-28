import { createServer } from 'node:http';
import { channel } from 'node:diagnostics_channel';
import { Providers, initializeModel } from '@librechat/agents';
import type { AddressInfo } from 'node:net';
import type { Dispatcher } from 'undici';
import { getOpenAIConfig } from './config';

const proxyKeys = [
  'PROXY',
  'proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
const dispatchers = new Set<Dispatcher>();
const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of proxyKeys) delete process.env[key];
});
afterEach(() => {
  process.env = originalEnv;
});
afterAll(async () => {
  await Promise.all([...dispatchers].map((dispatcher) => dispatcher.destroy()));
});

/** Real sockets and the locked Agent model client: mocked fetch cannot prove Undici's timers. */
async function request({
  directEndpoint,
  mode,
  bodyTimeout = 1000,
  headersTimeout = 1000,
  streaming = true,
  cancel = false,
  baseURLIsUserProvided = false,
}: {
  directEndpoint: boolean;
  mode: 'headers' | 'idle' | 'active' | 'redirect';
  bodyTimeout?: number;
  headersTimeout?: number;
  streaming?: boolean;
  cancel?: boolean;
  baseURLIsUserProvided?: boolean;
}) {
  const transportErrors: string[] = [];
  const paths: string[] = [];
  const errors = channel('undici:request:error');
  const listener = (event: unknown) => {
    const code = (event as { error?: { code?: unknown } }).error?.code;
    if (typeof code === 'string' && code.startsWith('UND_ERR_')) transportErrors.push(code);
  };
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume();
    if (mode === 'redirect') {
      res.writeHead(302, { Location: '/must-not-follow' });
      res.end();
      return;
    }
    const headers = { 'Content-Type': streaming ? 'text/event-stream' : 'application/json' };
    if (mode !== 'headers') {
      res.writeHead(200, headers);
      res.flushHeaders();
    }
    const pulse =
      mode === 'active' ? setInterval(() => res.write(': keepalive\n\n'), 100) : undefined;
    const finish = setTimeout(() => {
      if (mode === 'headers') res.writeHead(200, headers);
      res.end(
        streaming
          ? 'data: [DONE]\n\n'
          : JSON.stringify({
              id: 'local',
              object: 'chat.completion',
              created: 1,
              model: 'local-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'done' },
                  finish_reason: 'stop',
                },
              ],
            }),
      );
    }, 3000);
    res.on('close', () => {
      clearTimeout(finish);
      clearInterval(pulse);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  errors.subscribe(listener);
  try {
    const { llmConfig, configOptions } = getOpenAIConfig('local-test-only', {
      reverseProxyUrl: `${baseURL}${directEndpoint ? '/exact?route=test' : '/v1'}`,
      directEndpoint,
      baseURLIsUserProvided,
      allowedAddresses: baseURLIsUserProvided ? ['127.0.0.1'] : undefined,
      transportTimeouts: { bodyTimeout, headersTimeout },
      streaming,
      modelOptions: { model: 'local-test' },
      addParams: { timeout: 10_000, maxRetries: 0 },
    });
    dispatchers.add(configOptions!.fetchOptions!.dispatcher as Dispatcher);
    const model = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: { ...llmConfig, verbosity: undefined, configuration: configOptions },
    });
    if (cancel) timer = setTimeout(() => controller.abort(), 100);
    if (streaming) {
      const stream = await model.stream('test', { signal: controller.signal });
      for await (const chunk of stream) {
        void chunk;
      }
    } else {
      await model.invoke('test', { signal: controller.signal });
    }
  } catch (error) {
    failure = error;
  } finally {
    clearTimeout(timer);
    errors.unsubscribe(listener);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return { failure, transportErrors, paths };
}

describe.each([false, true])('model transport directEndpoint=%s', (directEndpoint) => {
  it('enforces the configured header timeout through the Agent SDK', async () => {
    const result = await request({ directEndpoint, mode: 'headers' });
    expect(result.failure).toBeDefined();
    expect(result.transportErrors).toContain('UND_ERR_HEADERS_TIMEOUT');
    expect(result.paths).toEqual([directEndpoint ? '/exact?route=test' : '/v1/chat/completions']);
  });
  it('enforces the body-idle timeout after headers', async () => {
    const result = await request({ directEndpoint, mode: 'idle' });
    expect(result.failure).toBeDefined();
    expect(result.transportErrors).toContain('UND_ERR_BODY_TIMEOUT');
    expect(result.paths).toHaveLength(1);
  });
});

describe('direct endpoint stream lifecycle', () => {
  it('allows a longer idle allowance to complete', async () => {
    const result = await request({ directEndpoint: true, mode: 'idle', bodyTimeout: 5000 });
    expect(result.failure).toBeUndefined();
  });
  it('resets the idle allowance when data arrives', async () => {
    const result = await request({ directEndpoint: true, mode: 'active' });
    expect(result.failure).toBeUndefined();
  });
  it('keeps cancellation independent of disabled transport timers', async () => {
    const result = await request({
      directEndpoint: true,
      mode: 'idle',
      bodyTimeout: 0,
      headersTimeout: 0,
      cancel: true,
    });
    expect(result.failure).toBeDefined();
    expect(result.transportErrors).not.toContain('UND_ERR_BODY_TIMEOUT');
  });
  it('bounds non-streaming response bodies too', async () => {
    const result = await request({ directEndpoint: true, mode: 'idle', streaming: false });
    expect(result.failure).toBeDefined();
    expect(result.transportErrors).toContain('UND_ERR_BODY_TIMEOUT');
  });
  it('retains redirect rejection for user-provided URLs', async () => {
    const result = await request({
      directEndpoint: true,
      mode: 'redirect',
      baseURLIsUserProvided: true,
    });
    expect(result.failure).toBeDefined();
    expect(result.paths).toEqual(['/exact?route=test']);
  });
});
