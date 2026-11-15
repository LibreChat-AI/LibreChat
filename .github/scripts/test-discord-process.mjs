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
    [`${root}/runtime/applications`]: { applications: [] },
    [`${root}/runtime/channels`]: { channels: [] },
    [`${root}/security/${applicationId}`]: {
      applicationId,
      applicationRevision: 'revision',
      botUserId: '234567890123456789',
      publicKey,
      tenantId: 'canonical',
    },
  };
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
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
  console.log(
    'PASS: built Discord process discovers securely, verifies raw signatures and shuts down cleanly',
  );
} finally {
  clearTimeout(deadline);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
  lines.close();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
}
