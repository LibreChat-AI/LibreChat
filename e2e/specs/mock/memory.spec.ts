import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  enableMemory,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/**
 * The memory feature is enabled in e2e/config/librechat.e2e.yaml, which grants
 * the MEMORIES.USE permission and exposes the ephemeral memory badge (the inline
 * set_memory/delete_memory tools). This spec drives the badge end to end: enable
 * it from the tools menu, then confirm the toggle reaches the backend payload as
 * `ephemeralAgent.memory === true` on the next send.
 */
test.describe('memory badge', () => {
  test('toggles on from the tools menu and is sent with the request', async ({ page }) => {
    test.setTimeout(120000);
    await page.goto('/c/new', { timeout: 10000 });

    // Mock Provider A is a custom endpoint, so the ephemeral badge row is shown.
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);

    await enableMemory(page);
    await expect(
      page.getByTestId('composer-active-builtin').filter({ hasText: 'Memory' }),
    ).toBeVisible();

    const memoryRequest = page.waitForRequest(
      (request) => request.url().includes('/api/agents/chat') && request.method() === 'POST',
    );

    const response = await sendMessage(page, 'remember that I prefer tea over coffee');
    expect(response.ok()).toBeTruthy();

    const request = await memoryRequest;
    const body = request.postDataJSON() as { ephemeralAgent?: { memory?: boolean } };
    expect(body.ephemeralAgent?.memory).toBe(true);

    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
  });
});
