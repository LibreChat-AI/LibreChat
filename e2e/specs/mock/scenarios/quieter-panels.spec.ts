import { expect, test } from '@playwright/test';
import { FileSources } from 'librechat-data-provider';
import type {
  TFile,
  TSchedule,
  TConversationTag,
  TSchedulesResponse,
} from 'librechat-data-provider';
import type { Page, Locator } from '@playwright/test';
import type { AgentSummary } from '../agents.helpers';
import { getAccessToken, requestJson, uniqueName } from '../helpers';
import { cleanupAgent } from '../agents.helpers';
import { openPanel } from './panels';

async function seedSchedules(page: Page, count: number) {
  const token = await getAccessToken(page);
  const agent = await requestJson<AgentSummary>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: { name: uniqueName('Panel agent'), provider: 'Mock Provider A', model: 'mock-model-a' },
  });
  const schedules: TSchedule[] = [];
  try {
    for (let index = 0; index < count; index++) {
      schedules.push(
        await requestJson<TSchedule>(page, {
          path: '/api/schedules',
          token,
          method: 'POST',
          body: {
            name: uniqueName(`Panel schedule ${index}`),
            prompt: 'Summarize the day',
            agent_id: agent.id,
            cadence: { frequency: 'daily', hour: 0, minute: 0 },
            timezone: 'UTC',
            target: 'new',
            enabled: true,
            clientRequestId: uniqueName('panel-intent'),
          },
        }),
      );
    }
  } catch (error) {
    await cleanupSchedules(page, { token, agent, schedules });
    throw error;
  }
  return { token, agent, schedules };
}

async function cleanupSchedules(page: Page, fixture: Awaited<ReturnType<typeof seedSchedules>>) {
  for (const schedule of fixture.schedules) {
    await requestJson(page, {
      path: `/api/schedules/${encodeURIComponent(schedule.id)}`,
      token: fixture.token,
      method: 'DELETE',
    });
  }
  await cleanupAgent(page, fixture.agent.id);
}

/** Whether a focused control's ring (2px plus its 2px offset) is drawn in full, rather
 *  than cut off by an ancestor that clips its overflow. */
async function ringIsUnclipped(control: Locator): Promise<boolean> {
  return control.evaluate((element) => {
    const ring = 4;
    const box = element.getBoundingClientRect();
    if (getComputedStyle(element).boxShadow === 'none') {
      return false;
    }
    for (
      let node = element.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') {
        continue;
      }
      const clip = node.getBoundingClientRect();
      if (
        box.left - ring < clip.left ||
        box.right + ring > clip.right ||
        box.top - ring < clip.top ||
        box.bottom + ring > clip.bottom
      ) {
        return false;
      }
    }
    return true;
  });
}

const hasRing = (control: Locator) =>
  control.evaluate((element) => getComputedStyle(element).boxShadow !== 'none');

function syntheticSchedule(
  id: string,
  name: string,
  status: 'skipped_balance' | 'skipped_overlap',
): TSchedule {
  return {
    id,
    user: 'schedule-fixture-user',
    name,
    prompt: 'Summarize the day',
    agent_id: 'schedule-fixture-agent',
    cadence: { frequency: 'daily', hour: 0, minute: 0 },
    timezone: 'UTC',
    target: 'new',
    enabled: true,
    nextRunAt: '2099-01-01T00:00:00.000Z',
    lastRun: { status, firedAt: '2026-09-01T00:00:00.000Z' },
    runCount: 3,
    failureCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

test.describe('quieter management panels', () => {
  test('filtering preserves capacity and usable row controls @scenario:schedule-filter-keeps-quota-and-actions', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new');
    const token = await getAccessToken(page);
    const initial = await requestJson<TSchedulesResponse>(page, { path: '/api/schedules', token });
    expect(initial.schedules).toHaveLength(0);
    const fixture = await seedSchedules(page, initial.limits.maxPerUser);

    try {
      await openPanel(page, 'schedules', 'Scheduled chats');
      const panel = page.getByRole('region', { name: 'Scheduled chats', exact: true });
      const count = fixture.schedules.length;
      const quota = panel.getByText(`${count} of ${initial.limits.maxPerUser} schedules used`);
      const create = panel.getByRole('button', { name: 'New schedule', exact: true });
      const filter = panel.getByRole('textbox', { name: 'Filter schedules...' });
      const fade = panel.locator('[aria-hidden="true"].pointer-events-none');
      const schedule = fixture.schedules[0];

      await expect(panel.getByTestId('schedule-card')).toHaveCount(count);
      await expect(fade).toHaveCSS('opacity', '1');
      const announcement = panel.locator('[aria-live="polite"]');
      await filter.fill(schedule.name);
      await expect(panel.getByTestId('schedule-card')).toHaveCount(1);
      await expect(announcement).toHaveText('1 result found');
      await expect(fade).toHaveCSS('opacity', '0');
      await expect(quota).toBeVisible();
      await expect(create).toBeDisabled();

      await filter.fill('no matching schedule');
      await expect(panel.getByText('No schedules match your search')).toBeVisible();
      await expect(announcement).toHaveText('0 results found');
      await expect(quota).toBeVisible();
      await expect(create).toBeDisabled();
      await filter.clear();
      await expect(fade).toHaveCSS('opacity', '1');

      const card = panel.getByTestId('schedule-card').filter({ hasText: schedule.name });
      const toggle = card.getByRole('switch', { name: `Enabled: ${schedule.name}`, exact: true });
      await expect(toggle).toBeChecked();
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await toggle.press('Tab');
      const menu = card.getByRole('button', {
        name: `Schedule options: ${schedule.name}`,
        exact: true,
      });
      await expect(menu).toBeFocused();
      await menu.press('Enter');
      await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Edit schedule' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Edit schedule' })).toBeHidden();

      await page.reload();
      await openPanel(page, 'schedules', 'Scheduled chats');
      await expect(toggle).not.toBeChecked();

      // Supply the historical run variant without starting the scheduling engine.
      await page.route('**/api/schedules', async (route) => {
        if (route.request().method() !== 'GET') {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const data = (await response.json()) as TSchedulesResponse;
        await route.fulfill({
          response,
          json: {
            ...data,
            schedules: data.schedules.map((item) =>
              item.id === schedule.id
                ? {
                    ...item,
                    lastRun: {
                      status: 'success',
                      firedAt: '2026-09-01T00:00:00.000Z',
                      conversationId: 'historical-schedule-run',
                    },
                  }
                : item,
            ),
          },
        });
      });
      await page.reload();
      await openPanel(page, 'schedules', 'Scheduled chats');
      const lastRun = card.getByRole('button', { name: 'Paused: Last run', exact: true });
      await expect(lastRun).toBeVisible();
      await expect(lastRun).toHaveText('Paused');

      await toggle.click();
      await expect(toggle).toBeChecked();
      const historyLink = card.getByRole('link', {
        name: `Last run: ${schedule.name}`,
        exact: true,
      });
      await expect(historyLink).toHaveAttribute('href', '/c/historical-schedule-run');

      // Keep the panel visible while removing schedule-writing controls.
      await page.route('**/api/roles/*', async (route) => {
        const response = await route.fetch();
        const role = await response.json();
        await route.fulfill({
          response,
          json: {
            ...role,
            permissions: {
              ...role.permissions,
              SCHEDULES: { ...role.permissions.SCHEDULES, USE: true, CREATE: false },
            },
          },
        });
      });
      await page.reload();
      await openPanel(page, 'schedules', 'Scheduled chats');
      await expect(card.getByRole('switch')).toHaveCount(0);
      await expect(historyLink).toBeVisible();
      await expect(historyLink).toHaveAttribute('href', '/c/historical-schedule-run');
    } finally {
      await page.unroute('**/api/schedules');
      await page.unroute('**/api/roles/*');
      await cleanupSchedules(page, fixture);
    }
  });

  test('loading rows keep their height and failed lists offer retry @scenario:schedule-loading-and-error-preserve-panel-usability', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new');
    const fixture = await seedSchedules(page, 5);
    let releaseLoading = () => {};
    const loading = new Promise<void>((resolve) => {
      releaseLoading = resolve;
    });
    let failRequests = false;
    await page.route('**/api/schedules', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      if (failRequests) {
        await route.fulfill({ status: 503, json: { message: 'Schedule service unavailable' } });
        return;
      }
      const response = await route.fetch();
      await loading;
      await route.fulfill({ response });
    });

    try {
      await openPanel(page, 'schedules', 'Scheduled chats');
      const panel = page.getByRole('region', { name: 'Scheduled chats', exact: true });
      const create = panel.getByRole('button', { name: 'New schedule', exact: true });
      const busy = panel.locator('[aria-busy="true"]');
      const placeholders = busy.locator(':scope > [aria-hidden="true"] > div');
      await expect(placeholders).toHaveCount(5);
      await expect(create).toBeDisabled();
      const loadingHeight = await placeholders
        .first()
        .evaluate((row) => row.getBoundingClientRect().height);
      releaseLoading();

      const rows = panel.getByTestId('schedule-card');
      await expect(rows).toHaveCount(5);
      const loadedHeight = await rows.first().evaluate((row) => row.getBoundingClientRect().height);
      expect(Math.abs(loadedHeight - loadingHeight)).toBeLessThanOrEqual(1);
      await expect(create).toBeEnabled();

      failRequests = true;
      await page.reload();
      await openPanel(page, 'schedules', 'Scheduled chats');
      await expect(panel.getByText("Couldn't load your scheduled chats")).toBeVisible({
        timeout: 20_000,
      });
      await expect(create).toBeDisabled();
      failRequests = false;
      await panel.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(rows).toHaveCount(5);
      await expect(create).toBeEnabled();
    } finally {
      releaseLoading();
      await page.unroute('**/api/schedules');
      await cleanupSchedules(page, fixture);
    }
  });

  test('skill files expand and collapse from the keyboard @scenario:skill-files-disclosure-opens-by-keyboard', async ({
    page,
  }) => {
    await page.goto('/c/new');
    await openPanel(page, 'skills', 'Skills');
    const disclosure = page.getByRole('button', {
      name: 'Toggle files for e2e-deployment-skill',
      exact: true,
    });
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await disclosure.focus();
    await disclosure.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const file = page.getByRole('button', { name: 'guide.txt', exact: true });
    await expect(file).toBeVisible();
    await disclosure.press('Space');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(file).toHaveCount(0);
    await disclosure.press('Enter');
    await file.click();
    await expect(page).toHaveURL(/\/skills\/[^?]+\?file=guide.txt$/);
    await expect(page.getByText('deployment skill file fixture', { exact: true })).toBeVisible();
  });

  test('file table headers stay opaque over scrolling rows @scenario:file-picker-sticky-header-stays-opaque', async ({
    page,
  }) => {
    await page.setViewportSize({ width: page.viewportSize()?.width ?? 1280, height: 600 });
    const files: TFile[] = Array.from({ length: 10 }, (_, index) => ({
      file_id: `header-file-${index}`,
      filename: `Header fixture ${index}.txt`,
      filepath: `/files/header-file-${index}.txt`,
      user: 'header-fixture-user',
      bytes: 100,
      object: 'file',
      source: FileSources.local,
      type: 'text/plain',
      usage: 0,
      embedded: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }));
    await page.route('**/api/files', (route) => route.fulfill({ json: files }));
    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'My Files', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'My Files' });
    const header = dialog.locator('thead');
    await expect(header).toBeVisible();
    // Actionability waits for the dialog's opening animation before measuring.
    await header.click({ trial: true });
    const metrics = await header.evaluate(async (element) => {
      let scroller = element.parentElement;
      while (
        scroller &&
        (!['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY) ||
          scroller.scrollHeight <= scroller.clientHeight)
      ) {
        scroller = scroller.parentElement;
      }
      if (!scroller) throw new Error('The fixture must overflow the file table');
      const before = element.getBoundingClientRect().top;
      scroller.scrollTop = 100;
      await new Promise(requestAnimationFrame);
      const context = document.createElement('canvas').getContext('2d')!;
      const isOpaque = (node: Element) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3] === 255;
      };
      return {
        scrollTop: scroller.scrollTop,
        topShift: Math.abs(element.getBoundingClientRect().top - before),
        opaque: isOpaque(element) || [...element.querySelectorAll('th')].every(isOpaque),
      };
    });
    expect(metrics.scrollTop).toBeGreaterThan(0);
    expect(metrics.topShift).toBeLessThanOrEqual(1);
    expect(metrics.opaque).toBe(true);
    await test.info().attach('file-table-header', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
  test('a run skipped for balance warns its owner while an overlap skip does not @scenario:balance-skipped-schedule-warns-owner', async ({
    page,
  }) => {
    const balance = syntheticSchedule(
      'balance-fixture',
      uniqueName('Balance skipped'),
      'skipped_balance',
    );
    const overlap = syntheticSchedule(
      'overlap-fixture',
      uniqueName('Overlap skipped'),
      'skipped_overlap',
    );
    await page.route('**/api/schedules', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const data = (await response.json()) as TSchedulesResponse;
      await route.fulfill({ response, json: { ...data, schedules: [balance, overlap] } });
    });

    try {
      await page.goto('/c/new');
      await openPanel(page, 'schedules', 'Scheduled chats');
      const panel = page.getByRole('region', { name: 'Scheduled chats', exact: true });
      const balanceCard = panel.getByTestId('schedule-card').filter({ hasText: balance.name });
      const overlapCard = panel.getByTestId('schedule-card').filter({ hasText: overlap.name });
      await expect(balanceCard).toBeVisible();
      await expect(overlapCard).toBeVisible();

      await expect(balanceCard.getByText('Skipped', { exact: true })).toBeVisible();
      await expect(overlapCard.getByText('Skipped', { exact: true })).toHaveCount(0);
      await expect(balanceCard.locator('svg.text-status-warning')).toHaveCount(1);
      await expect(overlapCard.locator('svg.text-status-warning')).toHaveCount(0);
    } finally {
      await page.unroute('**/api/schedules');
    }
  });

  test('a focused row action draws its whole focus ring @scenario:row-actions-keep-focus-ring-visible', async ({
    page,
  }) => {
    const bookmark: TConversationTag = {
      _id: 'focus-ring-fixture',
      user: 'focus-ring-fixture-user',
      tag: uniqueName('Focus ring bookmark'),
      description: '',
      count: 0,
      position: 0,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    await page.route('**/api/tags', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: [bookmark] }) : route.continue(),
    );

    try {
      await page.goto('/c/new');
      await openPanel(page, 'bookmarks', 'Bookmarks');
      const edit = page.getByRole('button', { name: 'Edit Bookmark', exact: true });
      const remove = page.getByRole('button', { name: 'Delete Bookmark', exact: true });
      await expect(page.getByText(bookmark.tag, { exact: true })).toBeVisible();

      await edit.focus();
      await page.keyboard.press('Tab');
      await expect(remove).toBeFocused();
      expect(await ringIsUnclipped(remove)).toBe(true);

      await page.keyboard.press('Shift+Tab');
      await expect(edit).toBeFocused();
      expect(await ringIsUnclipped(edit)).toBe(true);
      expect(await hasRing(remove)).toBe(false);
    } finally {
      await page.unroute('**/api/tags');
    }
  });

  test('each control in a skill row shows its own keyboard focus @scenario:skill-row-controls-show-own-focus', async ({
    page,
  }) => {
    await page.goto('/c/new');
    await openPanel(page, 'skills', 'Skills');
    const disclosure = page.getByRole('button', {
      name: 'Toggle files for e2e-deployment-skill',
      exact: true,
    });
    const row = disclosure.locator('..');
    const open = row.getByRole('button', { name: /^e2e-deployment-skill/ });
    await expect(disclosure).toBeVisible();

    await disclosure.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(open).toBeFocused();
    expect(await hasRing(open)).toBe(true);
    expect(await hasRing(disclosure)).toBe(false);
    expect(await hasRing(row)).toBe(false);

    await page.keyboard.press('Tab');
    await expect(disclosure).toBeFocused();
    expect(await hasRing(disclosure)).toBe(true);
    expect(await hasRing(open)).toBe(false);
    expect(await hasRing(row)).toBe(false);
  });
});
