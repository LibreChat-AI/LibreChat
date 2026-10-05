import path from 'node:path';
import fs from 'node:fs';
import { mediaFixtureConfig, mediaFixturePort } from './setup/media';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

const latencyHook = path.resolve(__dirname, 'benchmarks/mongoose-latency-hook.cjs');
const regressionHook = path.resolve(__dirname, 'lighthouse/regression.cjs');
const servers = (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).filter((server) =>
  server.command.endsWith('start-server.js'),
);
if (servers.length !== 1) {
  throw new Error('Lighthouse requires the isolated single-server harness (E2E_REPLICAS=1).');
}

const mediaServers = (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).filter(
  (server) => server.command.endsWith('fake-media-server.js'),
);
const configPath = path.resolve(__dirname, '.generated/librechat.lighthouse.yaml');
const config = fs
  .readFileSync(path.resolve(__dirname, 'lighthouse/librechat.yaml'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(
    '\nendpoints:\n',
    `\nendpoints:\n  allowedAddresses: ['127.0.0.1:${mediaFixturePort}']\n`,
  );
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(
  configPath,
  `${config}\ninterface:\n  media: {use: true, create: true}\ntransactions: {enabled: false}\nmedia: ${JSON.stringify(mediaFixtureConfig())}\n`,
);

export default defineConfig({
  ...mockConfig,
  testDir: 'lighthouse',
  outputDir: 'lighthouse/.test-results',
  timeout: 300_000,
  retries: 0,
  reporter: [['line']],
  webServer: [
    ...mediaServers,
    ...servers.map((server) => ({
      ...server,
      env: {
        ...server.env,
        CONFIG_PATH: configPath,
        ENDPOINTS: 'openAI',
        OPENAI_MODELS: 'gpt-4o-mini',
        ASSISTANTS_API_KEY: '',
        E2E_USE_MEMORY_MONGO: 'true',
        E2E_LATENCY_MONGO_DELAY_MS: '250',
        NODE_OPTIONS: [
          server.env.NODE_OPTIONS,
          `--require=${latencyHook}`,
          ...(process.env.LIGHTHOUSE_REGRESSION === 'serial-reads'
            ? [`--require=${regressionHook}`]
            : []),
        ].join(' '),
      },
    })),
  ],
});
