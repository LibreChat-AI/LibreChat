import { channelConfigSchema, discordChannelConfigSchema } from './config';

it('keeps Discord disabled unless explicitly enabled and preserves Slack defaults', () => {
  expect(channelConfigSchema.parse({}).discord).toBeUndefined();
  expect(discordChannelConfigSchema.parse({}).enabled).toBe(false);
  expect(discordChannelConfigSchema.parse({ enabled: true })).toMatchObject({
    enabled: true,
    botPermissions: '274877975552',
    interactionTimeoutMs: 2000,
    rateLimits: { globalRequestsPerSecond: 50, maxQueued: 100 },
  });
});

it.each(['8', '274877975560', '18446744073709551616', 'abc', '-1', '1.5', ''])(
  'rejects unsafe permission set %s without throwing from its refinement',
  (botPermissions) => {
    expect(discordChannelConfigSchema.safeParse({ botPermissions }).success).toBe(false);
  },
);
it.each([
  { interactionTimeoutMs: 3000 },
  { rateLimits: { globalRequestsPerSecond: 51 } },
  { maxBodyBytes: 0 },
  { botToken: 'secret' },
])('rejects invalid policy %#', (input) => {
  expect(discordChannelConfigSchema.safeParse(input).success).toBe(false);
});
