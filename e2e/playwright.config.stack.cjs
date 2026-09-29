const path = require('node:path');
const { defineConfig } = require('@playwright/test');
const mockConfig = require('./playwright.config.mock').default;

const evidence = process.env.PILOT_EVIDENCE;
if (!evidence || !['memory', 'redis'].includes(process.env.E2E_STREAM_STORE)) {
  throw new Error('Run this config through scripts/agent-stack/run.mjs');
}
for (const endpoint of [process.env.PILOT_OTLP, process.env.PILOT_AGENTS_OTLP]) {
  const url = new URL(endpoint);
  if (url.hostname !== 'collector' || url.protocol !== 'http:' || url.username || url.password) {
    throw new Error('The pilot accepts only credential-free isolated-network OTLP endpoints');
  }
}
const telemetry = {
  OTEL_TRACING_ENABLED: 'true',
  OTEL_LOGS_ENABLED: 'true',
  OTEL_IOREDIS_TRACING_ENABLED: 'true',
  OTEL_SDK_DISABLED: 'false',
  OTEL_SERVICE_NAME: 'librechat-agent-stack-pilot',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.PILOT_OTLP,
  OTEL_EXPORTER_OTLP_HEADERS: '',
  OTEL_TRACES_EXPORTER: 'otlp',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_METRICS_EXPORTER: 'none',
  OTEL_BSP_SCHEDULE_DELAY: '500',
  OTEL_BLRP_SCHEDULE_DELAY: '500',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-local-pilot',
  LANGFUSE_SECRET_KEY: 'sk-lf-local-pilot',
  LANGFUSE_BASEURL: process.env.PILOT_AGENTS_OTLP,
  LANGFUSE_BASE_URL: process.env.PILOT_AGENTS_OTLP,
};
module.exports = defineConfig({
  ...mockConfig,
  globalTeardown: require.resolve('./setup/teardown.stack.cjs'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: path.join(evidence, 'browser-results.json') }]],
  outputDir: path.join(evidence, 'browser'),
  use: { ...mockConfig.use, trace: 'retain-on-failure', video: 'off' },
  expect: { ...mockConfig.expect, timeout: 20000 },
  webServer: mockConfig.webServer.map((server) => ({
    ...server,
    command: server.command.includes('e2e/setup/start-server.js')
      ? server.command.replace(
          'node ',
          `node --require ${path.resolve(__dirname, '../api/server/telemetry.js')} `,
        )
      : server.command,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
    env: { ...server.env, ...telemetry },
  })),
});
