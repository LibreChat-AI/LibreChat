import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import { MOCK_ENDPOINTS, fetchJson, getAccessToken, requestJson } from './helpers';

const toolRow = (form: Locator, name: string) =>
  form.getByRole('listitem').filter({ has: form.page().getByText(name, { exact: true }) });

async function saveAgent(page: Page, form: Locator, agentId: string) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === 'PATCH' &&
        new URL(candidate.url()).pathname === `/api/agents/${agentId}` &&
        candidate.ok(),
    ),
    form.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  expect(response.ok()).toBeTruthy();
}

test('subagents and handoffs have separate native tools, settings, and persistence', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.goto('/c/new');
  const token = await getAccessToken(page);
  const child = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName('E2E Native Reviewer'),
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
        name: uniqueAgentName('E2E Native Collaboration'),
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
        subagents: { enabled: true, allowSelf: false, agent_ids: [child.id] },
        edges: [
          { from: '', to: child.id },
          { from: '', to: child.id, edgeType: 'direct' },
        ],
      },
    });
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parent.name, exact: true }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(parent.name ?? '');
    const subagents = toolRow(form, 'Subagents');
    const handoffs = toolRow(form, 'Handoffs');
    await expect(subagents).toBeVisible();
    await expect(handoffs).toBeVisible();
    await expect(form.getByText('Multi-agent orchestration', { exact: true })).toHaveCount(0);

    await subagents.getByRole('button', { name: 'Configure', exact: true }).click();
    const dialog = page.getByTestId('item-dialog');
    await expect(dialog.getByRole('region', { name: 'Subagents', exact: true })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Handoffs', exact: true })).toHaveCount(0);
    await expect(
      dialog.getByRole('switch', { name: 'Allow self-spawn', exact: true }),
    ).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    await handoffs.getByRole('button', { name: 'Configure', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Handoffs', exact: true })).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Subagents', exact: true })).toHaveCount(0);
    await dialog.getByRole('combobox', { name: 'Select agent', exact: true }).click();
    const search = page.locator('input[placeholder="Search agent"]:visible');
    await search.fill(child.name ?? '');
    await expect(search).toBeFocused();
    await expect(page.getByRole('option', { name: child.name, exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    await subagents.getByRole('button', { name: 'Remove from agent', exact: true }).click();
    await expect(subagents).toHaveCount(0);
    await expect(handoffs).toBeVisible();
    await saveAgent(page, form, parent.id);
    let saved = await fetchJson<AgentDetail>(page, `/api/agents/${parent.id}/expanded`, token);
    expect(saved.subagents).toEqual({ enabled: false, allowSelf: false, agent_ids: [child.id] });
    expect(saved.edges).toEqual(parent.edges);

    await form.getByRole('button', { name: 'Add tools', exact: true }).click();
    const library = page.getByRole('dialog', { name: 'Tool Library', exact: true });
    await library
      .getByRole('button', { name: /^Subagents/ })
      .first()
      .click();
    await library.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(subagents).toBeVisible();
    await handoffs.getByRole('button', { name: 'Remove from agent', exact: true }).click();
    await expect(handoffs).toHaveCount(0);
    await expect(subagents).toBeVisible();
    await saveAgent(page, form, parent.id);
    saved = await fetchJson<AgentDetail>(page, `/api/agents/${parent.id}/expanded`, token);
    expect(saved.subagents).toEqual({ enabled: true, allowSelf: false, agent_ids: [child.id] });
    expect(saved.edges).toEqual(parent.edges?.filter((edge) => edge.edgeType === 'direct'));
    await page.reload();
    const reopened = await openAgentBuilder(page, { navigate: false });
    await reopened.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: parent.name, exact: true }).click();
    await expect(reopened.getByLabel('Agent name')).toHaveValue(parent.name ?? '');
    await expect(toolRow(reopened, 'Subagents')).toBeVisible();
    await expect(toolRow(reopened, 'Handoffs')).toHaveCount(0);
  } finally {
    await cleanupAgent(page, parent?.id);
    await cleanupAgent(page, child.id);
  }
});
