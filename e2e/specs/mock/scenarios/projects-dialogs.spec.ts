import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import { escapeRegExp, getAccessToken, uniqueName, NEW_CHAT_PATH } from '../helpers';
import { requestResult } from '../content-filters.helpers';

type Project = { id: string; name: string };

const createdProjects: Array<{ id: string; token: string }> = [];

/** Creates a project through the API (201) and loads the app so the page has a session. */
async function createProject(page: Page, prefix: string): Promise<Project> {
  await page.goto('/projects', { timeout: 10000 });
  const token = await getAccessToken(page);
  const name = uniqueName(prefix);
  const result = await requestResult(page.request, {
    path: '/api/projects',
    token,
    method: 'POST',
    data: { name },
  });
  expect(result.status, result.text).toBe(201);
  const body = result.body as { _id?: string; id?: string };
  const id = body._id ?? body.id;
  expect(id).toBeTruthy();
  createdProjects.push({ id: id as string, token });
  return { id: id as string, name };
}

test.afterEach(async ({ page }) => {
  const projects = createdProjects.splice(0);
  for (const project of projects) {
    try {
      await page.request.delete(`/api/projects/${encodeURIComponent(project.id)}`, {
        headers: { Authorization: `Bearer ${project.token}` },
      });
    } catch {
      // The project name is unique per test, so a missed cleanup cannot collide.
    }
  }
});

/** The Files region and its "Choose from your files" item need RAG on. */
async function enableRag(page: Page) {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), ragEnabled: true } });
    },
  );
}

const availablePath = (projectId: string) => `/api/projects/${projectId}/files/available`;

function fileFixture(filename: string, type: string) {
  const fileId = randomUUID();
  const now = new Date().toISOString();
  return {
    user: 'e2e-user',
    file_id: fileId,
    filename,
    filepath: `/uploads/${fileId}`,
    bytes: 2048,
    object: 'file',
    type,
    embedded: true,
    context: FileContext.message_attachment,
    source: 'local',
    usage: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function fulfillJson(route: Route, status: number, json: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
}

async function openPicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add files', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Choose from your files' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose from your files' });
  await expect(picker).toBeVisible();
  return picker;
}

test.describe('project dialogs', () => {
  test('Edit project opens a dialog, saves, and restores focus on Escape @scenario:project-edit-opens-dialog', async ({
    page,
  }) => {
    const project = await createProject(page, 'E2E Edit Dialog');
    await page.goto('/projects', { timeout: 10000 });
    const card = page.locator('article').filter({ hasText: project.name });
    await expect(card).toBeVisible();

    const trigger = card.getByRole('button', { name: 'More options', exact: true });
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Edit project', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Edit project' });
    await expect(dialog).toBeVisible();
    const nameInput = dialog.getByRole('textbox', { name: 'Project name', exact: true });
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue(project.name);

    const renamed = `${project.name} renamed`;
    await nameInput.fill(renamed);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('article').filter({ hasText: renamed })).toBeVisible();

    // Second open: Escape closes the dialog without saving and leaves nothing open.
    const renamedCard = page.locator('article').filter({ hasText: renamed });
    const renamedTrigger = renamedCard.getByRole('button', {
      name: 'More options',
      exact: true,
    });
    await renamedTrigger.click();
    await page.getByRole('menuitem', { name: 'Edit project', exact: true }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(renamedTrigger).toBeFocused();
  });

  test('a filter with no matches shows the search empty state @scenario:project-picker-filtered-empty-state', async ({
    page,
  }) => {
    const project = await createProject(page, 'E2E Picker Filter');
    await enableRag(page);
    await page.route(
      (url) => url.pathname === availablePath(project.id),
      (route) =>
        fulfillJson(route, 200, {
          files: [fileFixture('only-document.txt', 'text/plain')],
          nextCursor: null,
        }),
    );
    await page.goto(`/projects/${project.id}`, { timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(project.name)) }),
    ).toBeVisible();

    const picker = await openPicker(page);
    await expect(picker.getByText('only-document.txt')).toBeVisible();
    await picker.getByRole('radio', { name: 'Images', exact: true }).click();
    await expect(picker.getByText('No results match your search')).toBeVisible();
    await expect(picker.getByText('only-document.txt')).toHaveCount(0);
    await expect(picker.getByText('No searchable files available', { exact: false })).toHaveCount(
      0,
    );
  });

  test('a failed later page keeps loaded files and retries @scenario:project-picker-page-failure-keeps-files', async ({
    page,
  }) => {
    const project = await createProject(page, 'E2E Picker Pages');
    await enableRag(page);
    const first = fileFixture('first-page-file.txt', 'text/plain');
    const second = fileFixture('second-page-file.txt', 'text/plain');
    let failSecondPage = true;
    await page.route(
      (url) => url.pathname === availablePath(project.id),
      (route) => {
        const cursor = new URL(route.request().url()).searchParams.get('cursor');
        if (!cursor) {
          return fulfillJson(route, 200, { files: [first], nextCursor: 'page-2' });
        }
        if (failSecondPage) {
          return fulfillJson(route, 500, { message: 'second page failed' });
        }
        return fulfillJson(route, 200, { files: [second], nextCursor: null });
      },
    );
    await page.goto(`/projects/${project.id}`, { timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(project.name)) }),
    ).toBeVisible();

    const picker = await openPicker(page);
    await expect(picker.getByText('first-page-file.txt')).toBeVisible();
    await picker.getByRole('button', { name: 'Load more', exact: true }).click();

    const alert = picker.getByRole('alert').filter({ hasText: 'Could not load project files' });
    await expect(alert).toBeVisible({ timeout: 20000 });
    await expect(picker.getByText('first-page-file.txt')).toBeVisible();

    failSecondPage = false;
    await alert.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(picker.getByText('second-page-file.txt')).toBeVisible();
    await expect(picker.getByText('first-page-file.txt')).toBeVisible();
    await expect(alert).toBeHidden();
  });

  test('closing the picker leaves no add-files menu open @scenario:project-picker-close-closes-menu', async ({
    page,
  }) => {
    const project = await createProject(page, 'E2E Picker Close');
    await enableRag(page);
    await page.route(
      (url) => url.pathname === availablePath(project.id),
      (route) =>
        fulfillJson(route, 200, {
          files: [fileFixture('close-check.txt', 'text/plain')],
          nextCursor: null,
        }),
    );
    await page.goto(`/projects/${project.id}`, { timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(project.name)) }),
    ).toBeVisible();

    const picker = await openPicker(page);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Choose from your files' })).toHaveCount(0);
    const addFiles = page.getByRole('button', { name: 'Add files', exact: true });
    await expect(addFiles).toHaveAttribute('aria-expanded', 'false');
    /* With the menu gone, focus returns to the button that opened it. */
    await expect(addFiles).toBeFocused();
  });

  test('project pages share the chat landing background @scenario:project-pages-match-landing-background', async ({
    page,
  }) => {
    const project = await createProject(page, 'E2E Project Background');

    /** The first non-transparent background at or above the main landmark, since the
     *  landing's surface is painted by a wrapper around `<main>`. */
    const surfaceColor = (target: Page) =>
      target
        .getByRole('main')
        .first()
        .evaluate((element) => {
          let node: HTMLElement | null = element as HTMLElement;
          while (node) {
            const color = getComputedStyle(node).backgroundColor;
            if (color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') {
              return color;
            }
            node = node.parentElement;
          }
          return 'transparent';
        });

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await expect(page.getByRole('main').first()).toBeVisible();
    const landing = await surfaceColor(page);
    expect(landing).not.toBe('transparent');

    await page.goto(`/projects/${project.id}`, { timeout: 10000 });
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(project.name)) }),
    ).toBeVisible();
    expect(await surfaceColor(page)).toBe(landing);

    await page.goto('/projects', { timeout: 10000 });
    await expect(page.locator('article').filter({ hasText: project.name })).toBeVisible();
    expect(await surfaceColor(page)).toBe(landing);
  });
});
