import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const playwrightVersion = require('@playwright/test/package.json').version;
assert.equal(
  playwrightVersion,
  '1.62.1',
  'Update the pinned browser image for this Playwright version',
);
fs.writeFileSync(
  path.join(process.env.PILOT_EVIDENCE, 'runtime.json'),
  JSON.stringify({ node: process.version, playwright: playwrightVersion }),
);
import { spawnSync } from 'node:child_process';
async function privacyProbe(endpoint) {
  const attrs = [
    { key: 'authorization', value: { stringValue: 'PILOT_PRIVATE_HEADER' } },
    { key: 'db.statement', value: { stringValue: 'PILOT_PRIVATE_QUERY' } },
  ];
  const traceId = '11111111111111111111111111111111';
  const startTimeUnixNano = `${Date.now()}000000`;
  const response = await fetch(`${endpoint}/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: attrs },
          scopeSpans: [
            {
              scope: { name: 'pilot.privacy.probe' },
              spans: [
                {
                  traceId,
                  spanId: '1111111111111111',
                  name: 'PILOT_PRIVATE_PROMPT',
                  kind: 1,
                  startTimeUnixNano,
                  endTimeUnixNano: startTimeUnixNano,
                  attributes: attrs,
                  status: { code: 2, message: 'PILOT_PRIVATE_ERROR' },
                  events: [
                    {
                      timeUnixNano: startTimeUnixNano,
                      name: 'PILOT_PRIVATE_EVENT',
                      attributes: attrs,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert(response.ok, 'Collector must accept privacy test spans');
  const log = await fetch(`${endpoint}/v1/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      resourceLogs: [
        {
          resource: { attributes: attrs },
          scopeLogs: [
            {
              scope: { name: 'pilot.privacy.probe' },
              logRecords: [
                {
                  timeUnixNano: startTimeUnixNano,
                  severityNumber: 9,
                  body: { stringValue: 'PILOT_PRIVATE_LOG' },
                  attributes: attrs,
                },
              ],
            },
          ],
        },
      ],
    }),
  });
  assert(log.ok, 'Collector must accept privacy test logs');
}

await privacyProbe(process.env.PILOT_OTLP);
const test = spawnSync(
  '/work/node_modules/.bin/playwright',
  [
    'test',
    '--config=e2e/playwright.config.stack.cjs',
    '--grep',
    process.env.E2E_FOCUSED_HANDOFF === 'true'
      ? 'commits a permanent handoff and routes the next user message to its destination'
      : 'renders and persists every LLM chunk|routes to the chosen agent, renders passthrough|rehydrates a paused approval and its completed result|executes simultaneous handoffs' +
        (process.env.E2E_CONVERSATION_HANDOFFS === 'true'
          ? '|commits a permanent handoff and routes the next user message to its destination'
          : ''),
  ],
  { stdio: 'inherit', env: process.env, timeout: 170000 },
);
process.exitCode = test.status ?? 1;
