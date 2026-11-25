import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { deleteConversations, seedConversations } from '../db';
import { backgroundColor, borderRadius, chatsListRow, isTransparent } from './pinned.helpers';

/* Seeding a pinned list and reloading is the slow part of every test here, and it
 * runs in hooks, which do not read a `test.setTimeout` call made inside a test
 * body: a loaded machine timed the `beforeEach` out at the default 30s while the
 * test itself was allowed 60. Configured once for the file instead, with room
 * for the first test of a run, which also pays the app's cold start against a
 * database that may be a network hop away. */
test.describe.configure({ timeout: 120_000 });

/**
 * Keep project creation on the same all-projects route as the existing project
 * coverage, so this scenario exercises the production creation and sidebar path.
 */
async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects', { timeout: 10000 });
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/projects/')[1];
  expect(projectId).toBeTruthy();
  return projectId;
}

async function assertPainted(locator: Locator): Promise<void> {
  await expect.poll(async () => isTransparent(await backgroundColor(locator))).toBe(false);
}

async function boxOf(locator: Locator): Promise<{ left: number; right: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { left: box!.x, right: box!.x + box!.width };
}

const uniqueName = (prefix: string) => `${prefix} ${randomUUID()}`;

let createdProject: { id: string; name: string } | undefined;
let seededConversationId: string | undefined;

test.afterEach(async ({ page }) => {
  if (seededConversationId) {
    await deleteConversations([seededConversationId]);
    seededConversationId = undefined;
  }

  if (createdProject) {
    await page.goto(`/projects/${createdProject.id}`, { timeout: 10000 });
    const projectButton = page
      .getByRole('button', { name: createdProject.name, exact: true })
      .first();
    await expect(projectButton).toBeVisible();
    const projectRow = projectButton.locator('..');
    await projectRow.hover();
    await projectRow.getByRole('button', { name: 'More options', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(projectButton).toBeHidden();
    createdProject = undefined;
  }
});

test('project row actions hold their fill while their menu is open @scenario:project-row-actions-hold-their-fill-while-their-menu-is-open', async ({
  page,
}) => {
  const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
  test.skip(!hasHover, 'pointer hover is a desktop-only path');

  const projectName = uniqueName('E2E action-fill project');
  const projectId = await createProject(page, projectName);
  createdProject = { id: projectId, name: projectName };

  const projectButton = page.getByRole('button', { name: projectName, exact: true }).first();
  await expect(projectButton).toBeVisible();
  const projectRow = projectButton.locator('..');
  const newChatButton = projectRow.getByRole('link', {
    name: `New chat in ${projectName}`,
    exact: true,
  });
  const optionsButton = projectRow.getByRole('button', { name: 'More options', exact: true });

  await projectRow.hover();
  await expect(newChatButton).toBeVisible();
  await expect(optionsButton).toBeVisible();

  const rowRadius = await borderRadius(projectRow);
  expect(await borderRadius(newChatButton)).toBeLessThan(rowRadius);
  expect(await borderRadius(optionsButton)).toBeLessThan(rowRadius);

  const newChatBox = await boxOf(newChatButton);
  const optionsBox = await boxOf(optionsButton);
  const rowBox = await boxOf(projectRow);
  expect(Math.abs(optionsBox.left - newChatBox.right - 4)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(rowBox.right - optionsBox.right - 4)).toBeLessThanOrEqual(0.5);

  await newChatButton.hover();
  await assertPainted(newChatButton);
  await optionsButton.hover();
  await assertPainted(optionsButton);

  await optionsButton.click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.mouse.move(0, 0);
  await assertPainted(optionsButton);
});

test('renaming a chat fills its save and cancel under the pointer @scenario:renaming-a-chat-fills-its-save-and-cancel-under-the-pointer', async ({
  page,
}) => {
  const hasHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
  test.skip(!hasHover, 'pointer hover is a desktop-only path');

  const originalTitle = uniqueName('E2E rename-fill chat');
  const renamedTitle = `${originalTitle} renamed`;
  seededConversationId = randomUUID();
  await seedConversations(getE2EUser().email, [
    { conversationId: seededConversationId, title: originalTitle, updatedAt: new Date() },
  ]);

  await page.goto('/c/new', { timeout: 10000 });
  const row = chatsListRow(page, originalTitle);
  await expect(row).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();

  /** The row's own locator matches on its title text, which the rename replaces
   *  with an input value, so the open form is addressed from the page: only one
   *  row renames at a time. */
  const form = page.getByRole('form', { name: 'Rename Conversation', exact: true });
  const input = form.getByRole('textbox', { name: 'New Conversation Title', exact: true });
  const cancelButton = form.getByRole('button', { name: 'Cancel', exact: true });
  const saveButton = form.getByRole('button', { name: 'Save', exact: true });
  await expect(input).toBeFocused();

  await cancelButton.hover();
  await assertPainted(cancelButton);
  await saveButton.hover();
  await assertPainted(saveButton);
  expect(await borderRadius(cancelButton)).toBeCloseTo(6, 1);
  expect(await borderRadius(saveButton)).toBeCloseTo(6, 1);

  await input.fill(renamedTitle);
  await saveButton.click();
  await expect(chatsListRow(page, renamedTitle)).toBeVisible();
});
