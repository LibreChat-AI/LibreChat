import { expect, test } from '@playwright/test';
import type { Response } from '@playwright/test';
import { getPrimaryE2EUser } from '../../setup/users.mock';
import { clearUserPasskeys, seedPasskey } from './db';
import { NEW_CHAT_PATH } from './helpers';

const PASSKEY_NAME = 'Work laptop';
const RENAMED_PASSKEY_NAME = 'Office security key';
const CREDENTIAL_ID = 'e2e-passkey-settings-flow';

const responseMatches = (method: string) => (response: Response) =>
  response.request().method() === method &&
  new URL(response.url()).pathname.startsWith('/api/auth/passkey/');

test.describe('account settings passkeys', () => {
  const user = getPrimaryE2EUser();

  test.beforeEach(async () => {
    await clearUserPasskeys(user.email);
    await seedPasskey(user.email, CREDENTIAL_ID, PASSKEY_NAME);
  });

  test.afterEach(async () => {
    await clearUserPasskeys(user.email);
  });

  test('keeps add and delete dialogs separate, accessible, and correctly layered', async ({
    page,
  }) => {
    test.setTimeout(60000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();

    const settingsDialog = page.getByRole('dialog', { name: /Settings/ });
    await settingsDialog.getByRole('tab', { name: 'Account' }).click();
    await settingsDialog.getByRole('button', { name: 'Passkeys', exact: true }).click();

    const passkeysDialog = page.getByRole('dialog', { name: 'Passkeys', exact: true });
    await expect(passkeysDialog).toBeVisible();
    await expect(passkeysDialog.getByText(PASSKEY_NAME, { exact: true })).toBeVisible();

    const addButton = passkeysDialog.getByRole('button', { name: 'Add passkey' });
    await addButton.click();

    const addDialog = page.getByRole('dialog', { name: 'Add passkey', exact: true });
    const addPassword = addDialog.getByLabel('Confirm your password');
    await expect(addDialog).toBeVisible();
    expect(
      await addDialog.evaluate(
        (dialog) => dialog.parentElement?.closest('[role="dialog"]') == null,
      ),
    ).toBe(true);
    await expect(addPassword).toBeFocused();
    await expect(addDialog.getByRole('button', { name: 'Show secret' })).toBeVisible();

    await addDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(addDialog).toBeHidden();
    await expect(addButton).toBeFocused();

    const passkeyItem = passkeysDialog.getByTestId('passkey-item');
    const compactRowBox = await passkeyItem.boundingBox();
    expect(compactRowBox).not.toBeNull();
    expect(compactRowBox?.height).toBeLessThanOrEqual(60);

    const renameButton = passkeysDialog.getByRole('button', { name: 'Rename passkey' });
    await renameButton.click();

    const nameInput = passkeysDialog.getByRole('textbox', { name: 'Passkey name' });
    const saveButton = passkeysDialog.getByRole('button', { name: 'Save' });
    const cancelButton = passkeysDialog.getByRole('button', { name: 'Cancel' });
    for (const control of [nameInput, saveButton, cancelButton]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.height).toBe(40);
    }
    expect((await saveButton.boundingBox())?.width).toBe(40);
    expect((await cancelButton.boundingBox())?.width).toBe(40);

    await saveButton.hover();
    await expect(page.getByRole('tooltip', { name: 'Save' })).toBeVisible();
    await cancelButton.hover();
    await expect(page.getByRole('tooltip', { name: 'Cancel' })).toBeVisible();

    await cancelButton.click();
    await expect(renameButton).toBeFocused();
    await expect(passkeysDialog.getByText(PASSKEY_NAME, { exact: true })).toBeVisible();

    await renameButton.click();
    await nameInput.fill(RENAMED_PASSKEY_NAME);
    const renameResponsePromise = page.waitForResponse(responseMatches('PATCH'));
    await saveButton.click();
    expect((await renameResponsePromise).status()).toBe(200);
    await expect(passkeysDialog.getByText(RENAMED_PASSKEY_NAME, { exact: true })).toBeVisible();

    const passkeysZIndex = await passkeysDialog.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    const removeButton = passkeysDialog.getByRole('button', { name: 'Remove passkey' });
    await removeButton.hover();
    await expect(page.getByRole('tooltip', { name: 'Remove passkey' })).toBeVisible();
    await removeButton.click();

    const deleteDialog = page.getByRole('alertdialog', {
      name: `Remove “${RENAMED_PASSKEY_NAME}”?`,
    });
    const deletePassword = deleteDialog.getByLabel('Confirm your password');
    const deleteButton = deleteDialog.getByRole('button', { name: 'Delete' });
    await expect(deleteDialog).toBeVisible();
    await expect(deletePassword).toBeFocused();
    await expect(deleteDialog.getByRole('button', { name: 'Show secret' })).toBeVisible();
    await expect(
      deleteDialog.getByText(
        'Removing a passkey takes away a way to sign in, so we need your password first.',
      ),
    ).toHaveCount(0);
    await expect(deleteButton).toHaveClass(/bg-surface-destructive/);

    const deleteZIndex = await deleteDialog.evaluate((element) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10),
    );
    const deletePortalZIndex = await deleteDialog.evaluate((element) =>
      Number.parseInt(getComputedStyle(element.parentElement as HTMLElement).zIndex, 10),
    );
    expect(deleteZIndex).toBeGreaterThan(passkeysZIndex);
    expect(deletePortalZIndex).toBeGreaterThan(passkeysZIndex);

    await deletePassword.fill('wrong password');
    const rejectedDeletePromise = page.waitForResponse(responseMatches('DELETE'));
    await deleteButton.click();
    expect((await rejectedDeletePromise).status()).toBe(403);
    await expect(deleteDialog.getByRole('alert')).toHaveText(
      'Incorrect password. Please try again.',
    );
    await expect(deletePassword).toBeFocused();

    await deletePassword.fill(user.password);
    const successfulDeletePromise = page.waitForResponse(responseMatches('DELETE'));
    await deleteButton.click();
    expect((await successfulDeletePromise).status()).toBe(200);
    await expect(deleteDialog).toBeHidden();
    await expect(passkeysDialog.getByTestId('passkey-item')).toHaveCount(0);
    await expect(passkeysDialog.getByText('You have not added any passkeys yet')).toBeVisible();
  });
});
