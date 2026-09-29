import net from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, open, readFile, writeFile } from 'node:fs/promises';
import { stopGroup } from './process.mjs';
import { createLifecycle } from './lifecycle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'api/package.json'));
const codeRoot = process.env.BYOM_CODE_REPO;
const workspaceTransitions = process.env.BYOM_WORKSPACE_TRANSITIONS === 'true';
if (!codeRoot)
  throw new Error('Set BYOM_CODE_REPO to a built LibreChat-AI/code-interpreter checkout.');
if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error('Native acceptance requires macOS or Linux (run inside WSL2 on Windows).');
}
const service = path.resolve(codeRoot, 'service/.build-service/src/service-api.js');
const cli = path.resolve(
  process.env.BYOM_CODE_CLI ?? path.join(codeRoot, 'packages/code/dist/cli.js'),
);
await Promise.all(
  [service, cli, path.join(root, 'client/dist/index.html')].map((file) => access(file)),
);
const runDir = await mkdtemp(path.join(tmpdir(), 'librechat-native-acceptance-'));
await chmod(runDir, 0o700);
const lifecycle = createLifecycle();
const secret = () => randomBytes(32).toString('hex');
/** Never inherit provider credentials, worker identities, proxies, or NODE_OPTIONS. */
const base = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
/** The app and test helpers load .env themselves; blank its keys before spawning. */
try {
  for (const line of (await readFile(path.join(root, '.env'), 'utf8')).split('\n')) {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key && !(key in base)) base[key] = '';
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function port() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const value = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}

async function start(name, executable, args, env = {}, cwd = runDir) {
  return lifecycle.acquire(async () => {
    const log = await open(path.join(runDir, `${name}.log`), 'a', 0o600);
    try {
      const child = spawn(executable, args, {
        cwd,
        detached: true,
        env: { ...base, ...env },
        stdio: ['ignore', log.fd, log.fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      return child;
    } finally {
      await log.close();
    }
  }, stopGroup);
}

async function ready(url, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Service exited before ${url} was ready; see ${runDir}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Retry startup only. */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}; see ${runDir}`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void lifecycle.stop().then(() => process.exit(130));
  });
}

try {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mongo = await lifecycle.acquire(
    () =>
      MongoMemoryServer.create({
        instance: { ip: '127.0.0.1', dbName: 'byom-acceptance' },
        spawn: { env: base },
      }),
    (instance) => instance.stop(),
  );
  const redisPort = await port();
  const codePort = await port();
  const appPort = await port();
  const codeURL = `http://127.0.0.1:${codePort}/v1`;
  const appURL = `http://127.0.0.1:${appPort}`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const adminToken = secret();
  await start('redis', process.env.BYOM_REDIS_BIN ?? 'redis-server', [
    '--bind',
    '127.0.0.1',
    '--port',
    String(redisPort),
    '--save',
    '',
    '--appendonly',
    'no',
  ]);
  const code = await start(
    'codeapi',
    process.execPath,
    ['--require', path.join(root, 'e2e/byom/loopback.cjs'), service],
    {
      SERVICE_PORT: String(codePort),
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(redisPort),
      CODEAPI_AUTH_PROVIDER: 'librechat-jwt',
      CODEAPI_JWT_PUBLIC_KEY: publicPem,
      CODEAPI_JWT_KID: 'acceptance',
      CODEAPI_JWT_SINGLE_TENANT_ID: 'acceptance',
      CODEAPI_SANDBOX_BACKEND: 'remote-bridge',
      CODEAPI_BRIDGE_DYNAMIC_WORKERS: 'true',
      CODEAPI_BRIDGE_AUTH_MODE: 'paired',
      CODEAPI_BRIDGE_TOKEN: adminToken,
      CODEAPI_EXECUTION_MANIFEST_PRIVATE_KEY: privatePem,
      CODEAPI_EXECUTION_MANIFEST_PUBLIC_KEY: publicPem,
      CODEAPI_EXECUTION_PROFILE: 'stateful',
      CODEAPI_RUNTIME_SESSION_MODE: 'affinity',
      JOB_TIMEOUT: '10000',
      MAX_REQUESTS: '200',
    },
  );
  await ready(`${codeURL}/health`, code);
  const config = {
    version: '1.3.11',
    cache: true,
    endpoints: {
      agents: {
        capabilities: ['tools', 'execute_code', 'stateful_code_sessions'],
        /** BYOM supplies the safe Ask baseline. The endpoint bypass permits a
         * per-turn Accept edits selection without weakening command approvals. */
        toolApproval: { enabled: true, mode: 'bypass' },
        statefulCodeSessions: {
          allowedEnvironments: ['conversation'],
          ...(workspaceTransitions && {
            conversationMoves: { enabled: true, allowAttachDetach: true },
          }),
          principalWorkers: { enabled: true, maxPerUser: 2 },
          environments: [
            {
              id: 'native',
              name: 'Native acceptance',
              type: 'attached',
              baseURL: codeURL,
              owner: 'deployment',
              pairing: { allowPrincipalWorkers: true, tokenEnv: 'BYOM_ENROLLMENT_TOKEN' },
              configSchema: {
                permissions: {
                  fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
                  commandExecution: { allowed: ['ask', 'allow'], default: 'ask' },
                },
              },
            },
          ],
        },
      },
      custom: [
        {
          name: 'Acceptance',
          apiKey: 'fixture-only',
          baseURL: `${appURL}/unreachable-model`,
          models: { default: ['acceptance'], fetch: false },
          titleConvo: false,
        },
      ],
    },
  };
  const configPath = path.join(runDir, 'librechat.yaml');
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const appEnv = {
    NODE_ENV: 'CI',
    HOST: '127.0.0.1',
    PORT: String(appPort),
    MONGO_URI: mongo.getUri(),
    DOMAIN_CLIENT: appURL,
    DOMAIN_SERVER: appURL,
    CONFIG_PATH: configPath,
    CREDS_KEY: secret(),
    CREDS_IV: randomBytes(16).toString('hex'),
    JWT_SECRET: secret(),
    JWT_REFRESH_SECRET: secret(),
    CODEAPI_AUTH_PROVIDER: 'librechat-jwt',
    CODEAPI_JWT_PRIVATE_KEY: privatePem,
    CODEAPI_JWT_KID: 'acceptance',
    CODEAPI_JWT_SINGLE_TENANT_ID: 'acceptance',
    BYOM_ENROLLMENT_TOKEN: adminToken,
    ...(workspaceTransitions && { CODE_ENVIRONMENT_DECISION_VERSION: '1' }),
    /** Deliberately unusable: accidental default routing must fail, never hit production. */
    LIBRECHAT_CODE_BASEURL: `${appURL}/forbidden-default-codeapi`,
    LIBRECHAT_CODE_BASEURL_STATEFUL: codeURL,
    LIBRECHAT_TEST_RUN_HOOK: path.join(root, 'e2e/byom/model.cjs'),
    SEARCH: 'false',
    USE_REDIS: 'false',
    USE_REDIS_STREAMS: 'false',
    CHECK_BALANCE: 'false',
    NO_INDEX: 'true',
    ALLOW_REGISTRATION: 'true',
    ALLOW_SOCIAL_LOGIN: 'false',
    ALLOW_SOCIAL_REGISTRATION: 'false',
    OPENID_AUTO_REDIRECT: 'false',
    TITLE_CONVO: 'false',
    SCHEDULES_SINGLE_PROCESS: 'true',
    ENDPOINTS: 'agents',
    LIMIT_CONCURRENT_MESSAGES: 'false',
    LIMIT_MESSAGE_IP: 'false',
    LIMIT_MESSAGE_USER: 'false',
    LOGIN_VIOLATION_SCORE: '0',
    REGISTRATION_VIOLATION_SCORE: '0',
    NON_BROWSER_VIOLATION_SCORE: '0',
  };
  const app = await start(
    'librechat',
    process.execPath,
    [path.join(root, 'api/server/index.js')],
    appEnv,
    root,
  );
  await ready(appURL, app);
  await mkdir(path.join(runDir, 'workers'), { mode: 0o700 });
  console.log(
    `Native BYOM acceptance: ${appURL}; Code API ${codeURL}; Redis ${redisPort}; Mongo ${mongo.instanceInfo.port}`,
  );
  console.log(`Private run directory: ${runDir}`);
  const test = await lifecycle.acquire(
    () =>
      spawn(
        process.execPath,
        [
          require.resolve('@playwright/test/cli'),
          'test',
          '--config',
          'e2e/byom/playwright.config.ts',
        ],
        {
          cwd: root,
          detached: true,
          stdio: 'inherit',
          env: {
            ...base,
            E2E_BASE_URL: appURL,
            BYOM_ACCEPTANCE_DIR: runDir,
            BYOM_CODE_CLI: cli,
            BYOM_WORKSPACE_TRANSITIONS: String(workspaceTransitions),
            E2E_CHROMIUM_CHANNEL: process.env.E2E_CHROMIUM_CHANNEL ?? '',
            PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
            ...(process.env.LD_LIBRARY_PATH && { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH }),
          },
        },
      ),
    stopGroup,
  );
  process.exitCode = await new Promise((resolve, reject) => {
    test.once('error', reject);
    test.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await lifecycle.stop();
  console.log(
    `Acceptance logs retained privately at ${runDir}; no existing services or workspaces were changed.`,
  );
}
