import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';
import { getAccessToken, requestJson } from '../helpers';
import { openPanel } from './panels';

/**
 * The prompts sidebar reads each row's Edit and Delete actions from one batch
 * permissions request instead of one request per row. These pin what a user
 * sees in the row menu and how many permission requests the panel issues.
 */

const BATCH_PATH = '/api/permissions/promptGroup/effective/all';
const PER_ROW_PATH = /^\/api\/permissions\/promptGroup\/[^/]+\/effective$/;

type CreatedGroup = { group?: { _id: string; name: string } };

const uniqueName = (label: string) => `Row perms ${label} ${randomUUID().slice(0, 8)}`;

async function createGroup(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<CreatedGroup>(page, {
    path: '/api/prompts',
    token,
    method: 'POST',
    body: { prompt: { prompt: `Text for ${name}`, type: 'text' }, group: { name } },
  });
  const id = body.group?._id ?? '';
  expect(id).not.toBe('');
  return id;
}

async function deleteGroups(page: Page, ids: string[]) {
  const token = await getAccessToken(page);
  for (const id of ids) {
    await requestJson<{ message?: string }>(page, {
      path: `/api/prompts/groups/${encodeURIComponent(id)}`,
      token,
      method: 'DELETE',
    });
  }
}

/** Collect the prompt-group permission requests the page issues from now on. */
function trackPermissionRequests(page: Page) {
  const batch: Request[] = [];
  const perRow: Request[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === BATCH_PATH) {
      batch.push(request);
    } else if (PER_ROW_PATH.test(path)) {
      perRow.push(request);
    }
  });
  return { batch, perRow };
}

/** Open a row's menu and return the names of the actions it offers. */
async function rowActions(page: Page, name: string): Promise<string[]> {
  const row = page
    .locator('#prompts-panel')
    .getByRole('button', { name: new RegExp(`^${name} prompt`) })
    .locator('..');
  await expect(row).toBeVisible({ timeout: 20000 });
  const menu = page.getByRole('menu');
  /** Preview is always offered, so it marks a menu whose items have rendered. A click
   *  that lands while the previous row's menu is still closing opens nothing. */
  await expect(async () => {
    if (!(await menu.isVisible())) {
      await row.hover();
      await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
    }
    await expect(menu.getByRole('menuitem', { name: 'Preview' })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15000 });
  const items = await menu.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return items.map((item) => item.trim());
}

async function filterPanel(page: Page, name: string) {
  const search = page.locator('#prompts-panel').getByRole('search').getByRole('textbox');
  await search.fill(name);
}

test.describe('prompt row permissions', () => {
  test('owned prompt rows offer Edit and Delete from one batch request @scenario:owned-prompt-rows-offer-edit-delete-from-one-request', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 10000 });
    const prefix = uniqueName('owned');
    const names = [`${prefix} A`, `${prefix} B`];
    const ids: string[] = [];
    try {
      for (const name of names) {
        ids.push(await createGroup(page, name));
      }

      await page.goto('/c/new', { timeout: 10000 });
      const tracked = trackPermissionRequests(page);
      await openPanel(page, 'prompts', 'Prompts');
      await filterPanel(page, prefix);

      for (const name of names) {
        expect(await rowActions(page, name)).toEqual(['Preview', 'Edit', 'Delete']);
      }
      expect(tracked.batch.length).toBeGreaterThanOrEqual(1);
      expect(tracked.perRow).toHaveLength(0);
    } finally {
      await deleteGroups(page, ids);
    }
  });

  test('a view-only prompt row offers Preview only @scenario:view-only-prompt-row-hides-edit-delete', async ({
    page,
  }) => {
    await page.goto('/c/new', { timeout: 10000 });
    const name = uniqueName('viewer');
    const ids: string[] = [];
    try {
      const id = await createGroup(page, name);
      ids.push(id);

      /** A group shared with VIEW only: the batch answers bit 1 for this row */
      await page.route(`**${BATCH_PATH}`, async (route) => {
        const response = await route.fetch();
        const map = (await response.json()) as Record<string, number>;
        await route.fulfill({ response, json: { ...map, [id]: 1 } });
      });

      await page.goto('/c/new', { timeout: 10000 });
      await openPanel(page, 'prompts', 'Prompts');
      await filterPanel(page, name);
      expect(await rowActions(page, name)).toEqual(['Preview']);
    } finally {
      await page.unroute(`**${BATCH_PATH}`);
      await deleteGroups(page, ids);
    }
  });

  test('a prompt created in the session offers Edit and Delete in the sidebar @scenario:new-prompt-row-offers-edit-delete', async ({
    page,
  }) => {
    const name = uniqueName('created');
    const ids: string[] = [];
    try {
      await page.goto('/c/new', { timeout: 10000 });
      await openPanel(page, 'prompts', 'Prompts');
      await expect(page.locator('#prompts-panel')).toBeVisible({ timeout: 20000 });

      await page.getByRole('button', { name: 'Create Prompt' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox', { name: 'Prompt Name' }).fill(name);
      await dialog.getByRole('textbox', { name: 'Prompt text input field' }).fill('Say hello.');
      const [created] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/prompts' &&
            response.ok(),
          { timeout: 30000 },
        ),
        dialog.getByRole('button', { name: 'Create Prompt' }).click(),
      ]);
      const body = (await created.json()) as CreatedGroup;
      ids.push(body.group?._id ?? '');
      await expect(page).toHaveURL(/\/prompts\//);

      /** Same session, no reload: the batch map must already include the new group */
      await page.goBack();
      await openPanel(page, 'prompts', 'Prompts');
      await filterPanel(page, name);
      await expect(async () => {
        expect(await rowActions(page, name)).toEqual(['Preview', 'Edit', 'Delete']);
      }).toPass({ timeout: 30000 });
    } finally {
      await deleteGroups(page, ids.filter(Boolean));
    }
  });

  test('an empty prompts list issues no permission request @scenario:empty-prompt-list-skips-permission-request', async ({
    page,
  }) => {
    await page.route('**/api/prompts/groups?**', (route) =>
      route.fulfill({
        json: { promptGroups: [], pageNumber: '1', pageSize: '10', pages: 0, has_more: false },
      }),
    );
    const tracked = trackPermissionRequests(page);

    await page.goto('/c/new', { timeout: 10000 });
    await openPanel(page, 'prompts', 'Prompts');
    await expect(page.getByText('No prompts yet', { exact: true }).first()).toBeVisible({
      timeout: 20000,
    });

    expect(tracked.batch).toHaveLength(0);
    expect(tracked.perRow).toHaveLength(0);
  });
});
