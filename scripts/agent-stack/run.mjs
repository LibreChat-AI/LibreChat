#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvidence } from './verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mode = process.argv[2];
assert(['memory', 'redis'].includes(mode), 'Usage: node scripts/agent-stack/run.mjs memory|redis');
assert(
  process.env.PILOT_FOCUSED_HANDOFF !== 'true' || process.env.PILOT_PERSISTENT_HANDOFFS === 'true',
  'Focused handoff tests require PILOT_PERSISTENT_HANDOFFS=true',
);
process.chdir(root);
assert(
  !fs.existsSync('.env'),
  'Use a clean dedicated worktree without .env; no developer credentials are needed',
);
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const lock = path.join(root, '.agent-stack', 'active');
fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
fs.mkdirSync(lock, { mode: 0o700 });
fs.writeFileSync(path.join(lock, 'owner'), runId);
const evidence = path.join(root, '.agent-stack', runId, mode);
fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
const containers = [];
const network = `lc-pilot-${runId}`;
let networkCreated = false;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
const metadata = {
  runId,
  mode,
  commit: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current'),
  dirty: git('status', '--porcelain', '--untracked-files=no') !== '',
  developer: process.env.PILOT_DEVELOPER ?? 'lia',
  createdAt: new Date().toISOString(),
  provider: 'deterministic-fixtures',
  mongo: 'real-mongod',
  redis: mode === 'redis' ? 'real-redis' : 'absent',
  remoteExport: false,
  persistentHandoffs: process.env.PILOT_PERSISTENT_HANDOFFS === 'true',
  focusedHandoff: process.env.PILOT_FOCUSED_HANDOFF === 'true',
  images: {},
};
const source = createHash('sha256');
source.update(git('diff', 'HEAD'));
for (const name of [
  'scripts/agent-stack/run.mjs',
  'scripts/agent-stack/browser.mjs',
  'scripts/agent-stack/verify.mjs',
  'scripts/agent-stack/collector.yaml',
  'e2e/playwright.config.stack.cjs',
  'e2e/setup/teardown.stack.cjs',
  'package-lock.json',
])
  source.update(fs.readFileSync(path.join(root, name)));
metadata.sourceFingerprint = source.digest('hex');
const save = () =>
  fs.writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify(metadata, null, 2));
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
function container(suffix, image, args, command = []) {
  const name = `lc-pilot-${runId}-${suffix}`;
  // Reserve cleanup identity before creating; never remove by broad labels or prune.
  containers.push(name);
  docker(
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `librechat.pilot=${runId}`,
    '--network',
    network,
    '--network-alias',
    suffix,
    ...args,
    image,
    ...command,
  );
  metadata.images[suffix] = docker('inspect', name, '--format', '{{.Image}}');
  save();
  return name;
}
async function ready(check) {
  let lastError;
  for (let i = 0; i < 40; i++) {
    if (abort.signal.aborted) throw new Error('Pilot cancelled');
    try {
      if (await check()) return;
    } catch (error) {
      lastError = `${error.name}: ${error.message}; ${error.cause?.code ?? ''}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Local service did not become ready (${lastError ?? 'health response rejected'})`,
  );
}
async function browser(env) {
  const log = fs.openSync(path.join(evidence, 'browser.log'), 'w', 0o600);
  try {
    return await new Promise((resolve, reject) => {
      const name = `lc-pilot-${runId}-browser`;
      containers.push(name);
      const args = [
        'run',
        '--name',
        name,
        '--label',
        `librechat.pilot=${runId}`,
        '--network',
        network,
        '--user',
        `${process.getuid()}:${process.getgid()}`,
        '--shm-size=512m',
        '--mount',
        `type=bind,src=${root},dst=/work`,
        '--workdir',
        '/work',
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e',
        'node',
        'scripts/agent-stack/browser.mjs',
      ];
      const child = spawn('docker', args, {
        cwd: root,
        stdio: ['ignore', log, log],
        signal: abort.signal,
        timeout: 180000,
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    fs.closeSync(log);
  }
}

let failed = false;
try {
  docker('network', 'create', '--internal', '--label', `librechat.pilot=${runId}`, network);
  networkCreated = true;
  const mongo = container(
    'mongo',
    'mongo:8.0.15@sha256:f4d54619262ae3bc6a0a8efbebcef970b87b8ad70697479a75ce308a6f400158',
    [],
  );
  await ready(
    () =>
      docker('exec', mongo, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok') === '1',
  );
  let redis;
  if (mode === 'redis') {
    redis = container(
      'redis',
      'redis:7-alpine@sha256:520775a41a63e77e06c73e35d2fd9cc15921a609516818796b4ecbb813078bc7',
      [],
    );
    await ready(() => docker('exec', redis, 'redis-cli', 'ping') === 'PONG');
  }
  const collector = container(
    'collector',
    'otel/opentelemetry-collector-contrib:0.123.0@sha256:e39311df1f3d941923c00da79ac7ba6269124a870ee87e3c3ad24d60f8aee4d2',
    [
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--mount',
      `type=bind,src=${path.join(root, 'scripts/agent-stack/collector.yaml')},dst=/etc/otelcol-contrib/config.yaml,readonly`,
      '--mount',
      `type=bind,src=${evidence},dst=/evidence`,
      '-e',
      `PILOT_RUN_ID=${runId}`,
      '-e',
      `PILOT_MODE=${mode}`,
      '-e',
      `PILOT_DEVELOPER=${metadata.developer}`,
      '-e',
      `PILOT_BRANCH=${metadata.branch}`,
      '-e',
      `PILOT_COMMIT=${metadata.commit}`,
    ],
  );
  const env = {
    CI: 'true',
    HOME: '/tmp',
    E2E_REPLICAS: '1',
    E2E_STREAM_STORE: mode,
    E2E_CONVERSATION_HANDOFFS: metadata.persistentHandoffs ? 'true' : 'false',
    E2E_FOCUSED_HANDOFF: metadata.focusedHandoff ? 'true' : 'false',
    E2E_USE_MEMORY_MONGO: 'false',
    MONGO_URI: `mongodb://mongo:27017/LibreChat-pilot-${runId}`,
    REDIS_URI: redis ? 'redis://redis:6379/0' : 'redis://127.0.0.1:6379/0',
    E2E_REDIS_KEY_PREFIX: `pilot-${runId}`,
    E2E_BASE_URL: 'http://127.0.0.1:3080',
    E2E_RUNTIME_ENV_PATH: path.join('/work', path.relative(root, evidence), 'runtime-env.json'),
    PILOT_EVIDENCE: path.join('/work', path.relative(root, evidence)),
    PILOT_OTLP: 'http://collector:4318',
    PILOT_AGENTS_OTLP: 'http://collector:4319',
    PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
    NODE_EXTRA_CA_CERTS: '',
  };
  metadata.browserExitCode = await browser(env);
  metadata.images.browser = docker(
    'inspect',
    `lc-pilot-${runId}-browser`,
    '--format',
    '{{.Image}}',
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  docker('stop', '--time', '10', collector);
  assert.equal(
    metadata.browserExitCode,
    0,
    `Browser scenarios failed; inspect ${path.relative(root, evidence)}/browser.log`,
  );
  if (redis) {
    const keys = docker('exec', redis, 'redis-cli', '--scan').split('\n').filter(Boolean);
    const types = {};
    for (const key of keys) {
      const type = docker('exec', redis, 'redis-cli', 'type', key);
      types[type] = (types[type] ?? 0) + 1;
    }
    fs.writeFileSync(
      path.join(evidence, 'redis-state.json'),
      JSON.stringify({ keys: keys.length, types }),
    );
  }
  metadata.telemetry = verifyEvidence(evidence, metadata);
  metadata.result = 'passed';
} catch (error) {
  failed = true;
  metadata.result = 'failed';
  metadata.error = error.message;
  console.error(`Pilot ${mode} failed: ${error.message}`);
} finally {
  const cleanupFailures = [];
  for (const name of containers.reverse()) {
    try {
      const owner = docker(
        'inspect',
        name,
        '--format',
        '{{index .Config.Labels "librechat.pilot"}}',
      );
      assert.equal(owner, runId, "Refusing to remove another task's container");
      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 10000 });
      fs.writeFileSync(
        path.join(evidence, `${name.split('-').at(-1)}.log`),
        (logs.stdout ?? '') + (logs.stderr ?? ''),
        { mode: 0o600 },
      );
      docker('rm', '-f', '--volumes', name);
    } catch {
      cleanupFailures.push(name);
    }
  }
  if (networkCreated) {
    try {
      docker('network', 'rm', network);
    } catch {
      cleanupFailures.push(network);
    }
  }
  if (cleanupFailures.length === 0) {
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8'), runId);
    fs.rmSync(lock, { recursive: true });
  }
  metadata.cleanupFailures = cleanupFailures;
  if (cleanupFailures.length > 0) {
    failed = true;
    metadata.result = 'failed';
  }
  save();
  console.log(
    JSON.stringify(
      {
        evidence: path.relative(root, evidence),
        result: metadata.result,
        telemetry: metadata.telemetry,
        cleanupFailures,
      },
      null,
      2,
    ),
  );
  process.exitCode = failed ? 1 : 0;
}
