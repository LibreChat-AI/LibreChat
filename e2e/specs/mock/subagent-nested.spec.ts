import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from './agents.helpers';
import {
  MOCK_ENDPOINTS,
  getAccessToken,
  messagesView,
  requestJson,
  sendMessageAndWaitForCompletion,
} from './helpers';

async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of a subagent called from inside a subagent.',
      instructions: 'Follow the test request exactly.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      subagents,
    },
  });
}

async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
}

test('a subagent called from inside a subagent keeps its name and its caller after a reload', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const label = `chain-${Date.now()}`;
  const childName = uniqueAgentName('E2E Child');
  const relayName = uniqueAgentName('E2E Relay');
  const parentName = uniqueAgentName('E2E Parent');
  const ids: (string | undefined)[] = [];

  try {
    await page.goto('/c/new');
    const token = await getAccessToken(page);
    const child = await createAgent(page, token, childName);
    ids.push(child.id);
    const relay = await createAgent(page, token, relayName, {
      enabled: true,
      allowSelf: false,
      agent_ids: [child.id],
    });
    ids.push(relay.id);
    const parent = await createAgent(page, token, parentName, {
      enabled: true,
      allowSelf: false,
      agent_ids: [relay.id],
    });
    ids.push(parent.id);

    await selectAgent(page, parentName);
    const response = await sendMessageAndWaitForCompletion(
      page,
      `E2E_SUBAGENT_CHAIN:${relay.id}:${child.id}:${label}`,
    );
    expect(response.ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden({
      timeout: 60_000,
    });
    const expected = `E2E subagent streamed result ${label}`;
    await expect(messagesView(page).getByText(expected).last()).toBeVisible({ timeout: 30_000 });

    /** A reload leaves only what the server saved. */
    await page.reload();
    await messagesView(page)
      .getByRole('button', { name: new RegExp(relayName) })
      .click();
    await expect(page.getByText(`E2E_SUBAGENT_RELAY:${label}`)).toBeVisible();

    /** The relay's own call is drawn under the child's name, which only a saved identity gives. */
    const nested = page.getByRole('button', { name: new RegExp(childName) });
    await expect(nested).toBeVisible();
    await nested.click();
    await expect(page.getByText(`E2E_SUBAGENT_CHILD:${label}`)).toBeVisible();
    await expect(page.getByRole('heading', { name: childName }).first()).toBeVisible();

    /** The brief the child was given is the relay's turn, not an unnamed parent's. */
    await expect(page.getByRole('heading', { name: relayName })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Parent agent' })).toHaveCount(0);
  } finally {
    for (const id of ids.reverse()) {
      await cleanupAgent(page, id);
    }
  }
});
