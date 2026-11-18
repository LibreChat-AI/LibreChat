import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { MOCK_ENDPOINTS, getAccessToken, requestJson } from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';

/**
 * The Slack Channels section of the Agent Builder. The harness has no Slack gateway and the feature
 * flag is off, so the flag, the channel list and the channel mutations are answered in the browser;
 * the rest is the real app. A PATCH or DELETE the page sends is recorded so a scenario can say what
 * a button did, and what it did not do before it was confirmed.
 */

test.use({ viewport: { width: 1280, height: 860 }, hasTouch: false, isMobile: false });

type Channel = Record<string, unknown>;
type Kind = 'active' | 'pending' | 'disabled';
type Call = { method: string; id: string; body: Record<string, unknown> };

const MANIFEST = {
  display_information: { name: 'Support Agent' },
  features: {
    bot_user: { display_name: 'support_agent' },
    agent_view: { agent_description: 'Answers support questions in Slack.' },
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
  },
  oauth_config: { scopes: { bot: ['app_mentions:read', 'chat:write', 'im:history'] } },
  settings: {
    socket_mode_enabled: false,
    event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};

async function openChannels(page: Page, kinds: Kind[]) {
  await page.goto('/c/new', { timeout: 10_000 });
  const token = await getAccessToken(page);
  const me = await requestJson<{ id?: string; _id?: string }>(page, { path: '/api/user', token });
  const userId = (me.id ?? me._id) as string;
  const name = uniqueAgentName('Channels agent');
  const agent = await requestJson<{ id: string }>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: 'Channels scenario agent',
      instructions: 'Help.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
    },
  });

  const slack = { teamId: 'T01TEAM', appId: 'A01ACTIVE', botUserId: 'U01BOT' };
  const make = (kind: Kind): Channel => ({
    channelId: `chan_${kind}`,
    agentId: agent.id,
    createdBy: userId,
    type: 'slack',
    status: { active: 'active', pending: 'pending_install', disabled: 'disabled' }[kind],
    credentialMode: kind === 'active' ? 'per_user' : 'shared',
    revision: `rev_${kind}_1`,
    ...(kind === 'pending' ? {} : { slack }),
  });
  const channels = kinds.map(make);
  const calls: Call[] = [];

  await page.route(
    (url) => url.pathname === '/api/endpoints',
    async (route) => {
      const response = await route.fetch();
      const json = await response.json();
      json.agents = { ...(json.agents ?? {}), channels: { enabled: true } };
      await route.fulfill({ response, json });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/channels/workspaces',
    (route) => route.fulfill({ json: { configured: false, canManage: false, workspaces: [] } }),
  );
  const prefix = `/api/agents/${agent.id}/channels`;
  await page.route(
    (url) => url.pathname.startsWith(prefix),
    async (route) => {
      const request = route.request();
      const rest = new URL(request.url()).pathname.slice(prefix.length).split('/').filter(Boolean);
      const method = request.method();
      if (method === 'GET' && rest.length === 0) {
        return route.fulfill({ json: channels });
      }
      if (method === 'GET' && rest[1] === 'manifest') {
        return route.fulfill({ json: MANIFEST });
      }
      const channel = channels.find((item) => item.channelId === rest[0]);
      if (method === 'PATCH' && channel) {
        const body = request.postDataJSON() as Record<string, unknown>;
        calls.push({ method, id: rest[0], body });
        if (body.status === 'disabled') {
          Object.assign(channel, { status: 'disabled', revision: `${rest[0]}_disabled` });
        } else if (body.credentialMode) {
          Object.assign(channel, { credentialMode: body.credentialMode, revision: 'rev_next' });
        } else if (body.slack) {
          Object.assign(channel, { status: 'active', slack });
        }
        return route.fulfill({ json: channel });
      }
      if (method === 'DELETE' && channel) {
        calls.push({ method, id: rest[0], body: {} });
        channels.splice(channels.indexOf(channel), 1);
        return route.fulfill({ status: 204, body: '' });
      }
      return route.fulfill({ json: channels[0] ?? {} });
    },
  );

  await page.reload();
  const form = await openAgentBuilder(page, { navigate: false });
  await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  const section = form
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Channels', exact: true }) });
  await expect(section).toBeVisible({ timeout: 10_000 });
  return { section, calls, cleanup: () => cleanupAgent(page, agent.id) };
}

const rowOf = (section: Locator, index: number) => section.locator('li').nth(index);
const dialogNamed = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true });
/** The wrapper that reveals a row's actions, whose paint is what a person sees. */
const paintedOpacity = (button: Locator) =>
  button.evaluate((element) => getComputedStyle(element.parentElement as HTMLElement).opacity);

test('the Channels section lists each connection with a status and hover only actions @scenario:channels-section-lists-connections-with-hover-actions', async ({
  page,
}) => {
  const { section, cleanup } = await openChannels(page, ['active', 'pending']);
  try {
    await expect(section.locator('li')).toHaveCount(2);
    await expect(rowOf(section, 0).getByText('Active')).toBeAttached();
    await expect(rowOf(section, 1).getByText('Pending installation')).toBeAttached();

    const setup = rowOf(section, 1).getByRole('button', { name: 'Setup', exact: true });
    const remove = rowOf(section, 1).getByRole('button', { name: 'Delete connection' });
    await page.mouse.move(0, 0);
    await expect.poll(() => paintedOpacity(setup)).toBe('0');
    await expect.poll(() => paintedOpacity(remove)).toBe('0');

    await rowOf(section, 1).hover();
    await expect.poll(() => paintedOpacity(setup)).toBe('1');
    await expect.poll(() => paintedOpacity(remove)).toBe('1');
  } finally {
    await cleanup();
  }
});

test('setting up a connection walks three steps and sends the credentials once @scenario:channel-setup-walks-three-steps-and-activates', async ({
  page,
}) => {
  const { section, calls, cleanup } = await openChannels(page, ['pending']);
  try {
    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Setup', exact: true }).click();
    const dialog = dialogNamed(page, 'Connect to Slack');
    const progress = dialog.getByRole('progressbar');
    await expect(progress).toHaveAttribute('aria-valuenow', '0');

    /** Step one: the prefilled link, and the manifest only as the collapsed fallback. */
    const create = dialog.getByRole('link', { name: /Create in Slack/ });
    await expect(create).toHaveAttribute('href', /api\.slack\.com\/apps\?new_app=1&manifest_json=/);
    await expect(
      dialog.getByRole('button', { name: 'Link not working? Paste the manifest manually' }),
    ).toHaveAttribute('aria-expanded', 'false');
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();

    /** Step two: nothing continues until the values are in. */
    await expect(progress).toHaveAttribute('aria-valuenow', '50');
    const next = dialog.getByRole('button', { name: 'Continue', exact: true });
    await expect(next).toBeDisabled();
    await dialog.getByLabel('Slack app ID').fill('A0TESTAPP');
    await dialog.getByLabel('Bot token').fill('xoxb-test-token');
    await dialog.getByLabel('Signing secret (required)').fill('test-signing-secret');
    await next.click();

    /** Step three: a summary that never shows the secret, then one write. */
    await expect(progress).toHaveAttribute('aria-valuenow', '100');
    await expect(dialog.getByText('A0TESTAPP')).toBeVisible();
    await expect(dialog.getByText('xoxb-test-token')).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Activate channel' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].body).toMatchObject({
      slack: { appId: 'A0TESTAPP', botToken: 'xoxb-test-token' },
    });
    await expect(dialog).not.toBeVisible();
  } finally {
    await cleanup();
  }
});

test('an active connection explains how to use the bot and keeps the manifest collapsed @scenario:channel-manage-explains-the-bot-and-collapses-the-manifest', async ({
  page,
}) => {
  const { section, cleanup } = await openChannels(page, ['active']);
  try {
    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Manage connection' }).click();
    const dialog = dialogNamed(page, 'Manage connection');
    await expect(
      dialog.getByRole('heading', { name: 'Use @support_agent in Slack' }),
    ).toBeVisible();
    await expect(dialog.getByText('/invite @support_agent')).toBeVisible();
    await expect(
      dialog.getByText('The first time, Slack asks you to link your account.'),
    ).toBeVisible();

    const toggle = dialog.getByRole('button', { name: 'Manifest', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(dialog.getByRole('textbox', { name: 'Manifest' })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(dialog.getByRole('textbox', { name: 'Manifest' })).toHaveValue(
      /"display_information"/,
    );
  } finally {
    await cleanup();
  }
});

test('changing who can use a connection needs it disabled first and then offers the cards @scenario:channel-identity-change-disables-first-then-offers-cards', async ({
  page,
}) => {
  const { section, calls, cleanup } = await openChannels(page, ['active']);
  try {
    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Manage connection' }).click();
    const dialog = dialogNamed(page, 'Manage connection');
    await dialog.getByRole('button', { name: 'Change identity mode' }).click();

    const confirm = dialogNamed(page, 'Disable to change who can use it?');
    await expect(confirm).toBeVisible();
    expect(calls).toHaveLength(0);
    await confirm.getByRole('button', { name: 'Disable and change' }).click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].body).toEqual({ status: 'disabled' });

    /** The same dialog now holds only the two cards, with the current mode chosen. */
    const cards = dialog.getByRole('radiogroup', { name: 'Who can use this connection?' });
    await expect(cards.getByRole('radio', { name: /Per-user accounts/ })).toBeChecked();
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();
    await cards.getByText('Channel owner only', { exact: true }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1].body).toEqual({ credentialMode: 'shared', revision: 'chan_active_disabled' });
  } finally {
    await cleanup();
  }
});

test('disabling and deleting a connection each ask first @scenario:channel-disable-and-delete-ask-for-confirmation', async ({
  page,
}) => {
  const { section, calls, cleanup } = await openChannels(page, ['active']);
  try {
    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Manage connection' }).click();
    const dialog = dialogNamed(page, 'Manage connection');
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click();
    const disable = dialogNamed(page, 'Disable this connection?');
    await disable.getByRole('button', { name: 'Cancel' }).click();
    await expect(disable).not.toBeVisible();
    expect(calls).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click();
    await dialogNamed(page, 'Disable this connection?')
      .getByRole('button', { name: 'Disable', exact: true })
      .click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', body: { status: 'disabled' } });
    await page.keyboard.press('Escape');

    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Delete connection' }).click();
    const remove = dialogNamed(page, 'Delete this connection?');
    await remove.getByRole('button', { name: 'Cancel' }).click();
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
    await rowOf(section, 0).hover();
    await rowOf(section, 0).getByRole('button', { name: 'Delete connection' }).click();
    await dialogNamed(page, 'Delete this connection?')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect.poll(() => calls.filter((call) => call.method === 'DELETE').length).toBe(1);
  } finally {
    await cleanup();
  }
});
