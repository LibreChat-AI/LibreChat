import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const enterTestKey = async (page: Page, endpoint: string) => {
  await page.getByTestId('new-conversation-menu').click();
  await page.getByTestId(`endpoint-item-${endpoint}`).hover({ force: true });
  await page.getByRole('button', { name: 'Set API Key' }).click();
  await page.getByTestId(`input-${endpoint}`).fill('test');
  await page.getByRole('button', { name: 'Submit' }).click();
  await page.getByTestId(`endpoint-item-${endpoint}`).click();
};

test.describe('Key suite', () => {
  // npx playwright test --config=e2e/playwright.config.local.ts --headed e2e/specs/keys.spec.ts
  test('Test Setting and Revoking Keys', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });
    const endpoint = 'openAI';

    const newTopicButton = page.getByTestId('new-conversation-menu');
    await newTopicButton.click();

    const endpointItem = page.getByTestId(`endpoint-item-${endpoint}`);
    await endpointItem.click();

    let setKeyButton = page.getByRole('button', { name: 'Set API key first' });

    expect(setKeyButton.count()).toBeTruthy();

    await enterTestKey(page, endpoint);

    const submitButton = page.getByTestId('submit-button');

    expect(submitButton.count()).toBeTruthy();

    await newTopicButton.click();

    await endpointItem.hover({ force: true });

    await page.getByRole('button', { name: 'Set API Key' }).click();
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Confirm Action' }).click();
    await page
      .locator('div')
      .filter({ hasText: /^Revoke$/ })
      .nth(1)
      .click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    setKeyButton = page.getByRole('button', { name: 'Set API key first' });
    expect(setKeyButton.count()).toBeTruthy();
  });

  test('Test Setting and Revoking Keys from Settings', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });
    const endpoint = 'openAI';

    const newTopicButton = page.getByTestId('new-conversation-menu');
    await newTopicButton.click();

    const endpointItem = page.getByTestId(`endpoint-item-${endpoint}`);
    await endpointItem.click();

    let setKeyButton = page.getByRole('button', { name: 'Set API key first' });

    expect(setKeyButton.count()).toBeTruthy();

    await enterTestKey(page, endpoint);

    const submitButton = page.getByTestId('submit-button');

    expect(submitButton.count()).toBeTruthy();

    await page.getByRole('button', { name: 'test' }).click();
    await page.getByText('Settings').click();
    await page.getByRole('tab', { name: 'Data controls' }).click();
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Confirm Action' }).click();

    const revokeButton = page.getByRole('button', { name: 'Revoke' });
    expect(revokeButton.count()).toBeTruthy();

    await page.getByRole('button', { name: 'Close' }).click();

    setKeyButton = page.getByRole('button', { name: 'Set API key first' });
    expect(setKeyButton.count()).toBeTruthy();
  });
});
