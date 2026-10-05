import { expect, test } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { openAgentBuilder, cleanupAgent, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  requestJson,
  fetchJson,
  messagesView,
  sendMessageAndWaitForCompletion,
} from './helpers';

test('authors and executes a graph team independently of ordinary subagents', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const child = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('Graph reviewer'),
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
    },
  });
  let parent: AgentDetail | undefined;
  try {
    parent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: uniqueAgentName('Graph host'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        subagents: { enabled: false, allowSelf: false, agent_ids: [] },
      },
    });
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parent.name, exact: true }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(parent.name ?? '');
    await form.getByRole('button', { name: 'Add tools', exact: true }).click();
    const library = page.getByRole('dialog', { name: 'Tool Library', exact: true });
    await library
      .getByRole('listitem')
      .filter({ hasText: 'Subagent Graphs' })
      .getByRole('button', { name: 'Configure', exact: true })
      .click();
    const dialog = page.getByTestId('item-dialog');
    await expect(
      dialog.getByRole('region', { name: 'Subagent Graphs', exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Add graph team', exact: true }).click();
    await dialog.getByLabel('Team name', { exact: true }).fill('Review team');
    await dialog.getByLabel('Tool identifier', { exact: true }).fill('review_team');
    await dialog
      .getByLabel('When to use this team', { exact: true })
      .fill('Review a task in an isolated team.');
    await dialog.getByRole('combobox', { name: 'Add team member', exact: true }).click();
    const search = page.locator('input[placeholder="Search agent"]:visible');
    await search.fill(child.name ?? '');
    await expect(search).toBeFocused();
    await page.getByRole('option', { name: child.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Save graph team', exact: true }).click();
    await expect(dialog.getByText('Review team', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page
      .getByRole('dialog', { name: 'Tool Library', exact: true, includeHidden: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const graphRow = form
      .getByRole('listitem')
      .filter({ has: page.getByText('Subagent Graphs', { exact: true }) });
    await expect(graphRow).toBeVisible();
    await expect(
      form.getByRole('listitem').filter({ has: page.getByText('Subagents', { exact: true }) }),
    ).toHaveCount(0);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/api/agents/${parent?.id}` &&
          response.ok(),
      ),
      form.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    let saved = await fetchJson<AgentDetail>(page, `/api/agents/${parent.id}/expanded`, token);
    expect(saved.subagents).toMatchObject({
      enabled: false,
      allowSelf: false,
      graphsEnabled: true,
      graphs: [
        {
          type: 'review_team',
          agent_ids: [child.id],
          entry_agent_id: child.id,
          result_agent_id: child.id,
          edges: [],
        },
      ],
    });
    if (process.env.E2E_GRAPH_SUBAGENTS === 'true') {
      await form.getByRole('button', { name: 'Select Agent', exact: true }).click();
      const label = `graph-${Date.now()}`;
      const result = await sendMessageAndWaitForCompletion(
        page,
        `E2E_SUBAGENT_RESULT:review_team:${label}`,
        { timeout: 30000 },
      );
      expect(result.ok()).toBeTruthy();
      await expect(
        messagesView(page)
          .getByText(`E2E subagent streamed result ${label}`, { exact: true })
          .last(),
      ).toBeVisible({ timeout: 30000 });
    }
    const reopened = await openAgentBuilder(page);
    await reopened.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parent.name, exact: true }).click();
    await expect(reopened.getByLabel('Agent name')).toHaveValue(parent.name ?? '');
    await reopened
      .getByRole('listitem')
      .filter({ has: page.getByText('Subagent Graphs', { exact: true }) })
      .getByRole('button', { name: 'Remove from agent', exact: true })
      .click();
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' &&
          new URL(response.url()).pathname === `/api/agents/${parent?.id}` &&
          response.ok(),
      ),
      reopened.getByRole('button', { name: 'Save', exact: true }).click(),
    ]);
    saved = await fetchJson<AgentDetail>(page, `/api/agents/${parent.id}/expanded`, token);
    expect(saved.subagents).toMatchObject({
      enabled: false,
      graphsEnabled: false,
      graphs: [{ type: 'review_team' }],
    });
  } finally {
    await cleanupAgent(page, parent?.id);
    await cleanupAgent(page, child.id);
  }
});
