import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  escapeRegExp,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/**
 * Creates a project from the all-projects page and returns its id.
 * Project creation navigates to the project workspace (`/projects/:id`).
 */
async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects', { timeout: 10000 });
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name: new RegExp(escapeRegExp(name)) })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/projects/')[1];
  expect(projectId).toBeTruthy();
  return projectId;
}

const uniqueName = (prefix: string) => `${prefix} ${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

test.describe('chat projects', () => {
  test('creates a project with full-width instructions when RAG is disabled', async ({ page }) => {
    test.setTimeout(60000);
    const name = uniqueName('E2E Project');
    await page.route(
      (url) => url.pathname === '/api/config',
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), ragEnabled: false },
        });
      },
    );

    await createProject(page, name);
    await expect(page.getByRole('region', { name: 'Files', exact: true })).toHaveCount(0);
    const instructions = page.getByRole('region', { name: 'Instructions', exact: true });
    const widths = await instructions.evaluate((element) => {
      const parent = element.parentElement!;
      const padding = getComputedStyle(parent);
      return {
        instructions: element.getBoundingClientRect().width,
        /** The gutter that separates the column from the workspace separator lives on
         *  this wrapper, so "full width" means the wrapper's content box. */
        available:
          parent.getBoundingClientRect().width -
          Number.parseFloat(padding.paddingLeft) -
          Number.parseFloat(padding.paddingRight),
      };
    });
    expect(widths.instructions).toBeCloseTo(widths.available, 0);

    const header = page.getByRole('main').locator('header');
    const newChat = await header.getByRole('button', { name: /^New chat in / }).boundingBox();
    const options = await header
      .getByRole('button', { name: 'Project options', exact: true })
      .boundingBox();
    expect(newChat!.x + newChat!.width).toBeLessThan(options!.x);
    expect(newChat!.y + newChat!.height / 2).toBeCloseTo(options!.y + options!.height / 2, 0);

    await page.goto('/projects', { timeout: 10000 });
    await expect(page.getByRole('button', { name }).first()).toBeVisible();
  });

  test('hands keyboard focus from the file menu to the picker and back', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/config',
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), ragEnabled: true },
        });
      },
    );
    await createProject(page, uniqueName('E2E File Picker'));
    const addFiles = page.getByRole('button', { name: 'Add files', exact: true });
    await addFiles.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Upload from device' })).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.getByRole('menuitem', { name: 'Choose from your files' })).toBeFocused();
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog');
    await expect(picker.locator(':focus')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.getByRole('menuitem', { name: 'Choose from your files' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(addFiles).toBeFocused();
  });

  test('edits long project metadata inline without overflowing mobile layouts', async ({
    page,
  }) => {
    const initialName = uniqueName('Inline project');
    await createProject(page, initialName);
    await page.setViewportSize({ width: 320, height: 844 });
    /** The workspace edits metadata in place: its title is the control that opens the
     *  editor, and the options menu carries only destructive actions. */
    await page
      .getByRole('main')
      .getByRole('heading', { name: new RegExp(escapeRegExp(initialName)) })
      .getByRole('button', { name: new RegExp(escapeRegExp(initialName)) })
      .click();

    const nameInput = page.getByRole('textbox', { name: 'Project name', exact: true });
    await expect(nameInput).toBeFocused();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const longName = uniqueName('Inline').padEnd(100, 'x');
    const longDescription = 'd'.repeat(1000);
    await nameInput.fill(longName);
    await page.getByRole('textbox', { name: /^Description/ }).fill(longDescription);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(longName)) }),
    ).toBeVisible();
    await page.reload();

    const title = page
      .getByRole('heading', { name: new RegExp(escapeRegExp(longName)) })
      .getByText(longName);
    await expect(title).toBeVisible();
    const mobileTitle = await title.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(mobileTitle.height).toBeLessThanOrEqual(mobileTitle.lineHeight * 2 + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );

    await page.getByRole('button', { name: new RegExp(escapeRegExp(longDescription)) }).click();
    await expect(page.getByRole('textbox', { name: /^Description/ })).toHaveValue(longDescription);
    await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('Unsaved change');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: new RegExp(escapeRegExp(longName)) }),
    ).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 900 });
    const desktopTitle = await title.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(desktopTitle.height).toBeLessThanOrEqual(desktopTitle.lineHeight + 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('main').getByRole('button', { name: 'All projects', exact: true }).click();
    await expect(page.locator('article').filter({ hasText: longName })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await page.getByRole('main').getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await page
      .locator('li')
      .filter({ has: page.getByRole('button', { name: longName, exact: true }) })
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Edit project', exact: true }).click();
    await expect(nameInput).toBeFocused();
    await expect(nameInput).toHaveValue(longName);
  });

  test('persists workspace instructions and exposes a read-only project badge', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueName('E2E Project');
    const projectId = await createProject(page, name);
    const guidance = 'project-guidance-token';

    await page.getByRole('button', { name: 'Edit instructions' }).click();
    const instructionsDialog = page.getByRole('dialog');
    await instructionsDialog
      .getByRole('textbox', { name: 'Workspace instructions' })
      .fill(`Always follow ${guidance} when answering.`);
    await instructionsDialog.getByRole('button', { name: 'Save' }).click();
    await expect(instructionsDialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Edit instructions' })).toBeFocused();
    await page.goto(`/c/new?projectId=${projectId}`, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessage(page, `E2E_ASSERT_PROJECT_CONTEXT:${guidance}`);
    const transcript = page.getByTestId('screenshot-target');
    await expect(
      transcript.getByText(`E2E project context assertion passed: ${guidance}`),
    ).toBeVisible({
      timeout: 20000,
    });
    await expect(page.getByRole('link', { name: `Open ${name} workspace` })).toBeVisible();

    const conversationUrl = page.url();
    await page.goto(`/projects/${projectId}`, { timeout: 10000 });
    await page.getByRole('button', { name: 'Edit instructions' }).click();
    const updatedDialog = page.getByRole('dialog');
    const updatedGuidance = 'project-updated-guidance-token';
    await updatedDialog
      .getByRole('textbox', { name: 'Workspace instructions' })
      .fill(`Use ${updatedGuidance} for future turns.`);
    await updatedDialog.getByRole('button', { name: 'Save' }).click();
    await expect(updatedDialog).toBeHidden();
    await page.goto(conversationUrl, { timeout: 10000 });
    await sendMessage(page, `E2E_ASSERT_PROJECT_CONTEXT:${updatedGuidance} ${guidance}`);
    await expect(
      transcript.getByText(`E2E project context assertion passed: ${updatedGuidance}`),
    ).toBeVisible({ timeout: 20000 });
    await page.goto(`/projects/${projectId}`, { timeout: 10000 });
    await page.getByRole('button', { name: 'Edit instructions' }).click();
    const clearDialog = page.getByRole('dialog');
    await clearDialog.getByRole('textbox', { name: 'Workspace instructions' }).fill('');
    await clearDialog.getByRole('button', { name: 'Save' }).click();
    await expect(clearDialog).toBeHidden();
    await page.goto(conversationUrl, { timeout: 10000 });
    await sendMessage(page, `E2E_ASSERT_PROJECT_CONTEXT:- ${updatedGuidance}`);
    await expect(transcript.getByText('E2E project context assertion passed: -')).toBeVisible({
      timeout: 20000,
    });

    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);
    await expect(page.getByRole('link', { name: `Open ${name} workspace` })).toBeVisible();
  });
  test('starts a project-scoped chat and persists it under the project', async ({ page }) => {
    test.setTimeout(120000);
    const name = uniqueName('E2E Project');
    const projectId = await createProject(page, name);

    // The workspace exposes a composer entry to start a chat in the project.
    await expect(page.getByRole('button', { name: `New chat in ${name}` }).first()).toBeVisible();

    // Open the project-scoped new-chat landing directly.
    await page.goto(`/c/new?projectId=${projectId}`, { timeout: 10000 });

    // The interactive project chip is present, and the composer is scoped.
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();
    const input = page.getByRole('textbox', { name: 'Message input' });
    await expect(input).toHaveAttribute('placeholder', new RegExp(name));

    // Switch to a mock endpoint so the message streams without a real API key;
    // the project scope must be retained across the model switch.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();

    // Send the message; it streams a reply and the new chat opens at /c/:id.
    const response = await sendMessage(page, 'hello from a project');
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });

    // Expand the project in the sidebar and confirm the chat is filed under it.
    const projectRow = page.getByRole('button', { name }).first();
    if ((await projectRow.getAttribute('aria-expanded')) !== 'true') {
      await projectRow.click();
    }
    await expect(
      page.getByTestId(`project-chats-${projectId}`).getByTestId('convo-item').first(),
    ).toBeVisible();

    const conversationUrl = page.url();
    await page.reload({ timeout: 10000 });
    await expect(page).toHaveURL(conversationUrl);

    const reloadedProjectRow = page.getByRole('button', { name }).first();
    if ((await reloadedProjectRow.getAttribute('aria-expanded')) !== 'true') {
      await reloadedProjectRow.click();
    }
    await expect(
      page.getByTestId(`project-chats-${projectId}`).getByTestId('convo-item').first(),
    ).toBeVisible();
  });

  test('removes the project scope via the chip ×', async ({ page }) => {
    test.setTimeout(60000);
    const name = uniqueName('E2E Project');
    const projectId = await createProject(page, name);

    await page.goto(`/c/new?projectId=${projectId}`, { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();

    await page.getByRole('button', { name: 'Remove from project' }).click();

    // Chip disappears and the URL drops the project scope.
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('projectId'));
  });

  test('drops the project scope when the scoped project is deleted', async ({ page }) => {
    test.setTimeout(90000);
    const name = uniqueName('E2E Project');
    const projectId = await createProject(page, name);

    await page.goto(`/c/new?projectId=${projectId}`, { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();

    // Delete the scoped project from the sidebar while it is selected on the landing.
    const row = page.getByRole('button', { name, exact: true }).first();
    await expect(row).toBeVisible();
    const item = row.locator('..');
    await item.hover();
    await item.getByRole('button', { name: 'More options' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

    // The stale chip is gone, the URL drops the now-dead project scope, and the
    // composer reverts to an unscoped chat (placeholder no longer names the project).
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeHidden();
    await expect(page).toHaveURL((url) => !url.searchParams.has('projectId'));
    await expect(page.getByRole('textbox', { name: 'Message input' })).not.toHaveAttribute(
      'placeholder',
      new RegExp(name),
    );
  });

  test('switches the project via the chip combobox', async ({ page }) => {
    test.setTimeout(90000);
    const nameA = uniqueName('E2E Project A');
    const nameB = uniqueName('E2E Project B');
    await createProject(page, nameA);
    const projectIdA = new URL(page.url()).pathname.split('/projects/')[1];
    await createProject(page, nameB);
    const projectIdB = new URL(page.url()).pathname.split('/projects/')[1];

    await page.goto(`/c/new?projectId=${projectIdA}`, { timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Remove from project' })).toBeVisible();

    // Open the combobox and pick the other project.
    await page.locator('#project-landing-select').click();
    await page.getByRole('option', { name: nameB }).click();

    await expect(page).toHaveURL(new RegExp(`projectId=${projectIdB}`));
    await expect(page.getByRole('textbox', { name: 'Message input' })).toHaveAttribute(
      'placeholder',
      new RegExp(nameB),
    );
  });
});
