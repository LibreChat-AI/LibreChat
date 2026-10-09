import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { getLocalE2EEnv, getE2EBaseURL } from './setup/env';

/**
 * LOCAL-ONLY real-provider config: boots the same self-contained harness as
 * the mock config (in-memory Mongo, seeded user, generated secrets) but runs
 * real Anthropic calls — no fake-model hook. The API key is consumed from the
 * invoking environment only; every other credential-like variable is blanked
 * before the server boots, and nothing secret is written to disk.
 *
 * Run with:
 * ANTHROPIC_API_KEY=... E2E_BASE_URL=http://localhost:3334 \
 *   npm run e2e:prepare && npx playwright test --config=e2e/playwright.config.real.ts
 */
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error(
    '[e2e:real] ANTHROPIC_API_KEY is required in the environment for the real-provider config.',
  );
}

const rootPath = path.resolve(__dirname, '..');
const serverPath = path.resolve(rootPath, 'e2e/setup/start-server.js');
const configTemplatePath = path.resolve(rootPath, 'e2e/config/librechat.real.yaml');
const configPath = path.resolve(rootPath, 'e2e/.generated/librechat.real.yaml');
const reportPath = path.resolve(rootPath, 'e2e/playwright-report');

const baseURL = getE2EBaseURL();
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

const realModel = process.env.E2E_REAL_ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

const baseEnv = {
  ...getLocalE2EEnv(),
  CONFIG_PATH: configPath,
  TENANT_ISOLATION_STRICT: 'false',
  OPENAI_API_KEY: 'user_provided',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  /** Single deterministic model so the selector flow never drifts */
  ANTHROPIC_MODELS: realModel,
  OPENID_CLIENT_ID: '',
  OPENID_ISSUER: '',
  OPENID_AUTO_REDIRECT: 'false',
  ALLOW_SOCIAL_LOGIN: 'false',
  ALLOW_SOCIAL_REGISTRATION: 'false',
  STREAM_KEEP_COMPLETED_JOBS: 'true',
  /**
   * Optional Langfuse passthrough for tracing a real run. Credentials are read
   * from the invoking environment only (they match the credential-neutralizer
   * pattern below, so they must be preserved explicitly) and are never written
   * to the generated config. Absent values leave tracing disabled.
   */
  ...(process.env.LANGFUSE_PUBLIC_KEY
    ? {
        LANGFUSE_PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
        LANGFUSE_SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
        ...(process.env.LANGFUSE_BASE_URL
          ? { LANGFUSE_BASE_URL: process.env.LANGFUSE_BASE_URL }
          : {}),
      }
    : {}),
};

const SECRET_KEY_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS|CLIENT_ID|_KEY)$/i;
const preservedCredentialEnvKeys = new Set([
  ...Object.keys(baseEnv),
  'E2E_USER_PASSWORD',
  'E2E_USER_B_PASSWORD',
]);

function writeRuntimeRealConfig() {
  const template = fs.readFileSync(configTemplatePath, 'utf8');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, template);
}

function neutralizeCredentialEnv(env: NodeJS.ProcessEnv, keep: Set<string>) {
  for (const key of Object.keys(env)) {
    if (!keep.has(key) && SECRET_KEY_PATTERN.test(key)) {
      env[key] = '';
    }
  }
}

/** Blank any credential-like vars from a local `.env` so they never reach the test server. */
function neutralizeDotenvSecrets(envFile: string, keep: Set<string>) {
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
    if (keep.has(key)) {
      continue;
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      process.env[key] = '';
    }
  }
}

writeRuntimeRealConfig();
neutralizeCredentialEnv(process.env, preservedCredentialEnvKeys);
Object.assign(process.env, baseEnv);
neutralizeDotenvSecrets(path.resolve(rootPath, '.env'), preservedCredentialEnvKeys);

export default defineConfig({
  globalSetup: require.resolve('./setup/global-setup'),
  globalTeardown: require.resolve('./setup/global-teardown.mock'),
  testDir: 'specs/real/',
  outputDir: 'specs/.test-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: [['html', { outputFolder: reportPath, open: 'never' }], ['list']],
  use: {
    baseURL,
    video: 'off',
    trace: 'off',
    ignoreHTTPSErrors: true,
    headless: true,
    storageState: path.resolve(process.cwd(), 'e2e/storageState.json'),
    screenshot: 'only-on-failure',
  },
  expect: {
    timeout: 15000,
  },
  projects: [
    {
      name: chromiumChannel ?? 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumChannel ? { channel: chromiumChannel } : {}),
      },
    },
  ],
  webServer: [
    {
      command: `node ${serverPath}`,
      cwd: rootPath,
      url: baseURL,
      stdout: 'pipe',
      ignoreHTTPSErrors: true,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
