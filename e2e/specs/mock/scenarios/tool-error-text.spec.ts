import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * A tool result lands in the conversation, so a failing tool may only hand the model text the
 * tool wrote for it. The probes load the real tools from `api/` and replace only the transport
 * (node-fetch, axios) so the upstream failure is deterministic and never leaves the machine.
 */

const apiRoot = resolve(repoRoot, 'api');
const SECRET = 'PRIVATE-PROVIDER-DETAIL';

function probe(source: string): Record<string, string> {
  const result = run('node', ['-e', source], { cwd: apiRoot });
  expect(result.status, result.output).toBe(0);
  const marker = result.stdout.lastIndexOf('RESULT');
  expect(marker, result.output).toBeGreaterThanOrEqual(0);
  return JSON.parse(result.stdout.slice(marker + 'RESULT'.length));
}

const OPEN_WEATHER_PROBE = `
process.env.OPENWEATHER_API_KEY = 'probe-api-key';
const fetchPath = require.resolve('node-fetch');
let respond;
require.cache[fetchPath] = {
  id: fetchPath,
  filename: fetchPath,
  loaded: true,
  exports: (url) => respond(url),
};
const OpenWeather = require('./app/clients/tools/structured/OpenWeather');
(async () => {
  const tool = new OpenWeather();
  const out = {};
  respond = (url) => Promise.reject(new Error('request to ' + url + ' failed, reason: ${SECRET}'));
  out.network = await tool._call({ action: 'current_forecast', lat: 1, lon: 2 });
  respond = () => Promise.resolve({ ok: false, status: 401, json: async () => ({ message: '${SECRET}' }) });
  out.unauthorized = await tool._call({ action: 'current_forecast', lat: 1, lon: 2 });
  respond = () => Promise.resolve({ ok: true, json: async () => [] });
  out.city = await tool._call({ action: 'current_forecast', city: 'Atlantis' });
  out.secretCity = await tool._call({ action: 'current_forecast', city: 'sk-proj-PRIVATEKEY123 owner@example.com' });
  out.date = await tool._call({ action: 'timestamp', lat: 1, lon: 2, date: '2020/03/04' });
  process.stdout.write('RESULT' + JSON.stringify(out));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;

const WOLFRAM_PROBE = `
process.env.WOLFRAM_APP_ID = 'probe-app-id';
const axios = require('axios');
const WolframAlphaAPI = require('./app/clients/tools/structured/Wolfram');
const httpError = (status) =>
  Object.assign(new Error('Request failed with status code ' + status), {
    response: { status, data: 'Wolfram|Alpha did not understand ${SECRET}' },
  });
(async () => {
  const tool = new WolframAlphaAPI({});
  const out = {};
  axios.get = () => Promise.reject(httpError(501));
  out.uninterpretable = await tool._call({ input: '${SECRET}' });
  axios.get = () => Promise.reject(httpError(503));
  out.unavailable = await tool._call({ input: 'integrate x' });
  axios.get = () => Promise.reject(new Error('connect ECONNREFUSED ${SECRET}'));
  out.network = await tool._call({ input: 'integrate x' });
  axios.get = () => Promise.resolve({ data: 'x^2/2' });
  out.ok = await tool._call({ input: 'integrate x' });
  process.stdout.write('RESULT' + JSON.stringify(out));
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
`;

test.describe('approved tool error text', () => {
  test.beforeEach(() => inOneProject());

  test('a failing OpenWeather call returns approved text and keeps its own input guidance @scenario:openweather-approved-error-text', () => {
    test.setTimeout(120_000);
    const out = probe(OPEN_WEATHER_PROBE);

    expect(out.network).toBe('Error: The tool request failed.');
    expect(out.unauthorized).toBe(
      'Error: OpenWeather rejected the configured credentials (status 401).',
    );
    expect(out.city).toBe('Error: Could not find coordinates for city: Atlantis');
    expect(out.date).toBe('Error: Invalid date format. Expected YYYY-MM-DD.');
    expect(out.secretCity).toMatch(/^Error: Could not find coordinates for city: /);
    expect(out.secretCity).not.toContain('PRIVATEKEY123');
    expect(out.secretCity).not.toContain('owner@example.com');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('probe-api-key');
  });

  test('a failing Wolfram|Alpha call returns approved text, not the provider body @scenario:wolfram-approved-error-text', () => {
    test.setTimeout(120_000);
    const out = probe(WOLFRAM_PROBE);

    expect(out.uninterpretable).toMatch(/^Error: Wolfram\|Alpha could not interpret the input\./);
    expect(out.unavailable).toBe(
      'Error: Wolfram|Alpha is unavailable; try again later (status 503).',
    );
    expect(out.network).toBe('Error: The tool request failed.');
    expect(out.ok).toBe('x^2/2');
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(JSON.stringify(out)).not.toContain('probe-app-id');
  });

  test('an Assistants required action whose tool throws submits approved text @scenario:assistant-tool-error-approved-text', () => {
    test.setTimeout(300_000);
    const result = run(
      'npx',
      [
        'jest',
        'server/services/__tests__/ToolService.spec.js',
        '-t',
        'approved tool error text|tool input error the tool wrote',
        '--maxWorkers=1',
      ],
      { cwd: apiRoot },
    );
    expect(result.status, result.output).toBe(0);
    /** Jest may color the summary, so match the count alone. */
    expect(result.output).toMatch(/(?<!\d)2 passed/);
  });
});
