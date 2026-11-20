import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const artifact =
  process.argv[2] ??
  fileURLToPath(new URL('../../packages/channel-gateway/dist/main.cjs', import.meta.url));
const applicationId = '123456789012345678';
const token = 'fixture-service-token-'.repeat(3);
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32)
  .toString('hex');
let authenticatedLookups = 0;
let channelsAvailable = true;
const leases = { acquire: 0, release: 0 };
const backend = createServer((req, res) => {
  req.resume();
  if (req.headers.authorization !== `Bearer ${token}` || req.headers['x-tenant-id']) {
    res.writeHead(401).end();
    return;
  }
  const root = '/api/channels/discord/service';
  const bodies = {
    [`${root}/runtime/bootstrap`]: {
      discord: { enabled: true, gateway: { enabled: false, pollIntervalMs: 100 } },
    },
    [`${root}/runtime/applications`]: {
      applications: [{ applicationId, applicationRevision: 'revision', tenantId: 'canonical' }],
    },
    [`${root}/runtime/channels`]: { channels: [] },
    [`${root}/security/${applicationId}`]: {
      applicationId,
      applicationRevision: 'revision',
      botUserId: '234567890123456789',
      publicKey,
      tenantId: 'canonical',
    },
  };
  if (req.url === `${root}/runtime/channels` && !channelsAvailable) {
    res.writeHead(503, { 'Content-Type': 'application/json' }).end('{}');
    return;
  }
  // The application owner keeps one lease and polls an empty inbox; with the Gateway off that is all it does.
  if (req.url === `${root}/gateway/acquire`) leases.acquire++;
  if (req.url === `${root}/gateway/release`) leases.release++;
  if (
    [
      `${root}/gateway/acquire`,
      `${root}/gateway/renew`,
      `${root}/gateway/release`,
      `${root}/inbox/claim`,
    ].includes(req.url)
  ) {
    res.writeHead(204).end();
    return;
  }
  if (!(req.url in bodies)) {
    res.writeHead(404).end();
    return;
  }
  if (req.url.includes('/security/')) authenticatedLookups++;
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(bodies[req.url]));
});
await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const child = spawn(process.execPath, [artifact], {
  env: {
    ...process.env,
    PORT: String(port),
    LISTEN_HOST: '127.0.0.1',
    CHANNEL_PROVIDER: 'discord',
    LIBRECHAT_INTERNAL_URL: `http://127.0.0.1:${backend.address().port}`,
    CHANNEL_SERVICE_TOKEN: token,
    CHANNEL_ID: '',
    CHANNEL_TENANT_ID: '_',
    SLACK_APP_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
const lines = createInterface({ input: child.stdout });
child.stderr.resume();
let deadline;
const ready = new Promise((resolve, reject) => {
  deadline = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('Discord process did not become ready'));
  }, 15000);
  child.once('error', reject);
  child.once('exit', () => reject(new Error('Discord process exited before readiness')));
  lines.on('line', (line) => {
    try {
      if (JSON.parse(line).event === 'discord_gateway_ready') resolve();
    } catch {
      // Dependencies may print non-JSON startup diagnostics; they are not readiness evidence.
    }
  });
});
try {
  await ready;
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) })).status, 200);
  const url = `${base}/discord/${applicationId}/interactions`;
  const send = async (payload, signed = true, changed = false) => {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex');
    return fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      body: changed ? body + ' ' : body,
      headers: {
        'Content-Type': 'application/json',
        ...(signed ? { 'x-signature-ed25519': signature, 'x-signature-timestamp': timestamp } : {}),
      },
    });
  };
  assert.equal((await send({ type: 1 }, false)).status, 401);
  const pong = await send({ type: 1, application_id: applicationId });
  assert.equal(pong.status, 200);
  assert.deepEqual(await pong.json(), { type: 1 });
  assert.equal((await send({ type: 1, application_id: '999999999999999999' })).status, 400);
  assert.equal((await send({ type: 1 }, true, true)).status, 401);
  assert.ok(authenticatedLookups >= 3);

  // Private health and metrics. Neither is part of the public route set, and neither carries an identifier.
  const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(2000) });
  const until = async (check, what) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await check();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const detail = async () => (await get('/healthz/detail')).json();
  const owned = await until(async () => {
    const current = await detail();
    return current.applications === 1 ? current : undefined;
  }, 'the owned application');
  assert.equal(owned.status, 'ready');
  assert.equal(owned.process.level, 'healthy');
  assert.equal(owned.workers.level, 'healthy');
  assert.equal(owned.quarantined, 0);
  // Nothing about the bot has been observed, so an idle application is unknown, never healthy.
  assert.deepEqual(owned.credentials, {
    disabled: 0,
    unknown: 1,
    healthy: 0,
    degraded: 0,
    failing: 0,
  });
  assert.deepEqual(owned.permissions, {
    disabled: 0,
    unknown: 1,
    healthy: 0,
    degraded: 0,
    failing: 0,
  });
  assert.deepEqual(owned.native, { disabled: 1, unknown: 0, healthy: 0, degraded: 0, failing: 0 });
  const metrics = await (await get('/metrics')).text();
  const lines = new Set(metrics.split('\n'));
  for (const expected of [
    'channel_gateway_discord_ingress_total{outcome="ping"} 1',
    'channel_gateway_discord_ingress_total{outcome="bad_signature"} 2',
    'channel_gateway_discord_ingress_total{outcome="bad_context"} 1',
    'channel_gateway_discord_ack_seconds_count 4',
    'channel_gateway_discord_applications_owned 1',
    'channel_gateway_discord_health{concern="workers",level="healthy"} 1',
    'channel_gateway_discord_health{concern="native",level="disabled"} 1',
  ])
    assert.ok(lines.has(expected), `missing metric line: ${expected}`);
  for (const secret of [applicationId, publicKey, token, 'canonical'])
    assert.ok(!metrics.includes(secret) && !JSON.stringify(owned).includes(secret));

  // Readiness keeps its meaning: it follows discovery alone, and liveness never moves.
  channelsAvailable = false;
  await until(async () => (await get('/readyz')).status === 503, 'readiness to follow discovery');
  assert.equal((await get('/livez')).status, 200);
  const failing = await detail();
  assert.equal(failing.status, 'not_ready');
  assert.equal(failing.workers.level, 'degraded');
  assert.equal(failing.applications, 1);
  channelsAvailable = true;
  await until(async () => (await get('/readyz')).status === 200, 'readiness to recover');
  assert.equal((await detail()).workers.level, 'healthy');

  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  assert.deepEqual(leases, { acquire: 1, release: 1 });
  console.log(
    'PASS: built Discord process discovers securely, verifies raw signatures, reports private health and metrics, keeps readiness unchanged and shuts down cleanly',
  );
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
  lines.close();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
}
