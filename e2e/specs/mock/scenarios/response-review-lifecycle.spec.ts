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
  test(`owner tool review preserves the exact batch through uncertain acknowledgement (${mode})`, async ({
    page,
  }) => {
    const acknowledgement = Promise.withResolvers<void>();
    const decisions: object[] = [];
    const review = {
      responseId: 'resp_tool_browser',
      status: 'in_progress',
      oauth: [],
      canSubmitDecision: true,
      pendingAction: {
        actionId: 'tools-browser',
        expiresAt: Date.now() + 120_000,
        payload: {
          type: 'tool_approval',
          action_requests: [
            { name: 'write_file', arguments: { path: 'old.ts' }, tool_call_id: 'edit-call' },
            { name: 'delete_file', arguments: { path: 'keep.ts' }, tool_call_id: 'reject-call' },
          ],
          review_configs: [
            { action_name: 'write_file', tool_call_id: 'edit-call', allowed_decisions: ['edit'] },
            {
              action_name: 'delete_file',
              tool_call_id: 'reject-call',
              allowed_decisions: ['reject'],
            },
          ],
        },
      },
    };
    await page.addInitScript((theme) => localStorage.setItem('color-theme', theme), mode);
    await page.route('**/api/agents/responses/resp_tool_browser/**', async (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ json: review });
      decisions.push(route.request().postDataJSON());
      if (decisions.length === 1) {
        await acknowledgement.promise;
        return route.fulfill({ status: 503, json: { error: 'response_service_unavailable' } });
      }
      return route.fulfill({
        json: {
          responseId: review.responseId,
          actionId: review.pendingAction.actionId,
          intentId: 'saved-browser-intent',
          status: 'queued',
        },
      });
    });
    try {
      await page.goto('/responses/resp_tool_browser/review');
      const first = page.getByTestId('tool-approval').nth(0);
      const second = page.getByTestId('tool-approval').nth(1);
      await first.getByRole('button', { name: 'Edit', exact: true }).click();
      await first
        .getByRole('textbox', { name: 'Edit', exact: true })
        .fill('{"path":"new.ts","nested":{"safe":true}}');
      await second.getByRole('button', { name: 'Reject', exact: true }).click();
      await second
        .getByRole('textbox', { name: 'Reject', exact: true })
        .fill('Keep the existing file.');
      await page.getByRole('button', { name: /^Submit/ }).click();
      await expect.poll(() => decisions.length).toBe(1);
      const expected = {
        actionId: 'tools-browser',
        decisions: [
          {
            tool_call_id: 'edit-call',
            decision: 'edit',
            editedArguments: { path: 'new.ts', nested: { safe: true } },
          },
          { tool_call_id: 'reject-call', decision: 'reject', reason: 'Keep the existing file.' },
        ],
      };
      expect(decisions[0]).toEqual(expected);
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Submitting/ })).toBeDisabled();
      acknowledgement.resolve();
      await expect(page.getByRole('alert')).toBeVisible();
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => decisions.length).toBe(2);
      expect(decisions[1]).toEqual(expected);
      await expect(page.getByRole('status').filter({ hasText: /decision was received/i })).toBeVisible();
    } finally {
      acknowledgement.resolve();
    }
  });
}
