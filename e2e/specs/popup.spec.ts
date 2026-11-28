import { expect, test } from '@playwright/test';

test.describe('Endpoints Presets suite', () => {
  test('Endpoints Suite', async ({ page }) => {
    await page.goto('/', { timeout: 5000 });
    await page.getByTestId('new-conversation-menu').click();

    // includes the icon + endpoint names in obj property
    const endpointItem = page.getByRole('menuitemradio', { name: 'ChatGPT OpenAI' });
    await endpointItem.click();

    await page.getByTestId('new-conversation-menu').click();
    // Check if the active class is set on the selected endpoint
    expect(await endpointItem.getAttribute('class')).toContain('active');
  });
});
