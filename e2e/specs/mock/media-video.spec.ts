import { expect, test } from '@playwright/test';
import { mediaFixtureURL } from '../../setup/media';
import { uniqueName } from './helpers';
import { expectAccessible } from './accessibility';

test('video generation restores playable originals with authenticated range downloads', async ({
  page,
}) => {
  await page.goto('/studio');
  await page.getByRole('radio', { name: 'Video', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Describe what you want to create or change' });
  await prompt.fill(uniqueName('Orbiting observatory'));
  const before = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  const video = page.getByTestId('media-transcript').getByLabel('Video preview', { exact: true });
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(2);
  expect(await video.evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  const after = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  expect(after.submissions).toBe(before.submissions + 1);
  const original = await video.getAttribute('src');
  expect(original).toContain('/api/media/assets/');
  const ranged = await page.request.get(original!, { headers: { Range: 'bytes=0-31' } });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()['content-type']).toContain('video/mp4');
  expect(ranged.headers()['content-range']).toMatch(/^bytes 0-31\//);
  expect((await ranged.body()).length).toBe(32);
  await expect(page.getByRole('link', { name: 'Download original', exact: true })).toBeVisible();
  await page.reload();
  await expect(video).toHaveAttribute('src', original!);
  await expect
    .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
    .toBeGreaterThanOrEqual(2);
  await page.mouse.move(0, 0);
  await expectAccessible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('close-sidebar-button')).toHaveCount(0);
  await prompt.click();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(video).toBeVisible();
  await expectAccessible(page);
});
