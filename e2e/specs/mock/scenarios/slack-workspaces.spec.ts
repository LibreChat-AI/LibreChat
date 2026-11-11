import type {
  SlackWorkspace,
  AgentChannel,
  SlackWorkspaceRouteTarget,
} from 'librechat-data-provider';
import type { AgentDetail } from '../agents.helpers';
import { openAgentBuilder, cleanupAgent } from '../agents.helpers';
import { MOCK_ENDPOINTS, getAccessToken, requestJson } from '../helpers';
import { appURL } from '../../../setup/authenticate';
import { expect, test } from '../fixtures';
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
    let registered = false;
    let attempt = 0;
    let cancelled = 0;
    let disconnected = 0;
    let searches = 0;
    let legacySearches = 0;
    await page.route('**/api/permissions/search-principals**', (route) => {
      legacySearches++;
      return route.fulfill({ status: 403, json: { error: 'forbidden' } });
    });
    let managers: Array<{ id: string; name: string; email: string }> = [];
    const manager = {
      id: '000000000000000000000002',
      name: 'Alex Morgan',
      email: 'alex@example.com',
    };
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    if (theme === 'light')
      await context.addInitScript(() =>
        Object.defineProperty(window, 'BroadcastChannel', { value: undefined, configurable: true }),
      );
    await context.route('https://slack.com/oauth/v2/authorize**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Slack OAuth test boundary</title>' }),
    );
    await page.route('**/api/channels/workspaces**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/managers/search')) {
        expect(url.searchParams.get('q')).toBe('alex');
        if (searches++ === 0) {
          await route.fulfill({ status: 503, json: { error: 'unavailable' } });
          return;
        }
        await route.fulfill({ json: [manager] });
        return;
      }
      if (url.pathname.endsWith('/managers')) {
        if (route.request().method() === 'PUT') {
          expect(route.request().postDataJSON()).toEqual({
            revision: 'installed',
            userIds: [manager.id],
          });
          managers = [manager];
          workspaces = workspaces.map((workspace) => ({
            ...workspace,
            revision: 'managers-updated',
          }));
          await route.fulfill({ json: { revision: 'managers-updated' } });
        } else
          await route.fulfill({
            json: { revision: workspaces[0].revision, managers, maxManagers: 50 },
          });
        return;
      }
      if (url.pathname.endsWith('/apps')) {
        if (route.request().method() === 'PUT') {
          expect(route.request().postDataJSON()).toMatchObject({
            appId: 'A123',
            clientId: '123.456',
            clientSecret: 'test-client',
            signingSecret: 'test-signature',
          });
          registered = true;
          await route.fulfill({ json: { appId: 'A123', clientId: '123.456', revision: 'r1' } });
        } else
          await route.fulfill({
            json: {
              configured: true,
              canManage: true,
              apps: registered ? [{ appId: 'A123', clientId: '123.456', revision: 'r1' }] : [],
              setup: {
                redirectUri: 'https://chat.example/api/channels/workspaces/oauth/callback',
                eventsBaseUrl: 'https://gateway.example/slack/events',
                interactionsBaseUrl: 'https://gateway.example/slack/interactions',
              },
            },
          });
        return;
      }
      if (url.pathname.endsWith('/workspace-browser/remove')) {
        expect(route.request().method()).toBe('POST');
        expect(route.request().postDataJSON()).toEqual({ revision: 'managers-updated' });
        workspaces = [];
        await route.fulfill({ status: 204 });
        return;
      }
      if (url.pathname.endsWith('/connect')) {
        expect(route.request().postDataJSON()).toMatchObject({ appId: 'A123' });
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
          expect(route.request().postDataJSON()).toEqual({ revision: 'managers-updated' });
          disconnected++;
          workspaces = workspaces.map((workspace) => ({ ...workspace, status: 'disconnected' }));
        }
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({
        json: { configured: true, canManage: true, workspaces },
      });
    });
    await page.goto('/c/new');
    await openSidebar(page);
    await page.getByTestId('nav-user').filter({ visible: true }).first().click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('tab', { name: 'Account', exact: true }).click();
    const slackSection = settings.getByRole('region', { name: 'Slack', exact: true });
    await slackSection.getByRole('button', { name: 'Set up', exact: true }).click();
    const workspacesPanel = page.getByRole('dialog', { name: 'Manage Slack', exact: true });
    await expect(workspacesPanel.getByText('No Slack apps registered yet.')).toBeVisible();
    await workspacesPanel.getByRole('button', { name: 'Add Slack app', exact: true }).click();
    const appForm = page.getByRole('dialog', { name: 'Add Slack app', exact: true });
    await appForm.getByLabel('Slack app ID', { exact: true }).fill('A123');
    await appForm.getByLabel('Client ID', { exact: true }).fill('123.456');
    await appForm.getByLabel('Client secret (Unset)', { exact: true }).fill('test-client');
    await appForm.getByLabel('Signing secret (Unset)', { exact: true }).fill('test-signature');
    await appForm.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(appForm).not.toBeVisible();
    const cancelledPopup = context.waitForEvent('page');
    await workspacesPanel.getByRole('button', { name: 'Add to workspace', exact: true }).click();
    const first = await cancelledPopup;
    await expect(first).toHaveURL(/slack\.com\/oauth\/v2\/authorize/);
    const connecting = page.getByRole('dialog', { name: 'Connecting to Slack…', exact: true });
    await connecting.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(connecting).not.toBeVisible();
    expect(cancelled).toBe(1);
    await first.close();
    const popupPromise = context.waitForEvent('page');
    await workspacesPanel.getByRole('button', { name: 'Add to workspace', exact: true }).click();
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
        animations: 'disabled',
        path: `${process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX}-${theme}.png`,
      });
    }
    await workspacesPanel
      .getByRole('button', {
        name: 'Manage access for Example engineering (workspace-browser)',
        exact: true,
      })
      .click();
    const access = page.getByRole('dialog', { name: 'Manage bot access', exact: true });
    await expect(access.getByRole('combobox', { name: 'Add a bot manager' })).toBeVisible();
    await access.getByRole('combobox', { name: 'Add a bot manager' }).fill('alex');
    await expect(
      access.getByText('Could not search your organization’s users. Try again.'),
    ).toBeVisible();
    await expect(access.getByText('No results found', { exact: true })).toHaveCount(0);
    if (process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX)
      await page.screenshot({
        animations: 'disabled',
        path: `${process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX}-search-error-${theme}.png`,
      });
    await access.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(
      page.getByRole('listbox').getByRole('option', { name: /Alex Morgan/ }),
    ).toBeVisible();
    await page
      .getByRole('listbox')
      .getByRole('option', { name: /Alex Morgan/ })
      .click();
    await expect(access.getByText('Alex Morgan', { exact: true })).toBeVisible();
    if (process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX)
      await page.screenshot({
        animations: 'disabled',
        path: `${process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX}-managers-${theme}.png`,
      });
    await access.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(access).not.toBeVisible();
    expect(managers).toEqual([manager]);
    expect(legacySearches).toBe(0);
    expect(searches).toBe(2);
    await workspacesPanel
      .getByRole('button', {
        name: 'Manage access for Example engineering (workspace-browser)',
        exact: true,
      })
      .click();
    await expect(access.getByText('Alex Morgan', { exact: true })).toBeVisible();
    await access.getByRole('button', { name: 'Cancel', exact: true }).click();
    await workspacesPanel
      .getByRole('button', {
        name: 'Disconnect Example engineering (workspace-browser)',
        exact: true,
      })
      .click();
    expect(disconnected).toBe(0);
    await page
      .getByRole('dialog', { name: 'Disconnect workspace', exact: true })
      .getByRole('button', {
        name: 'Disconnect workspace',
        exact: true,
      })
      .click();
    await expect(workspacesPanel.getByText('Disconnected', { exact: true })).toBeVisible();
    expect(disconnected).toBe(1);
    await workspacesPanel
      .getByRole('button', { name: 'Remove Example engineering (workspace-browser)', exact: true })
      .click();
    const removal = page.getByRole('dialog', { name: 'Remove workspace', exact: true });
    await expect(removal.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(removal).not.toBeVisible();
    await expect(
      workspacesPanel.getByRole('button', {
        name: 'Remove Example engineering (workspace-browser)',
        exact: true,
      }),
    ).toBeFocused();
    await workspacesPanel
      .getByRole('button', { name: 'Remove Example engineering (workspace-browser)', exact: true })
      .click();
    await expect(removal).toContainText('This does not uninstall the app from Slack.');
    await expect(
      removal.getByRole('button', { name: 'Remove workspace', exact: true }),
    ).toHaveCount(1);
    if (process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX) {
      await removal.scrollIntoViewIfNeeded();
      await page.screenshot({
        animations: 'disabled',
        path: `${process.env.E2E_SLACK_WORKSPACES_VISUAL_PREFIX}-remove-${theme}.png`,
      });
    }
    await removal.getByRole('button', { name: 'Remove workspace', exact: true }).click();
    await expect(workspacesPanel.getByText('Example engineering')).toHaveCount(0);
    await expect(
      workspacesPanel.getByRole('button', { name: 'Add to workspace', exact: true }),
    ).toBeVisible();
    await expect(workspacesPanel).toBeFocused();
    await workspacesPanel.getByRole('button', { name: 'Close', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#prompt-textarea')).toBeVisible();
  });
}

// Exercises the production Agent Builder/connection components with a real saved agent.
// Installation/channel HTTP is the boundary fixture; storage and permissions have API tests.
for (const theme of ['light', 'dark']) {
  test(`organization workspace agent setup, replacement and removal (${theme})`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error('Workspace setup requires the app URL');
    await page.addInitScript((mode) => localStorage.setItem('color-theme', mode), theme);
    await page.route('**/api/endpoints', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      config.agents = { ...config.agents, channels: { enabled: true } };
      await route.fulfill({ response, json: config });
    });
    const workspace: SlackWorkspace = {
      canManageBot: true,
      workspaceId: 'workspace-browser',
      appId: 'A123',
      teamId: 'T123',
      teamName: 'Engineering',
      botUserId: 'U123',
      status: 'active',
      revision: 'installation-browser',
      scopes: [],
    };
    await page.route('**/api/channels/workspaces**', async (route) => {
      const detail = new URL(route.request().url()).pathname.endsWith('/workspace-browser');
      await route.fulfill({
        json: {
          configured: true,
          canManage: false,
          ...(detail ? { workspace } : { workspaces: [workspace] }),
        },
      });
    });
    await page.goto(appURL(baseURL, 'c/new'));
    const token = await getAccessToken(page);
    const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;
    const agent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token,
      method: 'POST',
      body: {
        name: 'Slack workspace assistant',
        description: 'Workspace setup browser acceptance.',
        instructions: 'Keep this test deterministic.',
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
      },
    });
    let channels: AgentChannel[] = [];
    let routes: SlackWorkspaceRouteTarget[] = [];
    let occupied = true;
    let routeRevision: string | undefined = 'observed-other-agent';
    let assigned = false;
    let activations = 0,
      removed = 0,
      disabled = 0,
      deleted = 0;
    const channelId = 'workspace-channel-browser';
    await page.route(`**/api/agents/${agent.id}/channels**`, async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      if (url.pathname.endsWith('/workspace-connections')) {
        expect(request.postDataJSON()).toEqual({ workspaceId: workspace.workspaceId });
        channels = [
          {
            channelId,
            agentId: agent.id,
            createdBy: userId,
            type: 'slack',
            credentialMode: 'per_user',
            workspaceId: workspace.workspaceId,
            status: 'pending_install',
            revision: 'pending-browser',
          },
        ];
        await route.fulfill({ status: 201, json: channels[0] });
        return;
      }
      if (url.pathname.endsWith('/workspace-routes')) {
        if (method === 'POST') {
          expect(request.postDataJSON()).toEqual({
            channelRevision: 'pending-browser',
            expectedRevision: 'observed-other-agent',
          });
          activations++;
          assigned = true;
          occupied = true;
          routeRevision = 'owned-route';
          routes = [{ revision: routeRevision }];
          channels = [{ ...channels[0], status: 'active', revision: 'active-browser' }];
          await route.fulfill({ json: channels[0] });
          return;
        }
        if (method === 'DELETE') {
          expect(request.postDataJSON()).toEqual({ expectedRevision: 'owned-route' });
          removed++;
          routes = [];
          assigned = false;
          occupied = false;
          routeRevision = undefined;
          await route.fulfill({ status: 204 });
          return;
        }
        await route.fulfill({
          json: url.searchParams.has('target')
            ? {
                canReplace: true,
                assignedAgentName: occupied ? 'Research Assistant' : undefined,
                occupied,
                assignedToThisChannel: assigned,
                revision: routeRevision,
              }
            : { routes },
        });
        return;
      }
      if (method === 'PATCH') {
        expect(request.postDataJSON()).toEqual({ status: 'disabled' });
        disabled++;
        channels = [{ ...channels[0], status: 'disabled', revision: 'disabled-browser' }];
        await route.fulfill({ json: channels[0] });
        return;
      }
      if (method === 'DELETE') {
        deleted++;
        channels = [];
        await route.fulfill({ status: 204 });
        return;
      }
      await route.fulfill({ json: channels });
    });
    try {
      const form = await openAgentBuilder(page, { navigate: false });
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agent.name!, exact: true }).click();
      await expect(form.getByLabel('Agent name')).toHaveValue(agent.name!);
      await form
        .getByRole('button', { name: 'Add Slack channel', exact: true })
        .scrollIntoViewIfNeeded();
      await form.getByRole('button', { name: 'Add Slack channel', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Add Slack channel', exact: true });
      const botPicker = picker.getByRole('combobox', { name: 'Slack bot', exact: true });
      await expect(botPicker).toBeVisible();
      if (process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX)
        await page.screenshot({
          animations: 'disabled',
          path: `${process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX}-choose-${theme}.png`,
        });
      await botPicker.click();
      await page.getByRole('option', { name: /Engineering.*A123/ }).click();
      await picker.getByRole('button', { name: 'Continue', exact: true }).click();
      const setup = page.getByRole('dialog', { name: 'Connect to Slack', exact: true });
      await expect(
        setup.getByRole('button', { name: 'Replace default agent', exact: true }),
      ).toBeEnabled();
      await expect(
        setup.getByRole('heading', { name: 'Current assignments', exact: true }),
      ).toHaveCount(0);
      await expect(
        setup.getByRole('button', { name: 'Delete connection', exact: true }),
      ).toHaveCount(0);
      await expect(setup.getByLabel('Bot token', { exact: true })).toHaveCount(0);
      if (process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX)
        await page.screenshot({
          animations: 'disabled',
          path: `${process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX}-target-${theme}.png`,
        });
      await setup.getByRole('button', { name: 'Replace default agent', exact: true }).click();
      const replacement = page.getByRole('dialog', {
        name: 'Replace Research Assistant?',
        exact: true,
      });
      expect(activations).toBe(0);
      if (process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX)
        await page.screenshot({
          animations: 'disabled',
          path: `${process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX}-replacement-${theme}.png`,
        });
      await replacement.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(replacement).toHaveCount(0);
      await expect(
        setup.getByRole('button', { name: 'Replace default agent', exact: true }),
      ).toBeFocused();
      await setup.getByRole('button', { name: 'Replace default agent', exact: true }).click();
      await replacement.getByRole('button', { name: 'Replace default agent', exact: true }).click();
      await expect(setup).toHaveCount(0);
      expect(activations).toBe(1);
      await expect(form.getByText('Active', { exact: true })).toBeVisible();
      await form.getByRole('button', { name: 'Manage connection', exact: true }).click();
      const manage = page.getByRole('dialog', { name: 'Manage connection', exact: true });
      await expect(manage.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
      await expect(
        manage.getByRole('heading', { name: 'Current assignments', exact: true }),
      ).toBeVisible();
      await expect(manage.getByRole('button', { name: 'Add assignment', exact: true })).toHaveCount(
        0,
      );
      await expect(
        manage.getByRole('group', { name: 'Where this bot uses this agent', exact: true }),
      ).toHaveCount(0);
      await expect(manage.getByRole('button', { name: 'Assign agent', exact: true })).toHaveCount(
        0,
      );
      if (process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX)
        await page.screenshot({
          animations: 'disabled',
          path: `${process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX}-active-${theme}.png`,
        });
      await manage.getByRole('button', { name: 'Remove', exact: true }).click();
      expect(removed).toBe(0);
      const removal = page.getByRole('dialog', { name: 'Remove assignment', exact: true });
      if (process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX)
        await page.screenshot({
          animations: 'disabled',
          path: `${process.env.E2E_SHARED_WORKSPACE_VISUAL_PREFIX}-remove-${theme}.png`,
        });
      await removal.getByRole('button', { name: 'Remove assignment', exact: true }).click();
      await expect(manage.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0);
      await expect(
        manage.getByRole('heading', { name: 'Current assignments', exact: true }),
      ).toHaveCount(0);
      await expect(
        manage.getByRole('button', { name: 'Add assignment', exact: true }),
      ).toBeFocused();
      expect(removed).toBe(1);
      await manage.getByRole('button', { name: 'Disable', exact: true }).click();
      await expect(form.getByText('Disabled', { exact: true })).toBeVisible();
      expect(disabled).toBe(1);
      await form.getByRole('button', { name: 'Manage connection', exact: true }).click();
      await manage.getByRole('button', { name: 'Delete connection', exact: true }).click();
      expect(deleted).toBe(0);
      await page
        .getByRole('dialog', { name: 'Delete connection', exact: true })
        .getByRole('button', { name: 'Delete connection', exact: true })
        .click();
      await expect(
        form.getByRole('button', { name: 'Manage connection', exact: true }),
      ).toHaveCount(0);
      expect(deleted).toBe(1);
      await expect(form.getByLabel('Agent name')).toHaveValue(agent.name!);
    } finally {
      await cleanupAgent(page, agent.id);
    }
  });
}
