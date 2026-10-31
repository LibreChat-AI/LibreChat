import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { openAgentBuilder, cleanupAgent, uniqueAgentName } from './agents.helpers';
import {
  getAccessToken,
  requestJson,
  MOCK_ENDPOINTS,
  sendMessageAndWaitForCompletion,
} from './helpers';

test('Connect survives cold-replica status; tools survive the connecting replica; retry reports failure', async ({
  page,
  baseURL,
}, info) => {
  test.skip(process.env.E2E_MCP_CONNECTION_STATUS !== 'true' || process.env.E2E_REPLICAS !== '2');
  test.setTimeout(180000);
  await page.addInitScript(
    (theme) => localStorage.setItem('color-theme', theme),
    process.env.E2E_COLOR_THEME ?? 'light',
  );
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const user = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;
  const control = `http://127.0.0.1:28769/control?user=${encodeURIComponent(user)}`;
  const state = async () => (await page.request.get(control)).json();
  const evidence: unknown[] = [];
  const network: unknown[] = [];
  let agentId: string | undefined;
  page.on('response', (response) => {
    if (/\/api\/(mcp|agents\/chat)/.test(response.url()))
      network.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        method: response.request().method(),
        replica: response.headers()['x-e2e-serving-replica'],
      });
  });
  try {
    await page.request.post(control, { data: { mode: 'success' } });
    await page.getByRole('button', { name: 'MCP Settings', exact: true }).click();
    const card = page.locator('[aria-label^="E2E Connection State -"]');
    await expect(card).toBeVisible();
    const response = page.waitForResponse((r) =>
      r.url().endsWith('/api/mcp/e2e-status/reinitialize'),
    );
    await card.hover();
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    expect(await (await response).json()).toMatchObject({ success: true });
    await expect(card).toHaveAttribute('aria-label', 'E2E Connection State - Connected');
    evidence.push({ stage: 'connect-on-A', fixture: await state() });
    const agentName = uniqueAgentName('Replica MCP');
    if (process.env.E2E_EVIDENCE_BEFORE !== 'true') {
      const agent = await requestJson<{ id: string }>(page, {
        path: '/api/agents',
        token,
        method: 'POST',
        body: {
          name: agentName,
          description: 'Stateless MCP replica regression',
          instructions: 'Call status_ping when requested.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: ['status_ping_mcp_e2e-status'],
        },
      });
      agentId = agent.id;
    }
    await page.request.post('/__e2e/replica', { headers: { 'x-e2e-target': '2' } });
    // Window focus invokes the real status query through the load-balanced URL on B.
    const coldStatusResponse = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/mcp/connection/status',
    );
    // The production status query becomes stale after ten seconds.
    await page.waitForTimeout(11000);
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const coldStatus = (await (await coldStatusResponse).json()).connectionStatus['e2e-status'];
    expect(coldStatus).toMatchObject({
      connectionState: 'disconnected',
      connectionStateSource: 'unobserved',
    });
    evidence.push({ stage: 'cold-B-status', status: coldStatus, fixture: await state() });
    await page.screenshot({ path: info.outputPath('connect-A-poll-B.png') });
    await expect(card).toHaveAttribute('aria-label', 'E2E Connection State - Connected');
    if (process.env.E2E_EVIDENCE_ONLY === 'true') return;

    const form = await openAgentBuilder(page, { navigate: false });
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agentName }).click();
    await form.getByRole('button', { name: 'Select Agent' }).click();
    expect((await state()).initializations).toBe(1);
    await sendMessageAndWaitForCompletion(page, 'E2E_REPLICA_TOOL: cold B');
    expect((await state()).initializations).toBe(2);
    await expect.poll(async () => (await state()).calls).toBe(1);
    evidence.push({ stage: 'tool-on-cold-B', fixture: await state() });
    const stopped = await page.request.post('/__e2e/replica', {
      headers: { 'x-e2e-target': '2', 'x-e2e-stop-primary': 'true' },
    });
    expect(await stopped.json()).toMatchObject({ target: 2, stopped: true });
    await sendMessageAndWaitForCompletion(page, 'E2E_REPLICA_TOOL: after A exits');
    await expect.poll(async () => (await state()).calls).toBe(2);
    evidence.push({ stage: 'B-tool-after-A-exits', fixture: await state() });
    await page.getByRole('button', { name: 'MCP Settings', exact: true }).click();
    await page.request.post(control, { data: { mode: 'fail' } });
    const failed = page.waitForResponse((r) =>
      r.url().endsWith('/api/mcp/e2e-status/reinitialize'),
    );
    await card.hover();
    await card.getByRole('button', { name: 'Reconnect', exact: true }).click();
    expect(await (await failed).json()).toMatchObject({ success: false });
    await expect(card).toHaveAttribute('aria-label', 'E2E Connection State - Error');
    await expect(card.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('failed-reconnect-retry.png') });
    evidence.push({ stage: 'failed-reconnect', fixture: await state() });
    await page.request.post(control, { data: { mode: 'success' } });
    const retried = page.waitForResponse((r) =>
      r.url().endsWith('/api/mcp/e2e-status/reinitialize'),
    );
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    expect(await (await retried).json()).toMatchObject({ success: true });
    await expect(card).toHaveAttribute('aria-label', 'E2E Connection State - Connected');
    evidence.push({ stage: 'retry-recovered', fixture: await state() });
  } finally {
    fs.writeFileSync(
      info.outputPath('network-evidence.json'),
      JSON.stringify({ evidence, network }, null, 2),
    );
    if (agentId) await cleanupAgent(page, agentId);
  }
});
