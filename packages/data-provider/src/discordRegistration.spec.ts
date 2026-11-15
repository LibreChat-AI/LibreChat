import { registerDiscordCommandsSchema, DISCORD_COMMAND_MANIFEST_VERSION } from './types/discord';

const input = {
  applicationId: '123456789012345678',
  expectedRevision: 'current-revision',
  manifestVersion: DISCORD_COMMAND_MANIFEST_VERSION,
};
it('requires explicit current manifest and application authority without browser credentials', () => {
  expect(registerDiscordCommandsSchema.parse(input)).toEqual(input);
  for (const change of [
    { applicationId: '0' },
    { expectedRevision: '' },
    { expectedRevision: '$ne' },
    { manifestVersion: '2' },
    { manifestVersion: undefined },
    { botToken: 'private-token' },
    { clientSecret: 'private-secret' },
  ])
    expect(registerDiscordCommandsSchema.safeParse({ ...input, ...change }).success).toBe(false);
});
