import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { MOCK_ENDPOINTS, requestJson } from './helpers';
import { openAgentBuilder, closeMobileDrawer } from './agents.helpers';

/** The bounded activity feed, which a followed thread no longer reads. */
export const ACTIVITY_PATH = /\/api\/convos\/[^/]+\/subagents\/[^/]+\/tasks\/[^/]+\/activity$/;

export async function createAgent(
  page: Page,
  token: string,
  name: string,
  subagents?: AgentDetail['subagents'],
  tools?: string[],
): Promise<AgentDetail> {
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Playwright verification of detached child activity.',
      instructions: 'Follow the deterministic end-to-end request exactly.',
      provider: tools?.length ? 'Mock Retained History' : MOCK_ENDPOINTS[0].label,
      model: tools?.length ? 'mock-retained-history' : MOCK_ENDPOINTS[0].model,
      subagents,
      tools,
      ...(tools?.length ? { model_parameters: { maxContextTokens: 262_144 } } : {}),
    },
  });
}

/** The child panel is a region beside the chat on wide layouts and a modal dialog over it on
 *  narrow ones, the same element under either role. */
export const childActivityPanel = (page: Page) =>
  page
    .getByRole('region', { name: 'Child agent activity' })
    .or(page.getByRole('dialog', { name: 'Child agent activity' }));

export async function selectAgent(page: Page, name: string): Promise<void> {
  const form = await openAgentBuilder(page);
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name }).click();
  await expect(form.getByLabel('Agent name')).toHaveValue(name);
  await form.getByRole('button', { name: 'Select Agent' }).click();
  await closeMobileDrawer(page);
}
