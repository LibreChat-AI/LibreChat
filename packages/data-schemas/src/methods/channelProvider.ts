import type { ChannelExternalIdentity, ChannelRunActor } from 'librechat-data-provider';

/** Explicit absence prevents legacy Slack lookups from matching another provider's rows. */
export function channelIdentityScope(
  identity: ChannelExternalIdentity,
): Record<string, string | { $exists: false }> {
  if (identity.provider === 'discord')
    return {
      'identity.provider': 'discord',
      'identity.applicationId': identity.applicationId,
      'identity.guildId': identity.guildId,
      'identity.teamId': { $exists: false },
    };
  return {
    'identity.provider': { $exists: false },
    'identity.applicationId': { $exists: false },
    'identity.guildId': { $exists: false },
    'identity.teamId': identity.teamId,
  };
}

export function channelRunActorScope(
  actor: ChannelRunActor,
): Record<string, string | { $exists: false }> {
  if (actor.provider === 'discord')
    return {
      'admission.actor.provider': 'discord',
      'admission.actor.applicationId': actor.applicationId,
      'admission.actor.guildId': actor.guildId,
      'admission.actor.teamId': { $exists: false },
      'admission.actor.appId': { $exists: false },
    };
  return {
    'admission.actor.provider': { $exists: false },
    'admission.actor.applicationId': { $exists: false },
    'admission.actor.guildId': { $exists: false },
    'admission.actor.teamId': actor.teamId,
    'admission.actor.appId': actor.appId,
  };
}
