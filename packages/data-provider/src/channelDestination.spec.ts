import {
  channelRunAdmissionSchema,
  sameDiscordNativeDestination,
  discordNativeAuthoritySchema,
  discordRunEffectAuthoritySchema,
} from './channelDestination';
import {
  discordGuildTextActorSourceSchema,
  discordGuildTextActorUsable,
  discordMessageSubmissionSchema,
} from './types/discordMessage';
import {
  channelRunActorSchema,
  sameChannelRunActor,
  channelActorMatchesChannel,
} from './channelProvider';

const slack = { teamId: 'T', appId: 'A', externalUserId: 'U' };
const guild = {
  provider: 'discord' as const,
  applicationId: '123',
  guildId: '234',
  externalUserId: '345',
};
const dm = {
  provider: 'discord' as const,
  scope: 'dm' as const,
  applicationId: '123',
  externalUserId: '345',
  selectionId: 'selection',
  selectionRevision: 'generation',
};
const destination = {
  kind: 'dm' as const,
  parentChannelId: '456',
  selectionId: 'selection',
  selectionRevision: 'generation',
};
const admission = {
  eventId: '678',
  externalChannelId: '789',
  externalThreadKey: '789:567',
  externalMessageKey: '789:678',
  actor: dm,
  input: 'hello',
  discordDestination: destination,
};
const owner = {
  applicationId: '123',
  applicationRevision: 'app-revision',
  ownerId: 'a'.repeat(32),
};
const source = {
  kind: 'guild_text' as const,
  applicationId: '123',
  botUserId: '567',
  guildId: '234',
  channelId: '456',
  permissions: '68608',
  authorId: '345',
  authorMember: true as const,
  authorPermissions: '1024',
};
it('preserves untagged Slack and unscoped Discord guild wire shapes', () => {
  expect(channelRunActorSchema.parse(slack)).toStrictEqual(slack);
  expect(channelRunActorSchema.parse(guild)).toStrictEqual(guild);
  for (const actor of [slack, guild]) {
    const { discordDestination, ...legacy } = { ...admission, actor };
    expect(discordDestination).toEqual(destination);
    expect(channelRunAdmissionSchema.parse(legacy)).toStrictEqual(legacy);
  }
});
it('requires an explicit DM generation without a fabricated guild identity', () => {
  expect(channelRunActorSchema.parse(dm)).toStrictEqual(dm);
  expect(channelRunAdmissionSchema.parse(admission)).toStrictEqual(admission);
  for (const actor of [
    { ...dm, guildId: '234' },
    { ...dm, teamId: 'T' },
    { ...dm, scope: undefined },
    { ...dm, selectionId: undefined },
  ])
    expect(channelRunActorSchema.safeParse(actor).success).toBe(false);
  for (const change of [
    { discordDestination: undefined },
    { discordDestination: { ...destination, selectionRevision: 'other' } },
    {
      discordDestination: {
        kind: 'guild_thread',
        parentChannelId: '456',
        mappingRevision: 'mapping',
      },
    },
    { externalChannelId: destination.parentChannelId },
    { actor: slack },
    { actor: guild },
  ])
    expect(channelRunAdmissionSchema.safeParse({ ...admission, ...change }).success).toBe(false);
  expect(sameChannelRunActor(dm, { ...dm })).toBe(true);
  expect(sameChannelRunActor(dm, guild)).toBe(false);
  expect(sameChannelRunActor(dm, { ...dm, selectionRevision: 'other' })).toBe(false);
});
it('binds thread metadata and native equality to the exact parent and generation', () => {
  const thread = {
    kind: 'guild_thread' as const,
    parentChannelId: '456',
    mappingRevision: 'mapping',
  };
  expect(
    channelRunAdmissionSchema.safeParse({ ...admission, actor: guild, discordDestination: thread })
      .success,
  ).toBe(true);
  expect(
    channelRunAdmissionSchema.safeParse({ ...admission, actor: slack, discordDestination: thread })
      .success,
  ).toBe(false);
  expect(sameDiscordNativeDestination(undefined, undefined)).toBe(true);
  expect(sameDiscordNativeDestination(undefined, destination)).toBe(false);
  expect(
    sameDiscordNativeDestination(destination, { ...destination, selectionRevision: 'other' }),
  ).toBe(false);
  expect(sameDiscordNativeDestination(thread, { ...thread, mappingRevision: 'other' })).toBe(false);
});
it('keeps DM actors closed to the existing guild channel matcher until selection authority is joined', () => {
  const channel = {
    type: 'discord' as const,
    channelId: 'channel',
    agentId: 'agent',
    createdBy: 'user',
    revision: 'revision',
    status: 'active' as const,
    credentialMode: 'per_user' as const,
    installationId: 'install',
    installationRevision: 'install-revision',
    discord: { applicationId: '123', guildId: '234', botUserId: '567', externalChannelId: '456' },
  };
  expect(channelActorMatchesChannel(channel, guild)).toBe(true);
  expect(channelActorMatchesChannel(channel, dm)).toBe(false);
});
it('requires fresh actor membership and visibility as well as bot permissions', () => {
  expect(discordGuildTextActorUsable(source)).toBe(true);
  expect(discordGuildTextActorUsable({ ...source, authorPermissions: '0' })).toBe(false);
  expect(discordGuildTextActorUsable({ ...source, permissions: '1024' })).toBe(false);
  expect(
    discordGuildTextActorSourceSchema.safeParse({ ...source, authorMember: false }).success,
  ).toBe(false);
  const legacy = {
    kind: 'guild_text',
    applicationId: '123',
    botUserId: '567',
    guildId: '234',
    channelId: '456',
    permissions: '68608',
  };
  expect(discordGuildTextActorSourceSchema.safeParse(legacy).success).toBe(false);
  const event = {
    ...owner,
    kind: 'message',
    shardId: 0,
    sequence: 1,
    messageId: '678',
    channelId: '456',
    guildId: '234',
    authorId: '345',
    content: 'hello',
    mentionsBot: true,
  };
  expect(discordMessageSubmissionSchema.parse({ owner, event, source }).source).toEqual(source);
  expect(discordMessageSubmissionSchema.parse({ owner, event, source: legacy }).source).toEqual(
    legacy,
  );
  expect(discordNativeAuthoritySchema.safeParse({ kind: 'dm', owner, source }).success).toBe(true);
  expect(
    discordNativeAuthoritySchema.safeParse({
      kind: 'dm',
      owner: { ...owner, applicationId: '999' },
      source,
    }).success,
  ).toBe(false);
  expect(
    discordRunEffectAuthoritySchema.safeParse({
      applicationRevision: 'wrong',
      native: { kind: 'dm', owner, source },
    }).success,
  ).toBe(false);
  expect(
    discordRunEffectAuthoritySchema.safeParse({
      applicationRevision: owner.applicationRevision,
      native: { kind: 'guild_text', owner, source },
    }).success,
  ).toBe(true);
});
