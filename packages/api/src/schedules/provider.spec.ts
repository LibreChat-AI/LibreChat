import * as http from 'node:http';
import type { GrantFetch } from './provider';
import { createSignalBoundGrantRequest, hasScheduledOboScopes } from './provider';

it.each([
  [undefined, 'read write', true],
  ['write read offline_access', 'read write', true],
  ['read', 'read write', false],
  ['', 'read', false],
])('checks provider scope %s against %s', (granted, required, valid) => {
  expect(hasScheduledOboScopes(granted, required)).toBe(valid);
});

it('cancels a stalled HTTP grant without aborting concurrent requests on the same configuration', async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/blocked') {
      entered();
      return;
    }
    res.end('success');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture has no port');
  const base = `http://127.0.0.1:${address.port}`;
  const seen: AbortSignal[] = [];
  const config: { fetch: GrantFetch } = {
    fetch: (url, options) => {
      if (options.signal) seen.push(options.signal);
      return fetch(url, options);
    },
  };
  const request = createSignalBoundGrantRequest({
    request: async (config: { fetch: GrantFetch }, _type, parameters) =>
      (
        await config.fetch(`${base}/${parameters.route}`, { signal: AbortSignal.timeout(5_000) })
      ).text(),
    getFetch: (config) => config.fetch,
    setFetch: (config, fetch) => {
      config.fetch = fetch;
    },
  });
  try {
    const abort = new AbortController();
    const blocked = request(config, 'refresh_token', { route: 'blocked' }, abort.signal).catch(
      (e) => e,
    );
    await ready;
    await expect(request(config, 'login', { route: 'normal' })).resolves.toBe('success');
    abort.abort();
    expect(await blocked).toMatchObject({ name: 'AbortError' });
    expect(seen[0].aborted).toBe(true);
    expect(seen[1].aborted).toBe(false);
    await expect(
      request(config, 'refresh_token', { route: 'normal' }, abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
