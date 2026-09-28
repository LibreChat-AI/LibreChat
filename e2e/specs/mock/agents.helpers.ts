import { expect } from '@playwright/test';
import type { AgentSubagentsConfig, GraphEdge } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, fetchJson, getAccessToken, requestJson } from './helpers';

export const AGENT_EDIT_PERMISSION = 2;

/** The app switches layouts on `(max-width: 768px)` — inclusive, so 768 itself
 *  is the sidebar-switcher layout, not the rail. */
const NARROW_MAX_WIDTH = 768;
/** Playwright reports no viewport only for a full-page context, which the mock
 *  projects never use; treat that as the desktop layout. */
const DESKTOP_WIDTH = 1280;
/** `MOBILE_DRAWER_ID` in `client/src/components/UnifiedSidebar/constants.ts`. */
const MOBILE_DRAWER_ID = 'mobile-drawer';

export type AgentSummary = {
  _id: string;
  id: string;
  name?: string;
  description?: string;
  provider: string;
  model: string;
  category?: string;
};

export type ModelParameters = {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingBudget?: number;
  fileTokenLimit?: number;
  resendFiles?: boolean;
  promptCache?: boolean;
  thinking?: boolean;
  web_search?: boolean;
};

export type AgentDetail = AgentSummary & {
  instructions?: string;
  model_parameters?: ModelParameters;
  tools?: string[];
  mcpServerNames?: string[];
  edges?: GraphEdge[];
  subagents?: AgentSubagentsConfig;
};

export const uniqueAgentName = (prefix: string) =>
  `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

export async function findAgent(
  page: Page,
  agentName: string,
  token: string,
): Promise<AgentSummary | null> {
  const body = await fetchJson<{ data?: AgentSummary[] }>(
    page,
    `/api/agents?search=${encodeURIComponent(agentName)}&limit=10&requiredPermission=${AGENT_EDIT_PERMISSION}`,
    token,
  );
  return body.data?.find((agent) => agent.name === agentName) ?? null;
}

export async function waitForPersistedAgent(
  page: Page,
  agentName: string,
  description: string,
): Promise<AgentDetail> {
  const token = await getAccessToken(page);
  let latestAgent: AgentDetail | null = null;

  for (let attempt = 0; attempt < 20; attempt++) {
    const agent = await findAgent(page, agentName, token);
    if (agent) {
      latestAgent = await fetchJson<AgentDetail>(
        page,
        `/api/agents/${encodeURIComponent(agent.id)}/expanded`,
        token,
      );
      if (latestAgent.description === description) {
        return latestAgent;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  expect(latestAgent, `Expected agent "${agentName}" to be persisted`).not.toBeNull();
  expect(latestAgent?.description).toBe(description);
  return latestAgent!;
}

export async function openAgentBuilder(page: Page) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });

  const form = page.getByRole('form', { name: 'Agent configuration form' });
  /** Which control exists is a layout decision, not a timing one: the rail is
   *  desktop-only, and at or below the app's own `(max-width: 768px)` the same
   *  panels live in the sidebar's switcher menu. Probing the page for one would
   *  turn a slow first paint into the wrong branch. */
  const narrow = (page.viewportSize()?.width ?? DESKTOP_WIDTH) <= NARROW_MAX_WIDTH;

  if (narrow) {
    /** The drawer stays mounted while closed — translated off-canvas and marked
     *  `inert` — and Playwright calls a translated element visible, so both the
     *  switcher and a restored builder form pass a visibility check while they
     *  sit behind an inert drawer. `inert` is the state, and the drawer element
     *  is where the app writes it (`UnifiedSidebar.tsx`), so the drawer is
     *  opened before anything inside it is read or handed back. */
    const drawer = page.locator(`#${MOBILE_DRAWER_ID}`);
    await expect(drawer).toBeAttached();
    if (await drawer.evaluate((element) => element.hasAttribute('inert'))) {
      await page.getByRole('button', { name: 'Open sidebar' }).click();
      await expect(drawer).not.toHaveAttribute('inert', /.*/);
    }
  }

  const builderVisible = await form
    .waitFor({ state: 'visible', timeout: 1000 })
    .then(() => true)
    .catch(() => false);
  if (!builderVisible) {
    if (narrow) {
      await page.getByTestId('panel-switcher-button').click();
      await page.getByRole('menuitemcheckbox', { name: 'Agent Builder' }).click();
    } else {
      const agentBuilderButton = page.getByRole('button', { name: 'Agent Builder' });
      await expect(agentBuilderButton).toBeVisible();
      if ((await agentBuilderButton.getAttribute('aria-pressed')) !== 'true') {
        await agentBuilderButton.click();
      }
    }
  }
  await expect(form).toBeVisible();
  return form;
}

export async function selectMockModel(page: Page, clickBackToBuilder = false) {
  const form = page.getByRole('form', { name: 'Agent configuration form' });

  await form.locator('label[for="provider"] + button').click();
  await expect(form.getByText('Model Parameters', { exact: true })).toBeVisible();

  await form.getByRole('combobox', { name: 'Provider' }).click();
  await page.getByRole('option', { name: MOCK_ENDPOINTS[0].label }).click();

  await form.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: MOCK_ENDPOINTS[0].model, exact: true }).click();

  if (clickBackToBuilder) {
    await form.getByRole('button', { name: 'Back to builder' }).click();
    await expect(page.getByRole('form', { name: 'Agent configuration form' })).toBeVisible();
  }
}

export async function cleanupAgent(page: Page, agentId?: string) {
  if (!agentId) {
    return;
  }

  const token = await getAccessToken(page);
  await requestJson<{ message?: string }>(page, {
    path: `/api/agents/${encodeURIComponent(agentId)}`,
    token,
    method: 'DELETE',
  });
}
