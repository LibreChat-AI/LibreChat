import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { FiltersConfig } from 'librechat-data-provider';
import { loginAdmin, restoreRuntimeFilters, setRuntimeFilters } from '../content-filters.helpers';

const CALL_ID = 'call_tool_output_probe';
const TOOL_NAME = 'probe_tool';

type Remote = { token: string; apiKey: string; cleanup: () => Promise<void> };

/** An agent on the mock provider plus an API key the Responses endpoint accepts. */
async function createRemoteAgent(
  request: APIRequestContext,
): Promise<Remote & { agentId: string }> {
  const token = await loginAdmin(request);
  const headers = { Authorization: `Bearer ${token}` };
  const agent = await request.post('/api/agents', {
    headers,
    data: {
      name: `Tool output ${randomUUID().slice(0, 8)}`,
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      model_parameters: {},
      tools: [],
    },
  });
  expect(agent.status()).toBe(201);
  const agentId = ((await agent.json()) as { id: string }).id;
  const created = await request.post('/api/api-keys', { headers, data: { name: 'tool output' } });
  expect(created.status()).toBe(201);
  const key = (await created.json()) as { id: string; key: string };
  return {
    token,
    agentId,
    apiKey: key.key,
    cleanup: async () => {
      await request.delete(`/api/api-keys/${key.id}`, { headers, failOnStatusCode: false });
      await request.delete(`/api/agents/${agentId}`, { headers, failOnStatusCode: false });
    },
  };
}

/** A replayed tool exchange whose result is `output`, as an Open Responses client sends it. */
function toolExchange(agentId: string, output: unknown) {
  return {
    model: agentId,
    stream: false,
    store: false,
    tools: [
      {
        type: 'function',
        name: TOOL_NAME,
        description: 'Compatibility test only',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
    input: [
      { type: 'function_call', id: 'fc_probe', call_id: CALL_ID, name: TOOL_NAME, arguments: '{}' },
      { type: 'function_call_output', call_id: CALL_ID, output },
    ],
  };
}

async function send(
  request: APIRequestContext,
  remote: Remote & { agentId: string },
  output: unknown,
) {
  return request.post('/api/agents/v1/responses', {
    headers: { Authorization: `Bearer ${remote.apiKey}` },
    data: toolExchange(remote.agentId, output),
    timeout: 60_000,
  });
}

async function expectCompleted(response: Awaited<ReturnType<typeof send>>) {
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { status?: string; output?: unknown[] };
  expect(body.status).toBe('completed');
  expect(body.output?.length).toBeGreaterThan(0);
}

test.describe('Responses API function_call_output', () => {
  test('a tool result sent as a content array continues the exchange @scenario:responses-content-array-tool-output-continues', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const remote = await createRemoteAgent(request);
    try {
      await test.step('the one-part text array from the report', async () => {
        await expectCompleted(
          await send(request, remote, [{ type: 'input_text', text: 'Compatibility probe only.' }]),
        );
      });
      await test.step('text, image and file parts together', async () => {
        await expectCompleted(
          await send(request, remote, [
            { type: 'input_text', text: 'Chart attached.' },
            { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' },
            { type: 'input_file', filename: 'report.pdf' },
          ]),
        );
      });
    } finally {
      await remote.cleanup();
      await request.dispose();
    }
  });

  test('a tool result sent as a plain string still continues the exchange @scenario:responses-string-tool-output-continues', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const remote = await createRemoteAgent(request);
    try {
      await expectCompleted(await send(request, remote, 'plain result'));
    } finally {
      await remote.cleanup();
      await request.dispose();
    }
  });

  test('a malformed content part is refused with a 400 naming the part @scenario:responses-malformed-tool-output-part-refused', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const remote = await createRemoteAgent(request);
    try {
      for (const [output, message] of [
        [[{ type: 'input_image' }], 'output[0] input_image requires a non-empty image_url'],
        [
          [{ type: 'input_text', text: 'ok' }, { type: 'input_video' }],
          'output[1] has unsupported type',
        ],
        [{ text: 'not an array' }, 'requires output as a string or an array'],
      ] as const) {
        const response = await send(request, remote, output);
        expect(response.status()).toBe(400);
        const body = (await response.json()) as { error?: { message?: string } };
        expect(body.error?.message).toContain(`function_call_output ${CALL_ID} ${message}`);
      }
    } finally {
      await remote.cleanup();
      await request.dispose();
    }
  });

  test('an image URL or file name in a tool result is held to the file policy @scenario:responses-tool-output-media-hits-file-policy', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const remote = await createRemoteAgent(request);
    const suffix = randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();
    const blockedHost = `blocked-${suffix.toLowerCase()}.example.com`;
    const blockedName = `E2E-TOOL-FILE-${suffix}.pdf`;
    const filters = {
      files: {
        pii: {
          fields: ['uri', 'name'],
          starterPatterns: [],
          customPatterns: [
            { id: `e2e-tool-uri-${suffix}`, label: 'E2E blocked host', regex: blockedHost },
            { id: `e2e-tool-name-${suffix}`, label: 'E2E blocked file', regex: `^${blockedName}$` },
          ],
        },
      },
    } as FiltersConfig;
    let filtersAttempted = false;
    try {
      filtersAttempted = true;
      await setRuntimeFilters(request, remote.token, filters);

      for (const [label, part, marker] of [
        [
          'image URL',
          { type: 'input_image', image_url: `https://${blockedHost}/chart.png` },
          blockedHost,
        ],
        ['file name', { type: 'input_file', filename: blockedName }, blockedName],
      ] as const) {
        await test.step(label, async () => {
          const response = await send(request, remote, [part]);
          const text = await response.text();
          expect(response.status(), text).toBe(400);
          expect(JSON.parse(text)).toEqual({
            error: expect.objectContaining({ code: 'content_filter_block' }),
          });
          expect(text).not.toContain(marker);
        });
      }

      await test.step('a tool result outside the policy still continues', async () => {
        await expectCompleted(
          await send(request, remote, [
            { type: 'input_image', image_url: 'https://allowed.example.com/chart.png' },
          ]),
        );
      });
    } finally {
      if (filtersAttempted) {
        await restoreRuntimeFilters(request, remote.token);
      }
      await remote.cleanup();
      await request.dispose();
    }
  });
});
