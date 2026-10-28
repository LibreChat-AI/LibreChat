import { expect, test } from '@playwright/test';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  getAccessToken,
  requestJson,
  fetchJson,
  sendMessage,
  messagesView,
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
} from './helpers';

for (const [theme, width] of [
  ['light', 1280],
  ['dark', 1280],
  ['dark', 390],
] as const) {
  test(`approval mode controls persist in ${theme} mode at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((value) => localStorage.setItem('color-theme', value), theme);
    await page.goto(NEW_CHAT_PATH);
    const token = await getAccessToken(page);
    const name = uniqueAgentName('Approval modes');
    const agent = await requestJson<{ id: string }>(page, {
      path: '/api/agents',
      method: 'POST',
      token,
      body: {
        name,
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        tools: [
          'sys__server__sys_mcp_e2e-memory',
          'remember_fact_mcp_e2e-memory',
          'recall_fact_mcp_e2e-memory',
        ],
      },
    });
    try {
      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(name);
      await form.getByRole('button', { name: 'Configure', exact: true }).last().click();
      const dialog = page.getByTestId('item-dialog');
      await expect(dialog.getByText('Tools in this server')).toBeVisible();
      const row = dialog.getByRole('button', { name: 'remember_fact', exact: true }).locator('..');
      await row.getByRole('button', { name: /^Tool approval mode:/ }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      for (const label of [
        'Use inherited policy',
        'Always ask',
        'Always approve',
        'Ask once per chat',
        'Ask once, then always approve',
      ]) {
        await expect(
          menu.getByRole('menuitemcheckbox', { name: label, exact: true }),
        ).toBeVisible();
      }
      await menu.getByRole('menuitemcheckbox', { name: 'Ask once per chat', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Tool approval mode: Ask once per chat', exact: true }),
      ).toBeVisible();
      await dialog
        .getByRole('button', { name: /Approval mode for all listed tools: Mixed/ })
        .click();
      await menu.getByRole('menuitemcheckbox', { name: 'Always ask', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await expect(
        row.getByRole('button', { name: 'Tool approval mode: Always ask', exact: true }),
      ).toBeVisible();
      await row.getByRole('button', { name: /^Tool approval mode:/ }).focus();
      await page.keyboard.press('Enter');
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitemcheckbox', { name: 'Ask once per chat', exact: true }).click();
      await expect(menu).toHaveCount(0);
      await row.getByRole('button', { name: /^Tool approval mode:/ }).click();
      await testInfo.attach('Approval menu', {
        body: await menu.screenshot(),
        contentType: 'image/png',
      });
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await openAgentBuilder(page, { navigate: false });
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'PATCH' &&
            response.url().includes(`/api/agents/${agent.id}`),
        ),
        form.getByRole('button', { name: 'Save', exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
      const body = await saved.json();
      expect(body.tool_options['remember_fact_mcp_e2e-memory'].approval_mode).toBe('chat');
      await page.reload();
      const reopened = await openAgentBuilder(page, { navigate: false });
      await reopened.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name }).click();
      await reopened.getByRole('button', { name: 'Configure', exact: true }).last().click();
      await expect(
        dialog.getByRole('button', { name: 'Tool approval mode: Ask once per chat', exact: true }),
      ).toBeVisible();
      await testInfo.attach('MCP tool approval controls', {
        body: await dialog.screenshot(),
        contentType: 'image/png',
      });
      const overflow = await dialog.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      );
      expect(overflow).toBe(false);
    } finally {
      await page.keyboard.press('Escape');
      await cleanupAgent(page, agent.id);
    }
  });
}

test('a real MCP batch learns approval only after review, then reuses it in the chat', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const name = uniqueAgentName('Learned approval');
  const toolName = 'remember_fact_mcp_e2e-memory';
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    method: 'POST',
    token,
    body: {
      name,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: ['sys__server__sys_mcp_e2e-memory', toolName],
      tool_options: {
        [toolName]: {
          approval_mode: 'chat',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
    },
  });
  try {
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name }).click();
    await form.getByRole('button', { name: 'Select Agent' }).click();
    const first = `first-${Date.now()}`;
    expect((await sendMessage(page, `E2E_ACTIVITY_REPLY:${first}`)).ok()).toBe(true);
    const panel = page.locator('#pending-tool-approval-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Approving remembers this tool/).first()).toBeVisible();
    for (const approve of await panel.getByRole('button', { name: 'Approve', exact: true }).all())
      await approve.click();
    await panel.getByRole('button', { name: 'Continue', exact: true }).click();
    const conversationId = new URL(page.url()).pathname.split('/').pop()!;
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await fetchJson<Array<{ content?: object[] }>>(
              page,
              `/api/messages/${conversationId}`,
              token,
            ),
          ),
        { timeout: 20000 },
      )
      .toContain(`E2E MCP memory noted: activity alpha ${first}`);
    await expect(
      messagesView(page).getByText('E2E mock reply: pong', { exact: true }),
    ).toBeVisible();
    await expect(panel).toHaveCount(0);
    const second = `second-${Date.now()}`;
    expect((await sendMessage(page, `E2E_ACTIVITY_REPLY:${second}`)).ok()).toBe(true);
    await expect(
      messagesView(page).getByText(`E2E activity reply done ${second}`, { exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(panel).toHaveCount(0);
    const completed = await fetchJson<
      Array<{ content?: Array<{ tool_call?: { output?: string } }> }>
    >(page, `/api/messages/${conversationId}`, token);
    expect(JSON.stringify(completed)).toContain(`E2E MCP memory noted: activity alpha ${second}`);
  } finally {
    await cleanupAgent(page, agent.id);
  }
});

test('a basic agent viewer can reset personal consent without loading authoring options', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.goto(NEW_CHAT_PATH);
  const token = await getAccessToken(page);
  const name = uniqueAgentName('Viewer consent reset');
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    method: 'POST',
    token,
    body: {
      name,
      description: 'Personal consent reset',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      tools: ['remember_fact_mcp_e2e-memory'],
      tool_options: {
        'remember_fact_mcp_e2e-memory': {
          approval_mode: 'always',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
    },
  });
  let basicReads = 0;
  await page.route(`**/api/agents/${agent.id}*`, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    basicReads++;
    await route.fulfill({
      response,
      json: {
        id: body.id,
        _id: body._id,
        name: body.name,
        description: body.description,
        avatar: body.avatar,
        created_at: body.created_at,
      },
    });
  });
  try {
    await page.goto(`/agents/all?q=${encodeURIComponent(name)}`);
    await page.getByRole('button', { name, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const reset = dialog.getByRole('button', {
      name: 'Reset my remembered approvals',
      exact: true,
    });
    await expect(reset).toBeEnabled();
    expect(basicReads).toBeGreaterThan(0);
    await expect(dialog.getByRole('button', { name: 'Configure', exact: true })).toHaveCount(0);
    await reset.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await reset.click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/agents/tools/approvals/reset') &&
          response.request().method() === 'POST',
      ),
      page.getByRole('menuitem', { name: 'Reset my remembered approvals', exact: true }).click(),
    ]);
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toEqual({ agentId: agent.id });
    await expect(
      page.getByText('Your remembered approvals were reset.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
  } finally {
    await cleanupAgent(page, agent.id);
  }
});
