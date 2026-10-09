import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, requestJson, replyPrompt, replyText } from './helpers';

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

type AgentSummary = { id: string; name?: string };
type Schedule = {
  id: string;
  name: string;
  nextRunAt?: string;
  enabled?: boolean;
  cadence?: { frequency: string; hour?: number; minute?: number };
  lastRun?: { status: string; conversationId?: string };
  runCount?: number;
};
type ScheduleList = { schedules: Schedule[] };
type RunNowResult = { scheduleId: string; conversationId?: string; status?: string };

async function ensureAgent(page: Page, token: string): Promise<AgentSummary> {
  const agent = await requestJson<AgentSummary>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueName('Schedule E2E Agent'),
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      tools: [],
    },
  });
  expect(agent.id).toBeTruthy();
  return agent;
}

async function createSchedule(
  page: Page,
  token: string,
  body: Record<string, unknown>,
): Promise<Schedule> {
  const schedule = await requestJson<Schedule>(page, {
    path: '/api/schedules',
    token,
    method: 'POST',
    body,
  });
  expect(schedule.id).toBeTruthy();
  return schedule;
}

async function readSchedule(page: Page, token: string, id: string): Promise<Schedule | undefined> {
  const list = await requestJson<ScheduleList>(page, { path: '/api/schedules', token });
  return list.schedules.find((s) => s.id === id);
}

async function openSchedulesPanel(page: Page) {
  const navButton = page.getByRole('button', { name: 'Scheduled chats' });
  await expect(navButton).toBeVisible();
  if ((await navButton.getAttribute('aria-pressed')) !== 'true') {
    await navButton.click();
  }
  const panel = page.getByRole('region', { name: 'Scheduled chats' });
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
}

const scheduleBody = (agentId: string, over: Record<string, unknown> = {}) => ({
  name: uniqueName('E2E Schedule'),
  prompt: 'Summarize what happened today',
  agent_id: agentId,
  cadence: { frequency: 'daily', hour: 8, minute: 0 },
  timezone: 'America/New_York',
  target: 'new',
  enabled: true,
  clientRequestId: uniqueName('e2e-intent'),
  ...over,
});

test.describe('scheduled chat execution', () => {
  /**
   * Run Now is the one path that dispatches a real generation on demand, so it is
   * where a broken loopback URL, a rejected fire token, or a lost schedule identity
   * surfaces. The smoke spec only proves the card renders.
   */
  test('Run Now generates a conversation and records it on the schedule', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);
    const label = `sched-${Date.now()}`;
    const schedule = await createSchedule(
      page,
      token,
      scheduleBody(agent.id, { prompt: replyPrompt(label) }),
    );

    // A skip/throttle answers 409/429, which requestJson surfaces as a throw.
    const result = await requestJson<RunNowResult>(page, {
      path: `/api/schedules/${schedule.id}/run`,
      token,
      method: 'POST',
    });
    expect(result.status).toBe('started');
    expect(result.conversationId).toBeTruthy();

    // Poll the schedule until the run's own completion hook records its outcome.
    await expect
      .poll(async () => (await readSchedule(page, token, schedule.id))?.lastRun?.status, {
        timeout: 60000,
        intervals: [1000],
      })
      .toBe('success');

    const settled = await readSchedule(page, token, schedule.id);
    expect(settled?.runCount).toBe(1);
    const conversationId = settled?.lastRun?.conversationId;
    expect(conversationId).toBeTruthy();

    // The generated chat is real and reachable: the agent's reply is persisted.
    await page.goto(`/c/${conversationId}`, { timeout: 15000 });
    await expect(page.getByTestId('messages-view')).toContainText(replyText(label), {
      timeout: 20000,
    });
  });

  /**
   * A due schedule must fire on the engine's own tick — no user action — exactly once,
   * and then advance past the occurrence. TICK_MS is 30s, so budget for one tick.
   */
  test('a due schedule fires automatically, once, and advances', async ({ page }) => {
    test.setTimeout(600000);
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);
    const label = `auto-${Date.now()}`;
    // Hourly ignores `hour` (cron `m * * * *`) but the payload schema still requires it.
    const schedule = await createSchedule(
      page,
      token,
      scheduleBody(agent.id, {
        prompt: replyPrompt(label),
        cadence: { frequency: 'hourly', hour: 0, minute: (new Date().getUTCMinutes() + 1) % 60 },
        timezone: 'UTC',
      }),
    );
    const before = await readSchedule(page, token, schedule.id);
    expect(before?.nextRunAt).toBeTruthy();

    // Budget from the server's OWN nextRunAt rather than a guessed constant: it already
    // includes this schedule's deterministic jitter (up to SCHEDULE_JITTER_WINDOW_MS,
    // 120s), which no fixed timeout can safely assume away. Add the engine tick
    // (30s + 2s jitter) plus room for the generation.
    const dueIn = Math.max(new Date(before!.nextRunAt!).getTime() - Date.now(), 0);
    const budget = dueIn + 120000;

    await expect
      .poll(async () => (await readSchedule(page, token, schedule.id))?.lastRun?.status, {
        timeout: budget,
        intervals: [2000],
      })
      .toBe('success');

    const after = await readSchedule(page, token, schedule.id);
    // Exactly one run, and the occurrence was advanced rather than re-fired.
    expect(after?.runCount).toBe(1);
    expect(new Date(after!.nextRunAt!).getTime()).toBeGreaterThan(
      new Date(before!.nextRunAt!).getTime(),
    );
  });

  test('rejects an invalid timezone before persisting anything', async ({ page }) => {
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);

    const before = await requestJson<ScheduleList>(page, { path: '/api/schedules', token });
    const rejected = await requestJson<unknown>(page, {
      path: '/api/schedules',
      token,
      method: 'POST',
      body: scheduleBody(agent.id, { timezone: 'Not/AZone' }),
    }).then(
      () => null,
      (err: Error) => err.message,
    );

    expect(rejected).toMatch(/400/);
    const after = await requestJson<ScheduleList>(page, { path: '/api/schedules', token });
    expect(after.schedules).toHaveLength(before.schedules.length);
  });

  /**
   * Edits through the real dialog and proves the change round-trips the backend.
   *
   * Seeded over the API rather than created through the UI on purpose: creation
   * requires the agent picker, whose list comes from a React Query cache that an
   * API-created agent does not invalidate, and which renders virtualized. That made
   * the create half brittle for reasons that have nothing to do with schedules. UI
   * CREATION is therefore still uncovered — worth a follow-up that seeds the agent
   * before first paint.
   */
  test('edits a schedule through the UI with the cadence persisted', async ({ page }) => {
    test.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);
    const name = uniqueName('UI Schedule');
    await createSchedule(
      page,
      token,
      scheduleBody(agent.id, { name, cadence: { frequency: 'weekly', hour: 8, minute: 0 } }),
    );

    await openSchedulesPanel(page);
    const persisted = page.getByTestId('schedule-card').filter({ hasText: name });
    await expect(persisted).toContainText(/Runs weekly/i, { timeout: 15000 });

    // EDIT through the dialog: rename and move the cadence to Custom. The dialog
    // pre-populates the agent from the schedule, so no picker interaction is needed.
    await persisted.getByRole('button', { name: 'Schedule options' }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const editDialog = page.getByRole('dialog');
    const renamed = `${name} edited`;
    await editDialog.locator('#schedule-name').fill(renamed);
    await editDialog.getByRole('radio', { name: 'Custom' }).click();
    await editDialog.getByTestId('schedule-cron-input').fill('0 9 * * *');

    // Custom adds a hint and validation message. On a 720px viewport, the dialog
    // itself must scroll so the footer remains reachable.
    const save = editDialog.getByRole('button', { name: 'Save' });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    await save.click();

    await page.reload();
    await openSchedulesPanel(page);
    const edited = page.getByTestId('schedule-card').filter({ hasText: renamed });
    await expect(edited).toBeVisible({ timeout: 15000 });
    await expect(edited).toContainText(/Runs on cron 0 9 \* \* \*/i);
  });

  /**
   * Deleting a schedule mid-run must quiesce it: the in-flight generation is aborted and
   * the run settles, rather than the row lingering `started` and holding a global
   * capacity slot until the orphan sweep.
   */
  test('deleting a schedule while its run is active aborts the generation', async ({ page }) => {
    test.setTimeout(180000);
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const agent = await ensureAgent(page, token);
    const schedule = await createSchedule(
      page,
      token,
      // A slow reply keeps the generation in flight long enough to delete underneath it.
      scheduleBody(agent.id, { prompt: `E2E_SLOW_REPLY:del-${Date.now()}` }),
    );

    const started = await requestJson<RunNowResult>(page, {
      path: `/api/schedules/${schedule.id}/run`,
      token,
      method: 'POST',
    });
    const conversationId = started.conversationId!;
    expect(conversationId).toBeTruthy();

    // PROVE the run is actually generating before deleting. The schedule row is hidden
    // from the owner the instant it is soft-deleted, so its disappearance is no evidence
    // that the abort was delivered, the run settled, or the row was erased.
    await expect
      .poll(
        async () =>
          (
            await requestJson<{ active?: boolean }>(page, {
              path: `/api/agents/chat/status/${conversationId}`,
              token,
            })
          ).active,
        { timeout: 60000, intervals: [500] },
      )
      .toBe(true);

    await requestJson<unknown>(page, {
      path: `/api/schedules/${schedule.id}`,
      token,
      method: 'DELETE',
    });

    // The delete has to reach the loopback generation, not just hide the row.
    await expect
      .poll(
        async () =>
          (
            await requestJson<{ active?: boolean }>(page, {
              path: `/api/agents/chat/status/${conversationId}`,
              token,
            })
          ).active,
        { timeout: 60000, intervals: [1000] },
      )
      .toBe(false);

    expect(await readSchedule(page, token, schedule.id)).toBeUndefined();
  });
});
