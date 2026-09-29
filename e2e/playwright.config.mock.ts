import { defineConfig, devices } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { getLocalE2EEnv, getE2EBaseURL } from './setup/env';
import { managementAuth } from './setup/agent-management';

const rootPath = path.resolve(__dirname, '..');
const replicaCount = Number(process.env.E2E_REPLICAS || '1');
if (replicaCount !== 1 && replicaCount !== 2) {
  throw new Error(`E2E_REPLICAS must be 1 or 2, received ${process.env.E2E_REPLICAS}`);
}
const serverPath = path.resolve(
  rootPath,
  replicaCount === 2 ? 'e2e/setup/start-server-cluster.js' : 'e2e/setup/start-server.js',
);
const mcpHttpServerPath = path.resolve(rootPath, 'e2e/setup/fake-mcp-http-server.js');
const mcpOAuthServerPath = path.resolve(rootPath, 'e2e/setup/fake-mcp-oauth-server.js');
const dynamicMcpServerPath = path.resolve(rootPath, 'e2e/setup/fake-mcp-dynamic-network-server.js');
/** Must match the `e2e-http` server URL in e2e/config/librechat.e2e.yaml. */
const MCP_HTTP_PORT = process.env.E2E_MCP_HTTP_PORT || '8765';
/** Must match the protected OAuth MCP fixture in e2e/config/librechat.e2e.yaml. */
const MCP_OAUTH_PORT = process.env.E2E_MCP_OAUTH_PORT || '8767';
/** Must match the dynamic Streamable HTTP and SSE URLs in the e2e config template. */
const MCP_DYNAMIC_PORT = process.env.E2E_MCP_DYNAMIC_PORT || '8766';
const MCP_STATE_PATH =
  process.env.E2E_MCP_STATE_PATH ||
  path.resolve(rootPath, 'e2e/specs/.test-results/mcp-tool-state.json');
const labelServerPath = path.resolve(rootPath, 'e2e/setup/fake-label-server.js');
/** The template's custom-endpoint `baseURL`s hard-code 8889;
 *  `writeRuntimeMockConfig` substitutes any override into the generated copy. */
const LABEL_PORT = process.env.E2E_LABEL_PORT || '8889';
const codeServerPath = path.resolve(rootPath, 'e2e/setup/fake-code-server.js');
const ragServerPath = path.resolve(rootPath, 'e2e/setup/fake-rag-server.js');
/** Ports the backend reaches via LIBRECHAT_CODE_BASEURL / RAG_API_URL below.
 *  Kept clear of the MCP (8765/8766) and label (8889) fixtures. */
const CODE_API_PORT = process.env.E2E_CODE_API_PORT || '8790';
const RAG_API_PORT = process.env.E2E_RAG_API_PORT || '8791';
const fakeModelHookPath = path.resolve(rootPath, 'e2e/setup/fake-model.js');
/** Model-fixture record mode: the run hook taps the REAL provider stream into a
 *  replayable fixture instead of overriding the model (e2e/setup/model-replay.js). */
const modelFixtureRecording = process.env.E2E_MODEL_FIXTURES === 'record';
const recordModelHookPath = path.resolve(rootPath, 'e2e/setup/record-model.js');
const recordProviderBaseURL =
  process.env.E2E_RECORD_PROVIDER_BASE_URL || 'https://api.deepseek.com/v1';
const recordProviderModel = process.env.E2E_RECORD_PROVIDER_MODEL || 'deepseek-chat';
if (modelFixtureRecording && !process.env.E2E_RECORD_PROVIDER_API_KEY) {
  throw new Error('E2E_MODEL_FIXTURES=record requires E2E_RECORD_PROVIDER_API_KEY');
}
/**
 * Each fixture belongs to exactly one spec, and a spec records only its own.
 * Accepting an arbitrary name would leave a second fixture beside the
 * committed one carrying the same prompts, and the server-side ambiguity
 * check would then refuse to bind either — a successful recording run would
 * disable the keyless lane.
 */
const RECORDABLE_FIXTURES = ['deepseek-two-turn', 'deepseek-tool-call'];
if (modelFixtureRecording && !process.env.E2E_MODEL_FIXTURE_NAME) {
  throw new Error('E2E_MODEL_FIXTURES=record requires E2E_MODEL_FIXTURE_NAME');
}
if (
  modelFixtureRecording &&
  !RECORDABLE_FIXTURES.includes(process.env.E2E_MODEL_FIXTURE_NAME ?? '')
) {
  throw new Error(
    `E2E_MODEL_FIXTURE_NAME must be one of ${RECORDABLE_FIXTURES.join(', ')}; ` +
      `received ${process.env.E2E_MODEL_FIXTURE_NAME}`,
  );
}
/**
 * Playwright documents `-c` as an alias for `--config`, so both spellings are
 * parsed — recognising only the long form would let the short one slip past.
 *
 * Derived configs (`playwright.config.redis.ts`, `.mermaid.ts`) spread this
 * config and then replace `testMatch`, discarding the record-mode restriction
 * below — their specs would reach the paid provider and rewrite the selected
 * fixture. The restriction cannot be enforced through a value a consumer can
 * overwrite, so record mode refuses any config but this one.
 */
if (modelFixtureRecording) {
  /** Only the process that parsed the CLI carries `--config`; Playwright
   *  workers do not, and must not be judged on an argument they never saw. */
  const configFlagIndex = process.argv.findIndex(
    (arg) =>
      arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg.startsWith('-c='),
  );
  const configFlag = configFlagIndex === -1 ? undefined : process.argv[configFlagIndex];
  let configPath: string | undefined;
  if (configFlag?.includes('=')) {
    configPath = configFlag.slice(configFlag.indexOf('=') + 1);
  } else if (configFlag) {
    configPath = process.argv[configFlagIndex + 1];
  }
  if (configPath && !/playwright\.config\.mock\.ts$/.test(configPath)) {
    throw new Error(
      `E2E_MODEL_FIXTURES=record only runs under playwright.config.mock.ts, not ${configPath}; ` +
        'derived configs replace testMatch and would send their specs to the real provider',
    );
  }
}
const assistantsServerPath = path.resolve(rootPath, 'e2e/setup/fake-assistants-server.js');
const ASSISTANTS_PORT = process.env.E2E_ASSISTANTS_PORT || '8890';
const configTemplatePath = path.resolve(rootPath, 'e2e/config/librechat.e2e.yaml');
const configPath = path.resolve(rootPath, 'e2e/.generated/librechat.e2e.yaml');
const reportPath = path.resolve(rootPath, 'e2e/playwright-report');
const deploymentSkillsPath = path.resolve(rootPath, 'e2e/fixtures/deployment-skills');
const enableDynamicMcp = process.env.E2E_MCP_LIST_CHANGED === 'true';

const baseURL = getE2EBaseURL();
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

const vanillaOverrides = {
  TENANT_ISOLATION_STRICT: 'false',
  TRUST_TENANT_HEADER: 'true',
  OPENAI_API_KEY: 'user_provided',
  OPENID_CLIENT_ID: '',
  OPENID_ISSUER: '',
  OPENID_AUTO_REDIRECT: 'false',
  ALLOW_SOCIAL_LOGIN: 'false',
  ALLOW_SOCIAL_REGISTRATION: 'false',
  ALLOW_SHARED_LINKS_PUBLIC: 'true',
  STREAM_KEEP_COMPLETED_JOBS: 'true',
  FORK_IP_MAX: '100',
  FORK_USER_MAX: '100',
  /** A local `.env` may enable balance enforcement, which `neutralizeCredentialEnv`
   *  does not blank (not credential-shaped); the fresh e2e user has no balance
   *  record, so every streaming spec would be refused with a token_balance
   *  violation before the mock model runs. */
  CHECK_BALANCE: 'false',
};

const externalCodeBaseUrl = process.env.E2E_CODE_BASEURL?.trim();
const codeApiKeyEnv: Record<string, string> = {};
if (!externalCodeBaseUrl) {
  codeApiKeyEnv.LIBRECHAT_CODE_API_KEY = 'e2e-code-key';
} else if (process.env.E2E_CODE_API_KEY) {
  codeApiKeyEnv.LIBRECHAT_CODE_API_KEY = process.env.E2E_CODE_API_KEY;
}

const baseEnv = {
  ...getLocalE2EEnv(),
  CONFIG_PATH: configPath,
  DEPLOYMENT_SKILLS_DIR: deploymentSkillsPath,
  /** Loaded in-process by `@librechat/api`'s `createRun` to swap in a fake model —
   *  or, in model-fixture record mode, to tap the real provider stream. */
  LIBRECHAT_TEST_RUN_HOOK: modelFixtureRecording ? recordModelHookPath : fakeModelHookPath,
  ...(modelFixtureRecording
    ? {
        E2E_MODEL_FIXTURE_NAME: process.env.E2E_MODEL_FIXTURE_NAME ?? '',
        E2E_RECORD_PROVIDER_API_KEY: process.env.E2E_RECORD_PROVIDER_API_KEY ?? '',
      }
    : {}),
  ...(enableDynamicMcp ? { E2E_MCP_LIST_CHANGED: 'true', E2E_MCP_STATE_PATH: MCP_STATE_PATH } : {}),
  /** The Assistants runtime uses the OpenAI SDK directly, outside the agents run hook. */
  ASSISTANTS_API_KEY: 'e2e-mock-assistants-key',
  ASSISTANTS_BASE_URL: `http://127.0.0.1:${ASSISTANTS_PORT}/v1`,
  ASSISTANTS_MODELS: 'gpt-4o-mini',
  ...(process.env.E2E_CODE_BRIDGE_ADMIN_TOKEN
    ? { E2E_CODE_BRIDGE_ADMIN_TOKEN: process.env.E2E_CODE_BRIDGE_ADMIN_TOKEN }
    : {}),
  /** Point code-env + RAG provisioning at the local fakes started below. */
  LIBRECHAT_CODE_BASEURL: externalCodeBaseUrl || `http://127.0.0.1:${CODE_API_PORT}/v1`,
  ...(externalCodeBaseUrl ? { LIBRECHAT_CODE_BASEURL_STATEFUL: externalCodeBaseUrl } : {}),
  ...codeApiKeyEnv,
  RAG_API_URL: `http://127.0.0.1:${RAG_API_PORT}`,
  ...vanillaOverrides,
};

const SECRET_KEY_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS|CLIENT_ID|_KEY)$/i;
const preservedCredentialEnvKeys = new Set([
  ...Object.keys(baseEnv),
  'E2E_USER_PASSWORD',
  'E2E_USER_B_PASSWORD',
]);

/**
 * The custom endpoints in the template point their `baseURL` at the local fake
 * label server; the fake model injected via `LIBRECHAT_TEST_RUN_HOOK` overrides
 * the GRAPH before any request is made, so no real provider is contacted.
 *
 * Activity labels are the one exception: `run.generateActivityLabel()` bypasses
 * the graph override and calls the endpoint's resolved client options, so that
 * request does go out over HTTP — to `fake-label-server.js` on 127.0.0.1.
 */
function writeRuntimeMockConfig() {
  const template = fs.readFileSync(configTemplatePath, 'utf8');
  let config =
    process.env.E2E_MODEL_SPECS_ENFORCE === 'true'
      ? template.replace('\n  enforce: false\n', '\n  enforce: true\n')
      : template;
  config = config.replace(
    '  agents:\n',
    `  agents:\n    managementApi: ${JSON.stringify({ auth: managementAuth })}\n`,
  );
  const dynamicMcpConfig = enableDynamicMcp
    ? {
        allowedDomain: '- http://127.0.0.1:8766',
        stdioEnv: [
          'env:',
          '      E2E_MCP_LIST_CHANGED: "true"',
          `      E2E_MCP_STATE_PATH: ${JSON.stringify(MCP_STATE_PATH)}`,
        ].join('\n'),
        networkServers: [
          'e2e-streamable:',
          '    type: streamable-http',
          '    url: http://127.0.0.1:8766/mcp',
          '    title: E2E Streamable HTTP',
          '    description: Dynamic real-SDK Streamable HTTP fixture for mock end-to-end tests.',
          '    timeout: 30000',
          '  e2e-sse:',
          '    type: sse',
          '    url: http://127.0.0.1:8766/sse',
          '    title: E2E SSE',
          '    description: Dynamic real-SDK legacy SSE fixture for mock end-to-end tests.',
          '    timeout: 30000',
        ].join('\n'),
      }
    : { allowedDomain: '', stdioEnv: '', networkServers: '' };
  const recordProviderBlock = modelFixtureRecording
    ? [
        `- name: 'Replay Record Provider'`,
        `  apiKey: '\${E2E_RECORD_PROVIDER_API_KEY}'`,
        `  baseURL: '${recordProviderBaseURL}'`,
        '  models:',
        '    default:',
        `      - '${recordProviderModel}'`,
        '    fetch: false',
        '  titleConvo: false',
        `  modelDisplayLabel: 'Replay Record Provider'`,
      ].join('\n    ')
    : '# __E2E_MODEL_RECORD_PROVIDER__';
  config = config
    .replace('# __E2E_MODEL_RECORD_PROVIDER__', recordProviderBlock)
    .replace(
      '# __E2E_MODEL_RECORD_ADDED_ENDPOINT__',
      modelFixtureRecording
        ? `- 'Replay Record Provider'`
        : '# __E2E_MODEL_RECORD_ADDED_ENDPOINT__',
    )
    .replace('# __E2E_DYNAMIC_MCP_ALLOWED_DOMAIN__', dynamicMcpConfig.allowedDomain)
    .replace('# __E2E_DYNAMIC_MCP_STDIO_ENV__', dynamicMcpConfig.stdioEnv)
    .replace('# __E2E_DYNAMIC_MCP_NETWORK_SERVERS__', dynamicMcpConfig.networkServers);
  const codeBridgeURL = process.env.E2E_CODE_BRIDGE_URL;
  const codeBridgePairing = process.env.E2E_CODE_BRIDGE_ADMIN_TOKEN
    ? [
        '      owner: deployment',
        '      pairing:',
        '        workerId: e2e-vm',
        '        tokenEnv: E2E_CODE_BRIDGE_ADMIN_TOKEN',
      ]
    : [];
  config = config.replace(
    '# __E2E_CODE_BRIDGE_CONFIG__',
    codeBridgeURL
      ? [
          '  - stateful_code_sessions',
          'statefulCodeSessions:',
          '  allowedEnvironments: ["conversation"]',
          '  environments:',
          '    - id: e2e-vm',
          '      name: E2E attached VM',
          '      type: attached',
          `      baseURL: ${JSON.stringify(codeBridgeURL)}`,
          '      default: true',
          '      configSchema:',
          '        permissions:',
          '          fileWrite:',
          '            allowed: [allow, ask, deny]',
          '            default: ask',
          '          commandExecution:',
          '            allowed: [ask, deny]',
          '            default: ask',
          ...codeBridgePairing,
        ].join('\n    ')
      : '# __E2E_CODE_BRIDGE_CONFIG__',
  );
  /** Keep the generated config in lockstep with the overridable label-server
   *  port: the template hard-codes 8889, so an `E2E_LABEL_PORT` override that
   *  moved only the server and its health check would report ready while
   *  every activity-label request went to the wrong port. */
  if (LABEL_PORT !== '8889') {
    config = config.split('127.0.0.1:8889').join(`127.0.0.1:${LABEL_PORT}`);
  }
  if (enableDynamicMcp && MCP_DYNAMIC_PORT !== '8766') {
    config = config.split('127.0.0.1:8766').join(`127.0.0.1:${MCP_DYNAMIC_PORT}`);
  }
  if (MCP_OAUTH_PORT !== '8767') {
    config = config.split('127.0.0.1:8767').join(`127.0.0.1:${MCP_OAUTH_PORT}`);
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, config);
  if (enableDynamicMcp) {
    fs.mkdirSync(path.dirname(MCP_STATE_PATH), { recursive: true });
    fs.writeFileSync(MCP_STATE_PATH, `${JSON.stringify({ revision: 0, tool: null })}\n`);
  }
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

writeRuntimeMockConfig();
neutralizeCredentialEnv(process.env, preservedCredentialEnvKeys);
Object.assign(process.env, baseEnv);
neutralizeDotenvSecrets(path.resolve(rootPath, '.env'), preservedCredentialEnvKeys);

export default defineConfig({
  globalSetup: require.resolve('./setup/global-setup'),
  globalTeardown: require.resolve('./setup/global-teardown.mock'),
  testDir: 'specs/mock/',
  /** Record mode swaps the fake model for a real provider, so it must never
   * run the whole mock suite: every spec's prompts would reach the paid
   * endpoint, and each fresh conversation would truncate and rewrite the one
   * selected fixture, leaving whichever scenario ran last. Without this an
   * unfiltered entry point (`npm run e2e:mock`) does exactly that. */
  ...(modelFixtureRecording ? { testMatch: /model-replay[a-z-]*\.spec\.ts$/ } : {}),
  outputDir: 'specs/.test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [['html', { outputFolder: reportPath, open: 'never' }], ['line']]
    : [['html', { outputFolder: reportPath }], ['list']],
  use: {
    baseURL,
    video: 'on-first-retry',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    headless: true,
    storageState: path.resolve(process.cwd(), 'e2e/storageState.json'),
    screenshot: 'only-on-failure',
  },
  expect: {
    timeout: 10000,
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
      // URL-based MCP fixture for the allowlist-override spec (its health route is GET /).
      command: `node ${mcpHttpServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_MCP_HTTP_PORT: MCP_HTTP_PORT },
      url: `http://127.0.0.1:${MCP_HTTP_PORT}/`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Protected resource whose OAuth flow intentionally remains pending across navigation.
      command: `node ${mcpOAuthServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_MCP_OAUTH_PORT: MCP_OAUTH_PORT },
      url: `http://127.0.0.1:${MCP_OAUTH_PORT}/`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    ...(enableDynamicMcp
      ? [
          {
            // One real SDK server exposes both current HTTP and legacy SSE transports.
            command: `node ${dynamicMcpServerPath}`,
            cwd: rootPath,
            env: {
              ...process.env,
              E2E_MCP_DYNAMIC_PORT: MCP_DYNAMIC_PORT,
              E2E_MCP_STATE_PATH: MCP_STATE_PATH,
            },
            url: `http://127.0.0.1:${MCP_DYNAMIC_PORT}/`,
            stdout: 'pipe' as const,
            timeout: 60_000,
            reuseExistingServer: false,
          },
        ]
      : []),
    {
      // Serves the activity-label model call (the custom endpoints' baseURL).
      command: `node ${labelServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_LABEL_PORT: LABEL_PORT },
      url: `http://127.0.0.1:${LABEL_PORT}/`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Stateful provider-boundary fake for Assistant CRUD and streamed runs.
      command: `node ${assistantsServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_ASSISTANTS_PORT: ASSISTANTS_PORT },
      url: `http://127.0.0.1:${ASSISTANTS_PORT}/`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Fake code-execution API for file-provisioning specs (LIBRECHAT_CODE_BASEURL).
      command: `node ${codeServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_CODE_API_PORT: CODE_API_PORT },
      url: `http://127.0.0.1:${CODE_API_PORT}/health`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Fake RAG (vector DB) API for file-provisioning specs (RAG_API_URL).
      command: `node ${ragServerPath}`,
      cwd: rootPath,
      env: { ...process.env, E2E_RAG_API_PORT: RAG_API_PORT },
      url: `http://127.0.0.1:${RAG_API_PORT}/health`,
      stdout: 'pipe',
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      // Start one LibreChat process, or a two-process topology behind a test-only proxy, after the
      // network fixtures so inspection and persistent connections agree.
      command: `node ${serverPath}`,
      cwd: rootPath,
      // Only the one-replica harness may assert the scheduler's single-process topology.
      // The two-replica MCP suite must leave scheduled writes disabled.
      env: {
        ...process.env,
        ...(replicaCount === 1 ? { SCHEDULES_SINGLE_PROCESS: 'true' } : {}),
      },
      url: baseURL,
      stdout: 'pipe',
      ignoreHTTPSErrors: true,
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
