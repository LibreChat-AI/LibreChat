import { expect, test } from '@playwright/test';
import type { MediaPreset } from 'librechat-data-provider';
import { mediaFixtureURL } from '../../setup/media';
import { uniqueName } from './helpers';
import { expectAccessible } from './accessibility';

test('a saved preset restores an uploaded reference after reload', async ({ page }) => {
  let presetId: string | undefined;
  try {
    await page.goto('/studio');
    const prompt = page.getByRole('textbox', {
      name: 'Describe what you want to create or change',
    });
    await expect(prompt).toBeVisible();
    const generated = await page.request.post(`${mediaFixtureURL}/v1/images/generations`, {
      data: {},
    });
    const image = (await generated.json()).data[0].b64_json as string;
    await page.locator('input[type=file]').setInputFiles({
      name: 'preset-reference.png',
      mimeType: 'image/png',
      buffer: Buffer.from(image, 'base64'),
    });
    await expect(page.getByRole('button', { name: 'Remove reference', exact: true })).toBeVisible();
    await prompt.fill('Keep this draft prompt');
    await page.getByRole('button', { name: 'Manage', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Presets', exact: true });
    const title = uniqueName('Reference preset');
    await dialog.getByRole('textbox', { name: 'Preset name', exact: true }).fill(title);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/media/presets',
    );
    await dialog.getByRole('button', { name: 'Save current settings', exact: true }).click();
    const preset = (await (await saved).json()) as MediaPreset;
    presetId = preset.presetId;
    expect(preset.settings.inputs).toHaveLength(1);
    expect(preset.assets).toHaveLength(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remove reference', exact: true }).click();
    await page.reload();
    const picker = page.getByRole('combobox', { name: 'Presets', exact: true });
    const option = page.getByRole('option', { name: title, exact: true, includeHidden: true });
    await picker.click();
    await option.click();
    await expect(option).toBeHidden();
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
    await expect(picker).toBeFocused();
    await expect(prompt).toHaveValue('Keep this draft prompt');
    await expect(page.getByRole('button', { name: 'Remove reference', exact: true })).toBeVisible();
    const restored = page.getByRole('img', { name: 'Image preview', exact: true });
    await expect(restored).toHaveAttribute('src', new RegExp(preset.assets[0].file_id));
    await expectAccessible(page);
  } finally {
    if (presetId) await page.request.delete(`/api/media/presets/${encodeURIComponent(presetId)}`);
  }
});

test('a comparison creates two durable outputs in one restored thread', async ({ page }) => {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Comparison model', exact: true })).toBeVisible();
  const before = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  await page
    .getByRole('textbox', { name: 'Describe what you want to create or change' })
    .fill(uniqueName('Compare observatories'));
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original', exact: true })).toHaveCount(2);
  const after = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  expect(after.submissions).toBe(before.submissions + 2);
  await page.reload();
  await expect(page.getByRole('link', { name: 'Download original', exact: true })).toHaveCount(2);
  await expectAccessible(page);
});

test('a temporary creation restores its status and prevents chat reuse', async ({ page }) => {
  await page.goto('/studio');
  await page.getByRole('button', { name: 'Temporary creation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Describe what you want to create or change' })
    .fill(uniqueName('Temporary observatory'));
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use in chat', exact: true })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Use in chat', exact: true })).toBeDisabled();
  await expectAccessible(page);
});
