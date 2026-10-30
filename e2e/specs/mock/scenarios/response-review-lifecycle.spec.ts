import { expect, test } from '@playwright/test';

/** Real authenticated page and React lifecycle, with the response provider boundary controlled. */
test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

for (const mode of ['light', 'dark']) {
  test(`owner review retains a draft during failed polling (${mode})`, async ({ page }) => {
    let unavailable = false;
    let writes = 0;
    const review = {
      responseId: 'resp_browser',
      status: 'in_progress',
      oauth: [],
      canSubmitDecision: true,
      pendingAction: {
        actionId: 'question-browser',
        expiresAt: Date.now() + 120_000,
        payload: {
          type: 'ask_user_question',
          question: {
            question: 'Which environment should this task use?',
            options: [{ label: 'Staging', value: 'staging' }],
          },
        },
      },
    };
    await page.addInitScript((theme) => localStorage.setItem('color-theme', theme), mode);
    await page.route('**/api/auth/refresh', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await route.continue();
    });
    await page.route('**/api/agents/responses/resp_browser/**', async (route) => {
      if (route.request().method() !== 'GET') {
        writes++;
        await route.fulfill({ json: { id: 'resp_browser', status: 'in_progress' } });
      } else {
        await route.fulfill(
          unavailable ? { status: 503, json: { error: 'unavailable' } } : { json: review },
        );
      }
    });
    await page.goto('/responses/resp_browser/review');
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/responses/resp_browser/review');
    const draft = page.getByRole('textbox');
    await expect(draft).toBeEnabled();
    await draft.fill('Use staging and retain this draft while reconnecting.');
    unavailable = true;
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 7000 });
    await expect(draft).toHaveValue('Use staging and retain this draft while reconnecting.');
    await expect(draft).toBeDisabled();
    expect(writes).toBe(0);
    if (process.env.E2E_REVIEW_VISUAL_PREFIX) {
      await page.screenshot({ path: `${process.env.E2E_REVIEW_VISUAL_PREFIX}-${mode}.png` });
    }
    unavailable = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('Use staging and retain this draft while reconnecting.');
    expect(writes).toBe(0);
    await page.getByRole('button', { name: /Stop/, exact: false }).click();
    await expect(draft).toBeDisabled();
    expect(writes).toBe(1);
    await expect(page.getByRole('button', { name: /Stop/, exact: false })).toBeDisabled();
  });
}
