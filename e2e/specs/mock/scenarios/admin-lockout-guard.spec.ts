import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openPanel } from './panels';

/**
 * Turning off "Allow using ..." for the ADMIN role hides the feature, and the Admin Settings entry
 * point with it, from every admin, and no screen can turn it back on. The shared Admin Settings
 * dialog warns inline once that switch is off and holds the save behind a confirmation that needs
 * the word ADMIN typed in. Every save is answered by the spec, so the run's ADMIN role never
 * changes and the specs sharing this database keep their Marketplace and Prompts access.
 */
test.describe.configure({ timeout: 60_000 });

type Save = { url: string; body: Record<string, boolean> };

const SAVED = 'Saved!';
const SAVE_FAILED = 'There was an error saving your admin settings.';

/** Answers the permission save for any role with `status`, and records what the dialog sent. */
async function answerSaves(page: Page, feature: string, status = 200): Promise<Save[]> {
  const saves: Save[] = [];
  await page.route(`**/api/roles/*/${feature}`, async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') {
      await route.fallback();
      return;
    }
    saves.push({ url: request.url(), body: request.postDataJSON() as Record<string, boolean> });
    await route.fulfill({ status, json: { message: status === 200 ? 'Updated' : 'Rejected' } });
  });
  return saves;
}

async function openMarketplaceSettings(page: Page): Promise<Locator> {
  await page.goto('/agents/all', { timeout: 15000 });
  await page.getByRole('button', { name: 'Admin Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin Settings - Marketplace' });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  return dialog;
}

async function openPromptsSettings(page: Page): Promise<Locator> {
  await page.goto('/c/new', { timeout: 15000 });
  await openPanel(page, 'prompts', 'Prompts');
  await page.getByRole('button', { name: 'Admin Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Admin Settings - Prompts' });
  await expect(dialog).toBeVisible({ timeout: 15000 });
  return dialog;
}

/** The dialog opens on USER; the role menu sits inside it and takes a mouse pick. */
async function pickRole(page: Page, dialog: Locator, role: 'ADMIN' | 'USER'): Promise<void> {
  const trigger = dialog.locator('button[aria-haspopup="menu"]');
  if ((await trigger.innerText()).trim() !== role) {
    await trigger.click();
    await page.getByRole('menuitem', { name: role, exact: true }).click();
  }
  await expect(trigger).toHaveText(role);
}

function lockoutConfirmation(page: Page, feature: string) {
  const dialog = page.getByRole('alertdialog', { name: `Turn off ${feature} for admins?` });
  return {
    dialog,
    input: dialog.getByLabel('Type ADMIN to confirm'),
    confirm: dialog.getByRole('button', { name: 'Turn Off for Admins' }),
    cancel: dialog.getByRole('button', { name: 'Cancel' }),
  };
}

/** Turns the ADMIN role's Marketplace switch off and presses Save, which opens the confirmation. */
async function startMarketplaceLockout(page: Page, dialog: Locator): Promise<void> {
  await pickRole(page, dialog, 'ADMIN');
  const use = dialog.getByRole('switch', { name: 'Allow using Marketplace' });
  await expect(use).toBeChecked();
  await use.click();
  await expect(use).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Save' }).click();
}

test.describe('revoking the ADMIN role from Admin Settings', () => {
  test('the warning shows once the switch is off and waits for Save @scenario:admin-use-off-warns-before-save', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'marketplace');
    const dialog = await openMarketplaceSettings(page);
    await pickRole(page, dialog, 'ADMIN');

    const use = dialog.getByRole('switch', { name: 'Allow using Marketplace' });
    const warning = dialog.getByRole('alert');
    await expect(use).toBeChecked();
    await expect(warning).toHaveCount(0);

    await use.click();
    await expect(use).not.toBeChecked();
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('Marketplace');
    await expect(warning).toContainText('every admin');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await use.click();
    await expect(use).toBeChecked();
    await expect(warning).toHaveCount(0);
    expect(saves).toHaveLength(0);
  });

  test('Save needs ADMIN typed in before it sends anything @scenario:admin-lockout-needs-typed-confirmation', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'marketplace');
    const dialog = await openMarketplaceSettings(page);
    await startMarketplaceLockout(page, dialog);

    const { dialog: confirmation, input, confirm } = lockoutConfirmation(page, 'Marketplace');
    await expect(confirmation).toBeVisible();
    await expect(input).toBeFocused();
    await expect(confirm).toBeDisabled();
    expect(saves).toHaveLength(0);

    await input.fill('admin');
    await expect(confirm).toBeDisabled();
    await input.fill('ADMIN');
    await expect(confirm).toBeEnabled();
    expect(saves).toHaveLength(0);

    await input.press('Enter');
    await expect.poll(() => saves.length).toBe(1);
    expect(new URL(saves[0].url).pathname).toBe('/api/roles/ADMIN/marketplace');
    expect(saves[0].body).toMatchObject({ USE: false });

    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(SAVED, { exact: true })).toBeVisible();
  });

  test('cancelling the confirmation saves nothing and clears what was typed @scenario:admin-lockout-cancel-saves-nothing', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'marketplace');
    const dialog = await openMarketplaceSettings(page);
    await startMarketplaceLockout(page, dialog);

    const {
      dialog: confirmation,
      input,
      confirm,
      cancel,
    } = lockoutConfirmation(page, 'Marketplace');
    await input.fill('ADMIN');
    await expect(confirm).toBeEnabled();
    await cancel.click();
    await expect(confirmation).toHaveCount(0);

    const use = dialog.getByRole('switch', { name: 'Allow using Marketplace' });
    await expect(dialog).toBeVisible();
    await expect(use).not.toBeChecked();
    await expect(dialog.getByRole('alert')).toBeVisible();

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(confirmation).toBeVisible();
    await expect(input).toHaveValue('');
    await expect(confirm).toBeDisabled();

    await page.keyboard.press('Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeVisible();
    expect(saves).toHaveLength(0);
  });

  test('a rejected save leaves the dialog open to retry @scenario:admin-lockout-failed-save-stays-open', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'marketplace', 500);
    const dialog = await openMarketplaceSettings(page);
    await startMarketplaceLockout(page, dialog);

    const { dialog: confirmation, input, confirm } = lockoutConfirmation(page, 'Marketplace');
    await input.fill('ADMIN');
    await confirm.click();
    await expect.poll(() => saves.length).toBe(1);

    /** The toast sits outside the modal dialog, which hides it from role queries while open */
    await expect(page.getByText(SAVE_FAILED, { exact: true })).toBeVisible();
    await expect(confirmation).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'Allow using Marketplace' })).not.toBeChecked();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  test('another role saves a switched-off feature without the confirmation @scenario:other-role-use-off-saves-directly', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'marketplace');
    const dialog = await openMarketplaceSettings(page);
    await pickRole(page, dialog, 'USER');

    const use = dialog.getByRole('switch', { name: 'Allow using Marketplace' });
    if (await use.isChecked()) {
      await use.click();
    }
    await expect(use).not.toBeChecked();
    await expect(dialog.getByRole('alert')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => saves.length).toBe(1);
    expect(new URL(saves[0].url).pathname).toBe('/api/roles/USER/marketplace');
    expect(saves[0].body).toMatchObject({ USE: false });
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(dialog).toBeHidden();
  });

  test('the Prompts dialog asks once, on Save, with the same typed confirmation @scenario:prompts-lockout-uses-typed-confirmation', async ({
    page,
  }) => {
    const saves = await answerSaves(page, 'prompts');
    const dialog = await openPromptsSettings(page);
    await pickRole(page, dialog, 'ADMIN');

    const use = dialog.getByRole('switch', { name: 'Allow using Prompts' });
    await expect(use).toBeChecked();
    await use.click();
    await expect(use).not.toBeChecked();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Save' }).click();
    const { dialog: confirmation, input, confirm, cancel } = lockoutConfirmation(page, 'Prompts');
    await expect(confirmation).toBeVisible();
    await expect(confirm).toBeDisabled();
    await input.fill('ADMIN');
    await expect(confirm).toBeEnabled();
    await cancel.click();
    await expect(confirmation).toHaveCount(0);
    expect(saves).toHaveLength(0);
  });
});
