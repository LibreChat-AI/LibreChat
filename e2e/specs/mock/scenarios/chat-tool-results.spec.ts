import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loginAdmin, restoreRuntimeFilters, setRuntimeFilters } from '../content-filters.helpers';

type Result = { call_id: string; name: string; arguments: string; output: string; index?: number };

async function remote(request: APIRequestContext) {
  const token = await loginAdmin(request);
  const headers = { Authorization: `Bearer ${token}` };
  const profile = await request.get('/api/user', { headers });
  expect(profile.status()).toBe(200);
  const user = await profile.json();
  const userId = user.id ?? user._id;
  const origin = `http://127.0.0.1:${process.env.E2E_MCP_HTTP_PORT || '8765'}`;
  const overridePath = `/api/admin/config/user/${userId}`;
  const created: { agentId?: string; keyId?: string } = {};
  const cleanup = async () => {
    if (created.keyId) await request.delete(`/api/api-keys/${created.keyId}`, { headers });
    if (created.agentId) await request.delete(`/api/agents/${created.agentId}`, { headers });
    const cleared = await request.delete(overridePath, { headers });
    expect([200, 204, 404]).toContain(cleared.status());
  };
  try {
    const configured = await request.put(overridePath, {
      headers,
      data: {
        overrides: {
          mcpSettings: { allowedDomains: [origin] },
        },
      },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    await expect
      .poll(
        async () => {
          const initialized = await request.post('/api/mcp/e2e-http/reinitialize', { headers });
          return initialized.ok() && (await initialized.json()).success === true;
        },
        { timeout: 30000, intervals: [500, 1000] },
      )
      .toBe(true);
    const agent = await request.post('/api/agents', {
      headers,
      data: {
        name: `Tool results ${randomUUID().slice(0, 8)}`,
        provider: 'Mock Provider A',
        model: 'mock-model-a',
        model_parameters: {},
        tools: ['remember_fact_mcp_e2e-http'],
      },
    });
    expect(agent.status(), await agent.text()).toBe(201);
    const agentId = (await agent.json()).id;
    created.agentId = agentId;
    const key = await request.post('/api/api-keys', {
      headers,
      data: { name: 'tool result contract' },
    });
    expect(key.status()).toBe(201);
    const credentials = await key.json();
    created.keyId = credentials.id;
    // The API key owns a narrow per-agent grant; observation must not bypass MCP authorization.
    const consentPath = `/api/api-keys/${credentials.id}/agents/${agentId}/mcp-consent`;
    const offered = await request.get(consentPath, { headers });
    expect(offered.status(), await offered.text()).toBe(200);
    const view = await offered.json();
    expect(view.offer).not.toBeNull();
    const target = view.targets.find(
      (entry: { resource: { serverName: string } }) => entry.resource.serverName === 'e2e-http',
    );
    expect(target).toBeDefined();
    const selected = target.permittedTools.find(
      (entry: { agentId: string }) => entry.agentId === agentId,
    );
    const tools = selected.tools.filter(
      (name: string) => name === 'remember_fact' || name === 'remember_fact_mcp_e2e-http',
    );
    expect(tools).toHaveLength(1);
    const granted = await request.post(consentPath, {
      headers,
      data: {
        offerDigest: view.offer.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: { 'e2e-http': tools },
      },
    });
    expect(granted.status(), await granted.text()).toBe(200);

    return {
      token,
      agentId,
      apiKey: credentials.key as string,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function execute(
  request: APIRequestContext,
  agent: Awaited<ReturnType<typeof remote>>,
  stream: boolean,
  include: boolean,
) {
  const label = randomUUID().replace(/-/g, '').slice(0, 10);
  const response = await request.post('/api/agents/v1/chat/completions', {
    headers: { Authorization: `Bearer ${agent.apiKey}` },
    data: {
      model: agent.agentId,
      messages: [{ role: 'user', content: `E2E_ACTIVITY_REPLY:${label}` }],
      stream,
      ...(include && { include: ['server_tool_results'] }),
    },
    timeout: 60000,
  });
  const text = await response.text();
  expect(response.status(), text).toBe(200);
  if (!stream) {
    const choice = JSON.parse(text).choices[0];
    expect(choice.finish_reason).toBe('stop');
    expect(choice.message.content).toContain(`E2E activity reply done ${label}`);
    expect(choice.message.tool_calls).toBeUndefined();
    if (!include) expect(choice.message.tool_results).toBeUndefined();
    return { label, results: (choice.message.tool_results ?? []) as Result[], text };
  }
  const frames = text
    .split('\n\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map((frame) => JSON.parse(frame.slice(6)));
  expect(frames[frames.length - 1].choices[0].finish_reason).toBe('stop');
  expect(frames.map((frame) => frame.choices[0].delta.content ?? '').join('')).toContain(
    `E2E activity reply done ${label}`,
  );
  expect(frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])).toEqual([]);
  return {
    label,
    results: frames.flatMap((frame) => frame.choices[0].delta.tool_results ?? []) as Result[],
    text,
  };
}

test('Chat tool result observation preserves execution ownership in JSON and SSE @scenario:chat-server-tool-results', async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(180000);
  const request = await playwright.request.newContext({ baseURL });
  const agent = await remote(request);
  try {
    for (const stream of [false, true])
      for (const include of [false, true]) {
        const { label, results } = await execute(request, agent, stream, include);
        expect(results).toHaveLength(include ? 2 : 0);
        if (!include) continue;
        expect(new Set(results.map((result) => result.call_id)).size).toBe(2);
        for (const result of results) {
          expect(result.name).toBe('remember_fact_mcp_e2e-http');
          expect(JSON.parse(result.arguments).fact).toContain(label);
          expect(result.output).toContain('E2E MCP memory noted:');
        }
        if (stream) expect(results.map((result) => result.index)).toEqual([0, 1]);
      }
  } finally {
    await agent.cleanup();
    await request.dispose();
  }
});

test('Chat observed results retain the tool-output protection policy @scenario:chat-tool-results-protected', async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(120000);
  const request = await playwright.request.newContext({ baseURL });
  const agent = await remote(request);
  try {
    await setRuntimeFilters(request, agent.token, {
      toolArguments: {
        pii: {
          fields: ['output'],
          starterPatterns: [],
          customPatterns: [
            { id: 'tool-result-probe', label: 'Tool result probe', regex: 'E2E MCP memory noted:' },
          ],
        },
      },
    });
    for (const stream of [false, true]) {
      const { results, text } = await execute(request, agent, stream, true);
      expect(results).toHaveLength(2);
      expect(text).not.toContain('E2E MCP memory noted:');
      expect(text).not.toContain('mcp_reauth_required');
      expect(results.every((result) => /blocked/i.test(result.output))).toBe(true);
      expect(results.every((result) => result.output.length > 0)).toBe(true);
    }
  } finally {
    await restoreRuntimeFilters(request, agent.token);
    await agent.cleanup();
    await request.dispose();
  }
});
