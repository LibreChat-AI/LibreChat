import { expect, test } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { MOCK_ENDPOINTS, getAccessToken, requestJson, sendMessage } from './helpers';

test('keeps specialist sign-in visible beside its parent call and after reload', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const ids: string[] = [];
  const clearCredential = () =>
    requestJson(page, {
      path: '/api/user/plugins',
      token,
      method: 'POST',
      body: { pluginKey: 'mcp_e2e-oauth', action: 'uninstall', auth: {} },
    });
  try {
    await clearCredential();
    const child = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('OAuth specialist'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        instructions: 'Answer the delegated request.',
        tools: ['sys__server__sys_mcp_e2e-oauth', 'echo_mcp_e2e-oauth'],
      },
    });
    ids.push(child.id);
    const parent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('OAuth parent'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        instructions: 'Delegate the request.',
        subagents: { enabled: true, allowSelf: false, agent_ids: [child.id] },
      },
    });
    ids.push(parent.id);
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parent.name }).click();
    await form.getByRole('button', { name: 'Select Agent' }).click();
    const admission = await sendMessage(page, `E2E_SUBAGENT_RESULT:${child.id}:oauth-reconnect`);
    expect(admission.ok()).toBeTruthy();
    const signIn = page.getByRole('button', { name: /Sign-in to 127\.0\.0\.1/i });
    await expect(signIn).toBeVisible({ timeout: 30_000 });
    await expect(signIn).toHaveCount(1);
    await expect(
      page.locator('[data-subagent-tool-call="call_e2e_subagent_oauth-reconnect"]'),
    ).toBeVisible();
    const capture = await page.screenshot({
      path: testInfo.outputPath('specialist-reconnect.png'),
    });
    await testInfo.attach('Specialist reconnect', { body: capture, contentType: 'image/png' });
    await page.reload();
    await expect(signIn).toBeVisible({ timeout: 30_000 });
    await expect(signIn).toHaveCount(1);
    // Reauthorization must resume the same parent execution, rather than start a new chat.
    const popupPromise = page.waitForEvent('popup');
    await signIn.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    const authorization = new URL(popup.url());
    authorization.searchParams.set('approve', '1');
    await popup.goto(authorization.toString());
    await expect(
      page.getByText('E2E subagent streamed result oauth-reconnect', { exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(signIn).toHaveCount(0);
  } finally {
    const stop = page.getByRole('button', { name: 'Stop generating' });
    if (await stop.isVisible().catch(() => false)) await stop.click();
    try {
      await clearCredential();
    } finally {
      for (const id of ids.reverse()) await cleanupAgent(page, id);
    }
  }
});
