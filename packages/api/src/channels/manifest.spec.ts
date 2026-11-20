import { buildSlackChannelManifest } from './manifest';

const binding = { name: 'Test Agent', tenantId: 'tenant-a', channelId: 'channel-a' };

it.each(['socket_mode', 'webhook'] as const)(
  'installs the DM and native Stop capabilities consumed by the %s gateway',
  (transport) => {
    const manifest = buildSlackChannelManifest({
      ...binding,
      transport,
      gatewayUrl: 'https://gateway.example',
    });
    expect(manifest.oauth_config.scopes.bot).toContain('im:history');
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['message.im', 'agent_session_stopped']),
    );
    expect(manifest.features).toMatchObject({
      agent_view: { agent_description: 'Test Agent' },
      app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    });
  },
);

it('produces valid Slack display and bot names for long, Unicode and punctuated Agent titles', () => {
  for (const name of ['An Agent With Spaces!', '界'.repeat(100), 'x'.repeat(100), '   ']) {
    const manifest = buildSlackChannelManifest({ ...binding, name });
    expect([...manifest.display_information.name].length).toBeGreaterThan(0);
    expect([...manifest.display_information.name].length).toBeLessThanOrEqual(35);
    expect(manifest.features.bot_user.display_name).toMatch(/^[a-z0-9._-]{1,80}$/);
  }
});

it('declares only bot capabilities used by channels, without public ingress in Socket Mode', () => {
  const manifest = buildSlackChannelManifest(binding);
  expect(manifest.settings.socket_mode_enabled).toBe(true);
  expect(manifest.settings.interactivity).toEqual({ is_enabled: true });
  expect(manifest.settings.event_subscriptions).toEqual({
    bot_events: [
      'app_mention',
      'message.im',
      'agent_session_stopped',
      'reaction_added',
      'reaction_removed',
    ],
  });
  expect(manifest.oauth_config.scopes.bot).toEqual([
    'app_mentions:read',
    'chat:write',
    'reactions:read',
    'reactions:write',
    'files:write',
    'im:write',
    'im:history',
  ]);
  expect(JSON.stringify(manifest)).not.toMatch(/users:read|channels:history|user_scope/);
});

it('binds both signed HTTP routes to the same exact configured channel', () => {
  const manifest = buildSlackChannelManifest({
    ...binding,
    transport: 'webhook',
    gatewayUrl: 'https://gateway.example/base/',
  });
  expect(manifest.settings.socket_mode_enabled).toBe(false);
  expect(manifest.settings.event_subscriptions.request_url).toBe(
    'https://gateway.example/base/slack/events/tenant-a/channel-a',
  );
  expect(manifest.settings.interactivity.request_url).toBe(
    'https://gateway.example/base/slack/interactions/tenant-a/channel-a',
  );
});

it.each([
  undefined,
  'http://gateway.example',
  'https://user:pass@gateway.example',
  'https://gateway.example?token=secret',
  'https://gateway.example#fragment',
])('rejects unsafe or absent webhook URL %s', (gatewayUrl) => {
  expect(() =>
    buildSlackChannelManifest({ ...binding, transport: 'webhook', gatewayUrl }),
  ).toThrow();
});
