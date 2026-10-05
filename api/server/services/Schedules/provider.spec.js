const http = require('node:http');
const path = require('node:path');
const client = jest.requireActual(
  path.join(process.cwd(), 'node_modules/openid-client/build/index.js'),
);
const {
  createSignalBoundGrantRequest,
} = require('../../../../packages/api/src/schedules/provider');

it('aborts the real SDK refresh fetch without cancelling a normal grant on the shared config', async () => {
  let started;
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (new URLSearchParams(body).get('refresh_token') === 'blocked-test-grant') {
        started();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ access_token: 'test-access', token_type: 'Bearer', expires_in: 3600 }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = new client.Configuration(
    { issuer: base, token_endpoint: `${base}/token` },
    'test-client',
    'not-a-real-secret',
  );
  client.allowInsecureRequests(config);
  const priorFetch = jest.fn((url, options) => globalThis.fetch(url, options));
  config[client.customFetch] = priorFetch;
  const request = createSignalBoundGrantRequest({
    request: (config, type, parameters) => client.genericGrantRequest(config, type, parameters),
    getFetch: (config) => config[client.customFetch],
    setFetch: (config, fetch) => {
      config[client.customFetch] = fetch;
    },
  });
  try {
    const abort = new AbortController();
    const blocked = request(
      config,
      'refresh_token',
      { refresh_token: 'blocked-test-grant' },
      abort.signal,
    ).catch((e) => e);
    await entered;
    await expect(
      client.genericGrantRequest(config, 'refresh_token', { refresh_token: 'normal-test-grant' }),
    ).resolves.toMatchObject({ access_token: 'test-access' });
    abort.abort();
    expect(await blocked).toMatchObject({ name: 'AbortError' });
    expect(priorFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(priorFetch.mock.calls[1][1].signal?.aborted).not.toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}, 10_000);
