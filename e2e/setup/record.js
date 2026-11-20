const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const rootPath = path.resolve(__dirname, '../..');
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3080';
const storageStatePath = path.resolve(rootPath, 'e2e/storageState.json');
const configTemplatePath = path.resolve(rootPath, 'e2e/config/librechat.e2e.yaml');
const configPath = path.resolve(rootPath, 'e2e/.generated/librechat.e2e.yaml');
const fakeModelHookPath = path.resolve(rootPath, 'e2e/setup/fake-model.js');
const defaultUser = {
  email: 'testuser@example.com',
  name: 'Test User',
  password: 'securepassword123',
};

const rateLimitOverrides = {
  LOGIN_VIOLATION_SCORE: '0',
  REGISTRATION_VIOLATION_SCORE: '0',
  CONCURRENT_VIOLATION_SCORE: '0',
  MESSAGE_VIOLATION_SCORE: '0',
  NON_BROWSER_VIOLATION_SCORE: '0',
  FORK_VIOLATION_SCORE: '0',
  IMPORT_VIOLATION_SCORE: '0',
  TTS_VIOLATION_SCORE: '0',
  STT_VIOLATION_SCORE: '0',
  FILE_UPLOAD_VIOLATION_SCORE: '0',
  RESET_PASSWORD_VIOLATION_SCORE: '0',
  VERIFY_EMAIL_VIOLATION_SCORE: '0',
  TOOL_CALL_VIOLATION_SCORE: '0',
  CONVO_ACCESS_VIOLATION_SCORE: '0',
  ILLEGAL_MODEL_REQ_SCORE: '0',
  LOGIN_MAX: '20',
  LOGIN_WINDOW: '1',
  REGISTER_MAX: '20',
  REGISTER_WINDOW: '1',
  LIMIT_CONCURRENT_MESSAGES: 'false',
  CONCURRENT_MESSAGE_MAX: '20',
  LIMIT_MESSAGE_IP: 'false',
  MESSAGE_IP_MAX: '100',
  MESSAGE_IP_WINDOW: '1',
  LIMIT_MESSAGE_USER: 'false',
  MESSAGE_USER_MAX: '100',
  MESSAGE_USER_WINDOW: '1',
};

const mockOverrides = {
  CONFIG_PATH: configPath,
  /** Loaded in-process by `@librechat/api`'s `createRun` to swap in a fake model. */
  LIBRECHAT_TEST_RUN_HOOK: fakeModelHookPath,
  OPENAI_API_KEY: 'user_provided',
  TENANT_ISOLATION_STRICT: 'false',
  OPENID_CLIENT_ID: '',
  OPENID_ISSUER: '',
  OPENID_AUTO_REDIRECT: 'false',
  ALLOW_SOCIAL_LOGIN: 'false',
  ALLOW_SOCIAL_REGISTRATION: 'false',
  STREAM_KEEP_COMPLETED_JOBS: 'true',
};

const secretKeyPattern = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS|CLIENT_ID|_KEY)$/i;
const preservedCredentialEnvKeys = new Set([
  ...Object.keys(rateLimitOverrides),
  ...Object.keys(mockOverrides).filter((key) => key !== 'OPENAI_API_KEY'),
  'CREDS_KEY',
  'CREDS_IV',
  'E2E_USER_PASSWORD',
  'E2E_USER_B_PASSWORD',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'REFRESH_TOKEN_EXPIRY',
  'SESSION_EXPIRY',
]);
const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function appURL(pathname = '') {
  const normalizedBaseURL = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return new URL(pathname.replace(/^\/+/, ''), normalizedBaseURL).toString();
}

function getServerAddress() {
  const url = new URL(baseURL);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return { host, port };
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function getUser(env) {
  return {
    email: env.E2E_USER_EMAIL || defaultUser.email,
    name: env.E2E_USER_NAME || defaultUser.name,
    password: env.E2E_USER_PASSWORD || defaultUser.password,
  };
}

function getBaseEnv() {
  const { host, port } = getServerAddress();
  return {
    ...process.env,
    NODE_ENV: 'CI',
    HOST: process.env.E2E_HOST || host,
    PORT: process.env.E2E_PORT || port,
    MONGO_URI: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/LibreChat-e2e',
    DOMAIN_CLIENT: process.env.E2E_DOMAIN_CLIENT || baseURL,
    DOMAIN_SERVER: process.env.E2E_DOMAIN_SERVER || baseURL,
    E2E_RUNTIME_ENV_PATH:
      process.env.E2E_RUNTIME_ENV_PATH ||
      path.resolve(rootPath, 'e2e/specs/.test-results/runtime-env.json'),
    E2E_USE_MEMORY_MONGO: process.env.E2E_USE_MEMORY_MONGO || 'auto',
    NO_INDEX: process.env.NO_INDEX || 'true',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'user_provided',
    CREDS_KEY: process.env.CREDS_KEY || randomHex(32),
    CREDS_IV: process.env.CREDS_IV || randomHex(16),
    JWT_SECRET: process.env.JWT_SECRET || randomHex(32),
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || randomHex(32),
    EMAIL_HOST: '',
    SEARCH: 'false',
    SESSION_EXPIRY: process.env.SESSION_EXPIRY || '3600000',
    ALLOW_REGISTRATION: 'true',
    REFRESH_TOKEN_EXPIRY: process.env.REFRESH_TOKEN_EXPIRY || '3600000',
    TITLE_CONVO: 'false',
    ...rateLimitOverrides,
  };
}

function neutralizeCredentialEnv(env) {
  for (const key of Object.keys(env)) {
    if (!preservedCredentialEnvKeys.has(key) && secretKeyPattern.test(key)) {
      env[key] = '';
    }
  }
}

function neutralizeDotenvSecrets(envFile, env) {
  if (!fs.existsSync(envFile)) {
    return;
  }
  const lines = fs.readFileSync(envFile, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (!preservedCredentialEnvKeys.has(key) && secretKeyPattern.test(key)) {
      env[key] = '';
    }
  }
}

function getEnv(profile) {
  const env = getBaseEnv();
  if (profile === 'mock') {
    neutralizeCredentialEnv(env);
    neutralizeDotenvSecrets(path.resolve(rootPath, '.env'), env);
    Object.assign(env, mockOverrides);
  }
  return env;
}

function formatDate(date) {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/[:T]/g, '-');
}

function writeRuntimeMockConfig() {
  const template = fs.readFileSync(configTemplatePath, 'utf8');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, template);
}

function parseArgs(argv) {
  const options = {
    profile: 'mock',
    output: path.resolve(rootPath, `e2e/recordings/recording-${formatDate(new Date())}.spec.ts`),
    storage: storageStatePath,
    url: appURL('c/new'),
    authOnly: false,
    saveOutput: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    const readValue = () => {
      if (arg.includes('=')) {
        return arg.slice(arg.indexOf('=') + 1);
      }
      index += 1;
      return next;
    };

    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('--profile')) {
      options.profile = readValue();
    } else if (arg.startsWith('--url')) {
      const value = readValue();
      options.url = /^https?:\/\//i.test(value) ? value : appURL(value);
    } else if (arg.startsWith('--output')) {
      options.output = path.resolve(rootPath, readValue());
    } else if (arg.startsWith('--storage')) {
      options.storage = path.resolve(rootPath, readValue());
    } else if (arg === '--no-output') {
      options.saveOutput = false;
    } else if (arg === '--auth-only') {
      options.authOnly = true;
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Usage: node e2e/setup/record.js [options]

Options:
  --profile mock|local     Server profile to record against. Defaults to mock.
  --url <url>              URL opened by Playwright codegen. Defaults to /c/new.
  --output <path>          Raw recording output path under the repo.
  --storage <path>         Auth storage state path. Defaults to e2e/storageState.json.
  --no-output              Let codegen show generated code without writing a file.
  --auth-only              Start servers, write storage state, then exit.

Examples:
  node e2e/setup/record.js
  node e2e/setup/record.js --profile=local --url=http://localhost:3080/c/new
`);
}

async function waitForURL(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.ok) {
        return true;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      clearTimeout(timeout);
    }
  }
  return false;
}

function spawnProcess(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: rootPath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`[${name}] exited with code ${code}`);
    }
  });

  return child;
}

async function stopProcess(child) {
  if (!child || child.exitCode != null) {
    return;
  }

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function register(page, user, timeout) {
  await page.getByRole('link', { name: 'Sign up' }).click({ timeout });
  await page.getByLabel('Full name').fill(user.name);
  await page.getByLabel('Email').fill(user.email);
  await page.getByTestId('password').fill(user.password);
  await page.getByTestId('confirm_password').fill(user.password);
  await page.getByLabel('Submit registration').click();
}

async function login(page, user) {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
}

async function writeStorageState(env, storagePath) {
  const { chromium } = require('@playwright/test');
  const user = getUser(env);
  const timeout = Number(env.E2E_AUTH_TIMEOUT || 15000);
  const conversationURL = appURL('c/new');
  const loginURL = appURL('login');
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.context().addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });

    await page.goto(baseURL, { timeout });
    try {
      await register(page, user, timeout);
      await page.waitForURL(conversationURL, { timeout });
    } catch {
      await page.goto(loginURL, { timeout });
      await login(page, user);
      await page.waitForURL(conversationURL, { timeout });
    }

    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    await page.context().storageState({ path: storagePath });
    console.log(`[record] Saved authenticated storage state to ${storagePath}`);
  } finally {
    await browser.close();
  }
}

function runCodegen(options, env) {
  const args = [
    'playwright',
    'codegen',
    '--target=playwright-test',
    '--test-id-attribute=data-testid',
    '--load-storage',
    options.storage,
  ];

  if (options.saveOutput) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    args.push('--output', options.output);
  }

  args.push(options.url);
  console.log(`[record] Opening Playwright codegen at ${options.url}`);
  if (options.saveOutput) {
    console.log(`[record] Raw recording will be written to ${options.output}`);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(npxBin, args, {
      cwd: rootPath,
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Playwright codegen exited with code ${code}`));
      }
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (!['mock', 'local'].includes(options.profile)) {
    throw new Error('--profile must be "mock" or "local"');
  }

  const env = getEnv(options.profile);
  const children = [];

  try {
    if (options.profile === 'mock') {
      writeRuntimeMockConfig();
    }

    if (await waitForURL(baseURL, 1000)) {
      if (options.profile === 'mock') {
        console.warn('[record] Reusing an existing app server; make sure it uses e2e mock config.');
      }
    } else {
      children.push(
        spawnProcess('app', 'node', [path.resolve(rootPath, 'e2e/setup/start-server.js')], env),
      );
      if (!(await waitForURL(baseURL, 120000))) {
        throw new Error(`LibreChat server did not become ready at ${baseURL}`);
      }
    }

    await writeStorageState(env, options.storage);
    if (options.authOnly) {
      return;
    }
    await runCodegen(options, env);
  } finally {
    for (const child of children.reverse()) {
      await stopProcess(child);
    }
  }
}

main().catch((error) => {
  console.error('[record] Failed:', error);
  process.exit(1);
});
