import { buildSlackChannelManifest } from './manifest';

const binding = { name: 'Test Agent', tenantId: 'tenant-a', channelId: 'channel-a' };

it('declares only bot capabilities used by channels, without public ingress in Socket Mode', () => {
  const manifest = buildSlackChannelManifest(binding);
  expect(manifest.settings.socket_mode_enabled).toBe(true);
  expect(manifest.settings.interactivity).toEqual({ is_enabled: true });
  expect(manifest.settings.event_subscriptions).toEqual({
    bot_events: ['app_mention', 'reaction_added', 'reaction_removed'],
  });
  expect(manifest.oauth_config.scopes.bot).toEqual([
    'app_mentions:read',
    'chat:write',
    'reactions:read',
    'reactions:write',
    'files:write',
    'im:write',
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
