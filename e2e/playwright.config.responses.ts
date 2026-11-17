import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { defineConfig } from '@playwright/test';
import { configSchema, responsesProtocolSchema } from 'librechat-data-provider';
import mock from './playwright.config.mock';

if (process.env.E2E_REPLICAS && process.env.E2E_REPLICAS !== '1') {
  throw new Error('The Responses profile requires E2E_REPLICAS=1.');
}

const root = path.resolve(__dirname, '..');
const servers = (Array.isArray(mock.webServer) ? mock.webServer : []).filter(
  (server) =>
    server.command.endsWith('start-server.js') || server.command.endsWith('fake-label-server.js'),
);
const source = path.join(root, 'e2e/.generated/librechat.e2e.yaml');
const target = path.join(root, 'e2e/.generated/librechat.responses.yaml');
const fixture = configSchema.parse(yaml.load(fs.readFileSync(source, 'utf8')));
fs.writeFileSync(
  target,
  yaml.dump({
    ...fixture,
    endpoints: {
      ...fixture.endpoints,
      agents: {
        ...fixture.endpoints?.agents,
        responses: responsesProtocolSchema.parse({ compaction: { enabled: true } }),
      },
    },
  }),
);
export default defineConfig({
  ...mock,
  testDir: 'responses',
  testMatch: 'compact.spec.ts',
  outputDir: 'responses/.test-results',
  reporter: [['line']],
  timeout: 90000,
  webServer: servers.map((server) =>
    server.command.endsWith('start-server.js')
      ? { ...server, env: { ...server.env, CONFIG_PATH: target } }
      : server,
  ),
});
