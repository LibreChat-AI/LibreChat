import { expect, test } from '@playwright/test';
import type { SlackWorkspace } from 'librechat-data-provider';
import { openSidebar } from './sidebar';

test.use({ viewport: { width: 1280, height: 960 }, hasTouch: false, isMobile: false });

// Browser coverage of the real popup and OAuth settlement protocol. Slack and workspace
// HTTP responses are fixtures; database ownership and callback authorization have integration tests.
for (const theme of ['light', 'dark']) {
  test(`organization Slack installation, cancellation and disconnect (${theme})`, async ({
    page,
    context,
    baseURL,
  }) => {
    let workspaces: SlackWorkspace[] = [];
    let attempt = 0;
    let cancelled = 0;
    let disconnected = 0;
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    await context.route('https://slack.com/oauth/v2/authorize**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Slack OAuth test boundary</title>' }),
    );
    await page.route('**/api/channels/workspaces**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/connect')) {
        attempt++;
        await route.fulfill({
          json: {
            url: `https://slack.com/oauth/v2/authorize?state=attempt-${attempt}`,
            flowId: `attempt-${attempt}`,
            expiresInSeconds: 600,
          },
        });
        return;
      }
      if (route.request().method() === 'DELETE') {
        if (url.pathname.includes('/attempts/')) cancelled++;
        else {
          disconnected++;
          workspaces = workspaces.map((workspace) => ({ ...workspace, status: 'disconnected' }));
        }
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ json: { configured: true, canManage: true, workspaces } });
    });
    await page.goto('/c/new');
    await openSidebar(page);
    await page.getByTestId('nav-user').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('tab', { name: 'Account', exact: true }).click();
    const workspacesPanel = settings.getByRole('region', { name: 'Organization Slack workspaces' });
    await expect(workspacesPanel.getByText('No Slack workspaces are connected.')).toBeVisible();
    const cancelledPopup = context.waitForEvent('page');
    await workspacesPanel
      .getByRole('button', { name: 'Connect a Slack workspace', exact: true })
      .click();
    const first = await cancelledPopup;
    await expect(first).toHaveURL(/slack\.com\/oauth\/v2\/authorize/);
    await workspacesPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(workspacesPanel.getByRole('status')).toHaveCount(0);
    expect(cancelled).toBe(1);
    await first.close();
    const popupPromise = context.waitForEvent('page');
    await workspacesPanel
      .getByRole('button', { name: 'Connect a Slack workspace', exact: true })
      .click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(/slack\.com\/oauth\/v2\/authorize/);
    workspaces = [
      {
        workspaceId: 'workspace-browser',
        appId: 'A123',
        teamId: 'T123',
        teamName: 'Example engineering',
        botUserId: 'U123',
        status: 'active',
        revision: 'installed',
        scopes: [],
      },
    ];
    await popup.goto(`${baseURL}/oauth/success?serverName=Slack&flow=attempt-2`);
    await expect(workspacesPanel.getByText('Example engineering')).toBeVisible();
    await expect(workspacesPanel.getByText('Connected', { exact: true })).toBeVisible();
    if (process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX) {
      await workspacesPanel.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `${process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX}-${theme}.png`,
      });
    }
    await workspacesPanel
      .getByRole('button', { name: 'Disconnect workspace', exact: true })
      .click();
    expect(disconnected).toBe(0);
    await workspacesPanel
      .getByRole('group')
      .getByRole('button', {
        name: 'Disconnect workspace',
        exact: true,
      })
      .click();
    await expect(workspacesPanel.getByText('Disconnected', { exact: true })).toBeVisible();
    expect(disconnected).toBe(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#prompt-textarea')).toBeVisible();
  });
}
