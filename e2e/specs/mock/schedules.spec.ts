import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, requestJson } from './helpers';

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

type AgentSummary = { id: string; name?: string };
type AgentList = { data?: AgentSummary[] };
type Schedule = { id: string; name: string };

/**
 * Ensures an agent exists (reusing one if present, else creating). Uses a real
 * Bearer token because the app authenticates with an access token, not a plain
 * cookie. Requires the page to be on the app origin. Returns id + name.
 */
async function ensureAgent(page: Page, token: string): Promise<AgentSummary> {
  const list = await requestJson<AgentList>(page, { path: '/api/agents?limit=1', token }).catch(
    () => ({}) as AgentList,
  );
  const existing = list.data?.[0];
  if (existing?.id) {
    return existing;
  }
  const name = uniqueName('E2E Agent');
  const agent = await requestJson<AgentSummary>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: { name, provider: 'Mock Provider A', model: 'mock-model-a' },
  });
  expect(agent.id).toBeTruthy();
  return agent;
}

/** Seeds a schedule via the API so the UI test can exercise its lifecycle. */
async function seedSchedule(page: Page, token: string, agentId: string): Promise<Schedule> {
  const name = uniqueName('E2E Schedule');
  const schedule = await requestJson<Schedule>(page, {
    path: '/api/schedules',
    token,
    method: 'POST',
    body: {
      name,
      prompt: 'Summarize what happened today',
      agent_id: agentId,
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      clientRequestId: uniqueName('e2e-intent'),
    },
  });
  expect(schedule.id).toBeTruthy();
  return schedule;
}

async function openSchedulesPanel(page: Page) {
  const navButton = page.getByRole('button', { name: 'Scheduled chats' });
  await expect(navButton).toBeVisible();
  // The nav button TOGGLES: clicking it while schedules is the active, expanded
  // panel collapses the sidebar. The active panel persists to localStorage, so
  // after a reload schedules may already be active but still loading its query
  // (a spinner, no region yet). Clicking then would collapse it. Branch on
  // aria-pressed: only click to activate when it isn't already the active panel,
  // then wait for the query to resolve and render the region.
  const isActive = (await navButton.getAttribute('aria-pressed')) === 'true';
  if (!isActive) {
    await navButton.click();
  }
  const panel = page.getByRole('region', { name: 'Scheduled chats' });
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
}

test.describe('scheduled chats', () => {
  test('lists a schedule and toggles + deletes it through the panel', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/c/new', { timeout: 15000 });

    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);
    const schedule = await seedSchedule(page, token, agent.id);

    // The seeded schedule renders as a card in the panel (full backend round-trip).
    await openSchedulesPanel(page);
    const card = page.getByTestId('schedule-card').filter({ hasText: schedule.name });
    await expect(card).toBeVisible({ timeout: 15000 });

    // It survives a full reload (persisted through the real backend + DB).
    await page.reload();
    await openSchedulesPanel(page);
    const reloadedCard = page.getByTestId('schedule-card').filter({ hasText: schedule.name });
    await expect(reloadedCard).toBeVisible({ timeout: 15000 });

    // Toggling the enabled switch round-trips and re-reads from the server.
    const toggle = reloadedCard.getByRole('switch', { name: 'Enabled' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // Delete via the kebab menu + confirmation dialog.
    await reloadedCard.getByRole('button', { name: 'Schedule options' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('dialog', { name: /delete schedule/i });
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.getByTestId('schedule-card').filter({ hasText: schedule.name })).toHaveCount(
      0,
      { timeout: 15000 },
    );
  });
});
