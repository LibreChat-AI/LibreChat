import type { DiscordChannelRunActor } from './types/channelRuns';
import type { DiscordAgentChannel } from './types/channels';
import {
  channelRunActorSchema,
  channelSnowflakeSchema,
  sameChannelRunActor,
  channelExternalIdentitySchema,
  sameChannelExternalIdentity,
  channelActorMatchesChannel,
} from './channelProvider';

const slack = { teamId: 'T1', appId: 'A1', externalUserId: 'U1' };
const discord: DiscordChannelRunActor = {
  provider: 'discord',
  applicationId: '123456789012345678',
  guildId: '234567890123456789',
  externalUserId: '345678901234567890',
};
const common = {
  tenantId: 'tenant',
  channelId: 'channel',
  channelRevision: 'revision',
  agentId: 'agent',
};

it('preserves the exact untagged Slack actor and identity shapes', () => {
  expect(channelRunActorSchema.parse(slack)).toStrictEqual(slack);
  const identity = { ...common, teamId: slack.teamId, externalUserId: slack.externalUserId };
  expect(channelExternalIdentitySchema.parse(identity)).toStrictEqual(identity);
});

it('retains Discord snowflakes losslessly in provider-specific identities', () => {
  expect(channelRunActorSchema.parse(discord)).toStrictEqual(discord);
  expect(channelExternalIdentitySchema.parse({ ...common, ...discord })).toStrictEqual({
    ...common,
    ...discord,
  });
  expect(channelSnowflakeSchema.parse('18446744073709551615')).toBe('18446744073709551615');
});

it.each(['0', '01', '-1', '1.5', '1e10', ' 123', '18446744073709551616', 123, null])(
  'rejects an invalid snowflake %p',
  (value) => expect(channelSnowflakeSchema.safeParse(value).success).toBe(false),
);

it.each([
  { ...slack, provider: 'slack' },
  { ...slack, provider: 'discord' },
  { ...slack, applicationId: discord.applicationId },
  { ...discord, teamId: 'T1' },
  { ...discord, appId: 'A1' },
  { ...discord, provider: undefined },
  { ...discord, provider: 'unknown' },
])('rejects mixed or untagged provider actor %p', (actor) => {
  expect(channelRunActorSchema.safeParse(actor).success).toBe(false);
});

it.each([
  { ...common, ...discord, teamId: 'T1' },
  { ...common, ...discord, guildId: undefined },
  { ...common, ...discord, applicationId: undefined },
  { ...common, ...discord, provider: undefined },
])('rejects incomplete or mixed identity %p', (identity) => {
  expect(channelExternalIdentitySchema.safeParse(identity).success).toBe(false);
});

it('compares the complete provider scope and external actor', () => {
  expect(sameChannelRunActor(slack, { ...slack })).toBe(true);
  expect(sameChannelRunActor(discord, { ...discord })).toBe(true);
  expect(sameChannelRunActor(slack, discord)).toBe(false);
  expect(sameChannelRunActor(discord, slack)).toBe(false);
  for (const field of ['applicationId', 'guildId', 'externalUserId'] as const)
    expect(sameChannelRunActor(discord, { ...discord, [field]: '456789012345678901' })).toBe(false);
  for (const field of ['teamId', 'appId', 'externalUserId'] as const)
    expect(sameChannelRunActor(slack, { ...slack, [field]: 'other' })).toBe(false);
});

it('binds consent equality to provider, scope, actor and all channel authority fields', () => {
  const identity = { ...common, ...discord };
  expect(sameChannelExternalIdentity(identity, { ...identity })).toBe(true);
  for (const field of [
    'tenantId',
    'channelId',
    'channelRevision',
    'agentId',
    'applicationId',
    'guildId',
    'externalUserId',
  ] as const)
    expect(sameChannelExternalIdentity(identity, { ...identity, [field]: 'different' })).toBe(
      false,
    );
  expect(
    sameChannelExternalIdentity(identity, {
      ...common,
      teamId: discord.guildId,
      externalUserId: discord.externalUserId,
    }),
  ).toBe(false);
});

it('matches a Discord actor only to its canonical application and guild', () => {
  const channel: DiscordAgentChannel = {
    channelId: 'channel',
    agentId: 'agent',
    createdBy: 'owner',
    revision: 'revision',
    status: 'active',
    type: 'discord',
    credentialMode: 'per_user',
    discord: {
      applicationId: discord.applicationId,
      guildId: discord.guildId,
      botUserId: '456789012345678901',
    },
  };
  expect(channelActorMatchesChannel(channel, discord)).toBe(true);
  expect(channelActorMatchesChannel(channel, slack)).toBe(false);
  expect(channelActorMatchesChannel({ ...channel, discord: undefined }, discord)).toBe(false);
  expect(channelActorMatchesChannel(channel, { ...discord, guildId: '567890123456789012' })).toBe(
    false,
  );
});
