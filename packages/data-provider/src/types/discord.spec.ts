import { configureDiscordApplicationSchema, discordPublicKeySchema } from './discord';

it('requires initial credentials and accepts revision-bound partial rotations', () => {
  const input = { applicationId: '123456789012345678' };
  expect(configureDiscordApplicationSchema.safeParse(input).success).toBe(false);
  expect(
    configureDiscordApplicationSchema.parse({
      ...input,
      botToken: ' bot ',
      clientSecret: ' secret ',
    }),
  ).toEqual({ ...input, botToken: 'bot', clientSecret: 'secret' });
  expect(
    configureDiscordApplicationSchema.safeParse({
      ...input,
      expectedRevision: 'one',
      botToken: 'new',
    }).success,
  ).toBe(true);
});

it.each(['0', '18446744073709551616', '1e5', 123])(
  'rejects invalid application ID %s',
  (applicationId) => {
    expect(
      configureDiscordApplicationSchema.safeParse({
        applicationId,
        botToken: 'token',
        clientSecret: 'secret',
      }).success,
    ).toBe(false);
  },
);

it('rejects unknown browser fields and malformed interaction keys', () => {
  expect(
    configureDiscordApplicationSchema.safeParse({
      applicationId: '1',
      botToken: 'token',
      clientSecret: 'secret',
      tenantId: 'foreign',
    }).success,
  ).toBe(false);
  expect(discordPublicKeySchema.safeParse('a'.repeat(64)).success).toBe(true);
  expect(discordPublicKeySchema.safeParse('x'.repeat(64)).success).toBe(false);
});
