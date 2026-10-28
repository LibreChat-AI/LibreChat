import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createCache } from './cache.js';
import { createApp } from './app.js';

const config = {
  sharedKey: 'broker-shared-key-value',
  tchatSecret: 'tchat-secret',
  djangoBaseUrl: 'http://backend:8000',
  upstreamBaseUrl: 'https://api.tensorgrid.space',
  requestTimeoutMs: 5000,
};

const silent = { error() {}, log() {} };

const makeFetch = (responses) => {
  const calls = [];
  const impl = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { impl, calls };
};

const get = (headers = { 'X-Tchat-User-Email': 'a@b.co' }, key = config.sharedKey) =>
  new Request('http://broker.internal/tchat/credit', {
    headers: { Authorization: `Bearer ${key}`, ...headers },
  });

const django = {
  body: {
    success: true,
    data: { balance_cents: 1234, currency: 'USD', updated_at: '2026-10-28T00:00:00Z' },
  },
};

test('credit returns only balance and currency, via a signed Django call', async () => {
  const fetch = makeFetch([django]);
  const app = createApp({ config, cache: createCache(), fetchImpl: fetch.impl, logger: silent });

  const response = await app(get());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { balance_cents: 1234, currency: 'USD' });
  assert.equal(fetch.calls[0].url, 'http://backend:8000/api/internal/tchat/v1/credit');
  assert.equal(JSON.parse(fetch.calls[0].init.body).email, 'a@b.co');
  assert.match(fetch.calls[0].init.headers['X-TensorGrid-Signature'], /^sha256=/);
});

test('credit refuses a wrong shared key and a request without identity', async () => {
  const fetch = makeFetch([]);
  const app = createApp({ config, cache: createCache(), fetchImpl: fetch.impl, logger: silent });

  assert.equal((await app(get(undefined, 'wrong'))).status, 401);
  assert.equal((await app(get({}))).status, 401);
  assert.equal(fetch.calls.length, 0);
});

test('credit is cached briefly per identity', async () => {
  const fetch = makeFetch([django]);
  const app = createApp({ config, cache: createCache(), fetchImpl: fetch.impl, logger: silent });

  await app(get());
  await app(get());

  assert.equal(fetch.calls.length, 1);
});

test('credit maps an unknown account to 403 and a Django failure to 503', async () => {
  const fetch = makeFetch([{ status: 404, body: {} }, { status: 503, body: {} }]);
  const app = createApp({ config, cache: createCache(), fetchImpl: fetch.impl, logger: silent });

  assert.equal((await app(get({ 'X-Tchat-User-Email': 'x@y.co' }))).status, 403);
  assert.equal((await app(get({ 'X-Tchat-User-Email': 'z@y.co' }))).status, 503);
});
