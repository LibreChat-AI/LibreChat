import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  getAccessToken,
  requestJson,
  sendMessageAndWaitForCompletion,
} from '../helpers';

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
      description: 'Playwright verification of subagent context usage totals.',
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

test.describe('subagent context usage totals', () => {
  /** Selecting a parent agent needs the Agent Builder side panel, which the
   *  phone layout does not render, so the subagent run cannot be started from a
   *  touch viewport at all. */
  test.skip(({ isMobile }) => isMobile === true, 'Agent Builder panel is desktop-only');

  test('shows subagent usage across all branches separately from branch totals @scenario:subagents-row-reads-all-branches', async ({
    page,
  }) => {
    test.setTimeout(180000);
    const label = `context-total-${Date.now()}`;
    const childName = uniqueAgentName('E2E Child');
    const parentName = uniqueAgentName('E2E Parent');
    let childId: string | undefined;
    let parentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH);
      const token = await getAccessToken(page);
      const child = await createAgent(page, token, childName);
      childId = child.id;
      const parent = await createAgent(page, token, parentName, {
        enabled: true,
        allowSelf: false,
        agent_ids: [child.id],
      });
      parentId = parent.id;

      await selectAgent(page, parentName);
      const response = await sendMessageAndWaitForCompletion(
        page,
        `E2E_SUBAGENT_RESULT:${child.id}:${label}`,
      );
      expect(response.ok()).toBeTruthy();

      const gauge = page.getByTestId('token-usage');
      await expect(gauge).toBeVisible({ timeout: 30000 });
      await gauge.click();
      const popover = page.getByRole('region', { name: 'Context usage' });
      await expect(popover).toBeVisible({ timeout: 10000 });

      const toggle = popover.getByTestId('context-breakdown-toggle');
      if ((await toggle.getAttribute('aria-expanded')) === 'false') {
        await toggle.click();
      }
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      // A real subagent emits a context snapshot, so this scope comparison is
      // against the rendered context rows rather than an estimate fallback.
      const contextRows = popover.getByTestId('context-breakdown');
      await expect(contextRows).toBeVisible({ timeout: 10000 });
      await expect(contextRows.getByText('Subagents (all branches)', { exact: true })).toHaveCount(
        0,
      );

      const totals = popover.getByTestId('token-usage-totals');
      await expect(totals).toBeVisible({ timeout: 10000 });
      await expect(totals.getByRole('heading', { name: 'Totals' })).toBeVisible();
      await expect(totals.getByText('Input', { exact: true })).toBeVisible();
      await expect(totals.getByText('Output', { exact: true })).toBeVisible();

      const subagentRow = totals
        .locator('div.flex.w-full.items-center.justify-between')
        .filter({ hasText: 'Subagents (all branches)' });
      await expect(subagentRow).toHaveCount(1);
      await expect(
        subagentRow.locator(':scope > span').nth(1),
        // The value is compact-formatted when large; a leading non-zero digit
        // proves the all-branches usage emitted by the child is not zero.
      ).toHaveText(/^[1-9]\d*(?:\.\d+)?[KMB]?$/);
      await expect(totals.getByText('Subagents', { exact: true })).toHaveCount(0);
    } finally {
      await cleanupAgent(page, parentId);
      await cleanupAgent(page, childId);
    }
  });
});
