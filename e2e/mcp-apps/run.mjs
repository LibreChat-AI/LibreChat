#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertMCPAppsPhaseResults } from './results.mjs';

const baseUrl = new URL(process.env.E2E_BASE_URL || 'http://127.0.0.1:3080');
const sandboxHost = baseUrl.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
const sandboxUrl = new URL('/api/mcp/sandbox', baseUrl);
sandboxUrl.hostname = sandboxHost;
const runtimeSandboxUrl =
  process.env.E2E_MCP_SANDBOX_URL || process.env.VITE_MCP_SANDBOX_URL || sandboxUrl.href;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { MongoMemoryServer } = require('mongodb-memory-server');
const statePath = path.join(root, 'e2e/.generated/mcp-apps-state.json');

const env = {
  ...process.env,
  E2E_BASE_URL: baseUrl.origin,
  E2E_MCP_APPS: 'true',
  E2E_MCP_APPS_STATE_PATH: statePath,
  E2E_MCP_SANDBOX_URL: runtimeSandboxUrl,
  MCP_SANDBOX_FRAME_ANCESTORS: baseUrl.origin,
  JWT_SECRET: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || randomBytes(32).toString('hex'),
  CREDS_KEY: process.env.CREDS_KEY || randomBytes(32).toString('hex'),
  CREDS_IV: process.env.CREDS_IV || randomBytes(16).toString('hex'),
};

const command = (name) => (process.platform === 'win32' ? `${name}.cmd` : name);

function run(executable, args, overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command(executable), args, {
      cwd: root,
      env: { ...env, ...overrides },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${executable} exited with ${signal || code || 'an unknown status'}`));
    });
  });
}

const phases = [
  { name: 'true', policy: 'true', minimumPassed: 2 },
  { name: 'false', policy: 'false', minimumPassed: 1 },
  { name: 'omitted', policy: 'omitted', minimumPassed: 1 },
  {
    name: 'quota',
    policy: 'true',
    minimumPassed: 1,
    E2E_MCP_APP_RESOURCE_LIMIT: '2',
    E2E_MCP_APP_TOOL_CALL_LIMIT: '2',
  },
];

let mongo;
try {
  // Build like an official prebuilt image: the browser must receive its Sandbox URL at runtime.
  await run('npm', ['run', 'e2e:prepare'], { VITE_MCP_SANDBOX_URL: '' });
  mongo = await MongoMemoryServer.create({
    instance: { ip: '127.0.0.1', dbName: 'LibreChat-e2e' },
  });
  env.E2E_USE_MEMORY_MONGO = 'false';
  env.MONGO_URI = mongo.getUri('LibreChat-e2e');

  for (const phase of phases) {
    const resultsFile = path.join(root, `e2e/.generated/mcp-apps-result-${phase.name}.json`);
    fs.rmSync(resultsFile, { force: true });
    await run(
      'npx',
      [
        'playwright',
        'test',
        '--config=e2e/playwright.config.mcp-apps.ts',
        '--reporter=line,html,json',
      ],
      {
        E2E_MCP_APPS_PHASE: phase.name,
        E2E_MCP_APPS_POLICY: phase.policy,
        E2E_MCP_APP_RESOURCE_LIMIT: phase.E2E_MCP_APP_RESOURCE_LIMIT || '',
        E2E_MCP_APP_TOOL_CALL_LIMIT: phase.E2E_MCP_APP_TOOL_CALL_LIMIT || '',
        PLAYWRIGHT_HTML_OPEN: 'never',
        PLAYWRIGHT_HTML_OUTPUT_DIR: path.join(root, `e2e/playwright-report/mcp-apps-${phase.name}`),
        PLAYWRIGHT_JSON_OUTPUT_FILE: resultsFile,
      },
    );
    const passed = assertMCPAppsPhaseResults(
      JSON.parse(fs.readFileSync(resultsFile, 'utf8')),
      phase.name,
      phase.minimumPassed,
    );
    console.log(`MCP Apps ${phase.name}: ${passed} browser test(s) passed`);
  }
} finally {
  await mongo?.stop();
}
