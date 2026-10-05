import { expect, test } from '@playwright/test';
import type { AgentDetail } from './agents.helpers';
import { cleanupAgent, openAgentBuilder, selectMockModel, uniqueAgentName } from './agents.helpers';
import { messagesView, sendMessageAndWaitForCompletion } from './helpers';

for (const kind of ['image', 'video'] as const) {
  test(`an agent creates ${kind} and reopens its durable Studio result`, async ({ page }) => {
    test.slow();
    let agentId: string | undefined;
    try {
      let form = await openAgentBuilder(page);
      const createNew = form.getByRole('button', { name: 'Create New Agent' });
      if (await createNew.isVisible()) await createNew.click();
      const name = uniqueAgentName(`${kind} creator`);
      await form.getByLabel('Agent name').fill(name);
      await form
        .getByLabel('Agent description')
        .fill(`Creates ${kind} through the configured media tool.`);
      await form
        .getByLabel('Instructions')
        .fill(`Use the configured media tool when asked to create ${kind}.`);
      await selectMockModel(page, true);
      form = page.getByRole('form', { name: 'Agent configuration form' });
      await form.getByRole('button', { name: 'Add tools' }).click();
      const library = page.getByRole('dialog', { name: 'Tool Library' });
      await library.getByRole('textbox', { name: 'Search tools…' }).fill('Create media');
      const tool = library.getByRole('button', { name: /^Create media/ });
      await tool.click();
      await expect(tool).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/agents' &&
          response.status() === 201,
      );
      await form.getByRole('button', { name: 'Create', exact: true }).click();
      const agent = (await (await created).json()) as AgentDetail;
      agentId = agent.id;
      expect(agent.tools).toContain('media_generate');
      await form.getByRole('button', { name: 'Select Agent', exact: true }).click();
      await sendMessageAndWaitForCompletion(
        page,
        `E2E_MEDIA_${kind.toUpperCase()}:observatory-${Date.now()}`,
        {
          timeout: 60_000,
        },
      );
      const messages = messagesView(page);
      await expect(
        messages.getByText(kind === 'image' ? 'E2E media image ready' : 'E2E media video queued', {
          exact: true,
        }),
      ).toBeVisible();
      if (kind === 'image')
        await expect(messages.locator('img[src*="/api/media/assets/"]').first()).toBeVisible();
      const studio = messages.getByRole('link', { name: 'Open creation', exact: true });
      await expect(studio).toBeVisible();
      const threadPath = await studio.getAttribute('href');
      await page.reload();
      if (kind === 'image')
        await expect(messages.locator('img[src*="/api/media/assets/"]').first()).toBeVisible();
      await expect(
        messages.getByRole('link', { name: 'Open creation', exact: true }),
      ).toHaveAttribute('href', threadPath!);
      await messages.getByRole('link', { name: 'Open creation', exact: true }).click();
      await expect(page).toHaveURL(/\/studio\/threads\//);
      await expect(
        page.getByRole('link', { name: 'Download original', exact: true }),
      ).toBeVisible();
      if (kind === 'video') {
        const video = page
          .getByTestId('media-transcript')
          .getByLabel('Video preview', { exact: true });
        await expect(video).toBeVisible();
        await expect
          .poll(() => video.evaluate((node: HTMLVideoElement) => node.readyState))
          .toBeGreaterThanOrEqual(2);
      }
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
}
