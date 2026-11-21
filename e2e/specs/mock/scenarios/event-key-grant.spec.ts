import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loginAdmin } from '../content-filters.helpers';

const NOTED = 'E2E MCP memory noted';

/**
 * An agent with one tool on the declared HTTP MCP server, and a personal API key that holds
 * no grant for it. The e2e config runs key grants in `delegated` mode. With `subagents`, the
 * agent can also start two children that hold no tools.
 */
async function setup(request: APIRequestContext, subagents = false) {
  const token = await loginAdmin(request);
  const headers = { Authorization: `Bearer ${token}` };
  const profile = await request.get('/api/user', { headers });
  expect(profile.status()).toBe(200);
  const user = await profile.json();
  const overridePath = `/api/admin/config/user/${user.id ?? user._id}`;
  const created: { agentId?: string; keyId?: string; children: string[] } = { children: [] };
  const cleanup = async () => {
    if (created.keyId) await request.delete(`/api/api-keys/${created.keyId}`, { headers });
    if (created.agentId) await request.delete(`/api/agents/${created.agentId}`, { headers });
    for (const id of created.children) await request.delete(`/api/agents/${id}`, { headers });
    const cleared = await request.delete(overridePath, { headers });
    expect([200, 204, 404]).toContain(cleared.status());
  };
  try {
    const origin = `http://127.0.0.1:${process.env.E2E_MCP_HTTP_PORT || '8765'}`;
    const configured = await request.put(overridePath, {
      headers,
      data: { overrides: { mcpSettings: { allowedDomains: [origin] } } },
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
    const model = { provider: 'Mock Provider A', model: 'mock-model-a', model_parameters: {} };
    for (const name of subagents ? ['one', 'two'] : []) {
      const child = await request.post('/api/agents', {
        headers,
        data: { name: `Event grant child ${name} ${randomUUID().slice(0, 8)}`, ...model },
      });
      expect(child.status(), await child.text()).toBe(201);
      created.children.push((await child.json()).id as string);
    }
    const agent = await request.post('/api/agents', {
      headers,
      data: {
        name: `Event grant ${randomUUID().slice(0, 8)}`,
        ...model,
        tools: ['remember_fact_mcp_e2e-http'],
        ...(subagents && {
          subagents: { enabled: true, allowSelf: false, agent_ids: created.children },
        }),
      },
    });
    expect(agent.status(), await agent.text()).toBe(201);
    const agentId = (await agent.json()).id as string;
    created.agentId = agentId;
    const key = await request.post('/api/api-keys', { headers, data: { name: 'event grant' } });
    expect(key.status()).toBe(201);
    const credentials = await key.json();
    created.keyId = credentials.id;
    return {
      headers,
      agentId,
      children: created.children,
      keyHeaders: { Authorization: `Bearer ${credentials.key as string}` },
      consentPath: `/api/api-keys/${credentials.id}/agents/${agentId}/mcp-consent`,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Posts one event for the agent with the key and returns the conversation it started. */
async function post(
  request: APIRequestContext,
  subject: Awaited<ReturnType<typeof setup>>,
  input: string,
): Promise<string> {
  const posted = await request.post('/api/agents/v1/events', {
    headers: { ...subject.keyHeaders, 'Idempotency-Key': randomUUID() },
    data: {
      mode: 'fire',
      event: { id: randomUUID(), type: 'e2e.event', occurredAt: Date.now() },
      target: { agentId: subject.agentId },
      input,
    },
  });
  expect(posted.status(), await posted.text()).toBe(202);
  const { id } = await posted.json();
  let conversationId: string | undefined;
  await expect
    .poll(
      async () => {
        const status = await request.get(`/api/agents/v1/events/${encodeURIComponent(id)}`, {
          headers: subject.keyHeaders,
        });
        if (!status.ok()) return undefined;
        const delivery = await status.json();
        conversationId = delivery.result?.conversationId;
        return delivery.status;
      },
      { timeout: 60000, intervals: [500, 1000] },
    )
    .toBe('succeeded');
  expect(conversationId).toBeTruthy();
  return conversationId as string;
}

/** Posts one event that calls the MCP tool and returns the turn it started, once settled. */
async function deliver(
  request: APIRequestContext,
  subject: Awaited<ReturnType<typeof setup>>,
  label: string,
): Promise<string> {
  const conversationId = await post(request, subject, `E2E_ACTIVITY_REPLY:${label}`);
  let messages = '';
  // The model's closing text follows both tool results, so it marks the turn as settled.
  await expect
    .poll(
      async () => {
        const read = await request.get(`/api/messages/${conversationId}`, {
          headers: subject.headers,
        });
        messages = await read.text();
        return messages.includes(`E2E activity reply done ${label}`);
      },
      { timeout: 60000, intervals: [500, 1000] },
    )
    .toBe(true);
  return messages;
}

test("An event a key posts runs under that key's grant for the agent @scenario:event-key-grant", async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(180000);
  const request = await playwright.request.newContext({ baseURL });
  const subject = await setup(request);
  try {
    // No grant: the event's run is refused the MCP tool, as a chat-completions run would be.
    const ungranted = await deliver(request, subject, 'ungranted');
    expect(ungranted).not.toContain(NOTED);
    expect(ungranted).toContain('consent_missing');

    const offered = await request.get(subject.consentPath, { headers: subject.headers });
    expect(offered.status(), await offered.text()).toBe(200);
    const view = await offered.json();
    const granted = await request.post(subject.consentPath, {
      headers: subject.headers,
      data: {
        offerDigest: view.offer.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: { 'e2e-http': ['remember_fact'] },
      },
    });
    expect(granted.status(), await granted.text()).toBe(200);

    // Granted: the same key's next event runs the tool.
    const allowed = await deliver(request, subject, 'granted');
    expect(allowed.split(NOTED).length - 1).toBe(2);
    expect(allowed).not.toContain('consent_missing');
  } finally {
    await subject.cleanup();
    await request.dispose();
  }
});

/**
 * Posts one event whose run starts both children detached and ends without calling the MCP
 * tool. Each child's result is reported in a turn of its own, a request the server makes for
 * the task's wake-up. The child's result carries the marker the fake model answers by calling
 * the MCP tool, so those turns are where the tool is called. Returns the conversation once
 * both turns have settled.
 */
async function deliverDetached(
  request: APIRequestContext,
  subject: Awaited<ReturnType<typeof setup>>,
  label: string,
): Promise<string> {
  const conversationId = await post(
    request,
    subject,
    `E2E_SUBAGENT_ACTIVITY:${subject.children.join(',')}:E2E_ACTIVITY_REPLY:${label}`,
  );
  let messages = '';
  await expect
    .poll(
      async () => {
        const read = await request.get(`/api/messages/${conversationId}`, {
          headers: subject.headers,
        });
        messages = await read.text();
        const turns = JSON.parse(messages) as { isCreatedByUser?: boolean }[];
        return turns.filter(
          (turn) =>
            turn.isCreatedByUser !== true &&
            JSON.stringify(turn).includes(`E2E activity reply done ${label}`),
        ).length;
      },
      { timeout: 120000, intervals: [500, 1000] },
    )
    .toBe(2);
  expect(messages).toContain('E2E detached subagents dispatched');
  return messages;
}

test("The turn that reports a detached subagent runs under the same key's grant @scenario:event-key-grant", async ({
  playwright,
  baseURL,
}) => {
  test.setTimeout(300000);
  const request = await playwright.request.newContext({ baseURL });
  const subject = await setup(request, true);
  try {
    // No grant: the later turn is refused the MCP tool, as the event's own turn would be.
    const ungranted = await deliverDetached(request, subject, 'later-ungranted');
    expect(ungranted).not.toContain(NOTED);
    expect(ungranted).toContain('consent_missing');

    const offered = await request.get(subject.consentPath, { headers: subject.headers });
    expect(offered.status(), await offered.text()).toBe(200);
    const view = await offered.json();
    const granted = await request.post(subject.consentPath, {
      headers: subject.headers,
      data: {
        offerDigest: view.offer.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: { 'e2e-http': ['remember_fact'] },
      },
    });
    expect(granted.status(), await granted.text()).toBe(200);

    // Granted: the later turn of the same key's next event runs the tool.
    const allowed = await deliverDetached(request, subject, 'later-granted');
    expect(allowed).toContain(NOTED);
    expect(allowed).not.toContain('consent_missing');
  } finally {
    await subject.cleanup();
    await request.dispose();
  }
});
