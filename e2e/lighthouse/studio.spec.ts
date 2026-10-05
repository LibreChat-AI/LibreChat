import { expect, test } from '@playwright/test';
import { auditPage, lcpElement } from './audit';

test('a restored Studio creation stays within web-vitals budgets', async ({ page }) => {
  await page.goto('/studio');
  await page
    .getByRole('textbox', { name: 'Describe what you want to create or change' })
    .fill('Lighthouse Studio image');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/threads\//);
  await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible({
    timeout: 30_000,
  });
  const url = page.url();
  const reports = await auditPage({ url, cookies: await page.context().cookies(), name: 'studio' });
  expect(reports).toHaveLength(3);
  for (const report of reports) {
    expect(report.finalDisplayedUrl).toBe(url);
    expect(lcpElement(report), 'The restored creation must paint, not merely the shell').toContain(
      '/api/media/assets/',
    );
  }
});
