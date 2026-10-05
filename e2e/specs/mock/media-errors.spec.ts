import { expect, test } from '@playwright/test';
import { mediaFixtureURL } from '../../setup/media';
import { uniqueName } from './helpers';
import { expectAccessible } from './accessibility';

test('failed generation lazily shows the persisted provider response after reload on desktop and mobile', async ({
  page,
}, testInfo) => {
  const message = 'Async process failed with the following error: The task field is not supported.';
  const requests: string[] = [];
  const isDiagnostics = (url: string) =>
    /^\/api\/media\/jobs\/[^/]+\/diagnostics$/.test(new URL(url).pathname);
  page.on('request', (request) => {
    if (isDiagnostics(request.url())) requests.push(request.url());
  });

  await page.goto('/studio');
  const prompt = page.getByRole('textbox', { name: 'Describe what you want to create or change' });
  await prompt.fill(uniqueName('E2E_MEDIA_PROVIDER_REJECTION: observatory'));
  const before = await (await page.request.get(`${mediaFixtureURL}/counts`)).json();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  const transcript = page.getByTestId('media-transcript');
  const alert = transcript.getByRole('alert').filter({
    hasText: 'The provider rejected this request. Check your prompt and settings.',
  });
  await expect(alert).toBeVisible({ timeout: 20_000 });
  await expect(transcript.getByRole('status').filter({ hasText: 'Failed' })).toBeVisible();
  const disclosure = alert.getByRole('button', { name: 'Provider response', exact: true });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(requests).toHaveLength(0);
  await expect(alert.getByText(message, { exact: true })).toHaveCount(0);

  const response = page.waitForResponse((result) => isDiagnostics(result.url()));
  await disclosure.focus();
  await page.keyboard.press('Enter');
  const details = await response;
  expect(details.status()).toBe(200);
  expect(await details.json()).toEqual({
    diagnostic: {
      status: 400,
      code: 'FAILED_PRECONDITION',
      message,
      requestId: 'e2e-media-provider-rejection',
    },
  });
  await expect(alert.getByText(message, { exact: true })).toBeVisible();
  await expect(alert.getByText('400', { exact: true })).toBeVisible();
  await expect(alert.getByText('FAILED_PRECONDITION', { exact: true })).toBeVisible();
  await expect(alert.getByText('e2e-media-provider-rejection', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  await page.mouse.move(0, 0);
  await expectAccessible(page);

  await page.reload();
  await expect(alert).toBeVisible();
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  expect(requests).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('close-sidebar-button')).toHaveCount(0);
  const restoredResponse = page.waitForResponse((result) => isDiagnostics(result.url()));
  await disclosure.click();
  expect((await restoredResponse).status()).toBe(200);
  await expect(alert.getByText(message, { exact: true })).toBeVisible();
  await expect(alert.getByText('400', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect((await (await page.request.get(`${mediaFixtureURL}/counts`)).json()).submissions).toBe(
    before.submissions + 1,
  );
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expectAccessible(page);
  await page.screenshot({
    path: testInfo.outputPath('media-provider-response-mobile.png'),
    fullPage: true,
  });
});
