import type { Types } from 'mongoose';
import type { ChannelOwnership, ChannelRegistryAuthority } from './channelRegistry';
import type { ChannelIdentityRecord } from '~/models/channelIdentity';
import type { ManagedRegistrationResult } from './registration';
import type { ChannelRunMetadata } from './channelRunWrite';
import type { ManagedStorageTarget } from '~/types/managed';
import type { ChannelLaneScope } from './channelProtocol';
import type { ChannelAuthority } from './channelRegistry';
import type { ResponseOwner } from '~/models/response';
import type { ManagedState } from '~/types/managed';
import {
  channelScopeKeys,
  channelRegistryKey,
  registerChannelTarget,
  settleChannelTarget,
  settleAbsentChannelTarget,
} from './channelRegistry';
import {
  managedTargetFilter,
  managedRegistration,
  managedTargetPredicate,
  assertManagedCleanupTenant,
} from './managed';
import {
  registerResponseTarget,
  settleResponseTarget,
  settleAbsentResponseTarget,
} from './registration';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { readChannelAuthority } from './channelRegistry';
import { ChannelRunConflict } from './channelProtocol';
import { responseScopeKeys } from './responseScope';

export type ChannelRunOwnership = ChannelOwnership & {
  channel: ChannelAuthority;
  owner: ResponseOwner;
};

/** Capture exact current roles; application eligibility and registered publication remain mandatory. */
export async function readChannelRunOwnership(
  mongoose: typeof import('mongoose'),
  scope: ChannelLaneScope,
  now: number,
): Promise<ChannelRunOwnership | null> {
  const channel = await readChannelAuthority(mongoose, {
    tenantId: scope.tenantId,
    channelId: scope.channelId,
    agentId: scope.agentId,
    channelRevision: scope.principal.channelRevision,
    teamId: scope.admission.actor.teamId,
  });
  if (
    !channel ||
    channel.appId !== scope.admission.actor.appId ||
    !scope.principal.userId ||
    (channel.credentialMode === 'shared' && scope.principal.userId !== channel.createdBy)
  )
    return null;
  const tenantId = channel.target.tenantId;
  const roles: ChannelRunOwnership = {
    creator: { userId: channel.createdBy, ...(tenantId && { tenantId }) },
    owner: { userId: scope.principal.userId, ...(tenantId && { tenantId }) },
    channel,
  };
  const { linkId, linkRevision } = scope.principal;
  if (linkId === undefined && linkRevision === undefined)
    return channel.credentialMode === 'shared' ? roles : null;
  if (!linkId || !linkRevision) return null;
  const link = await createChannelIdentityModel(mongoose)
    .findOne({
      tenantId: scope.tenantId,
      linkId,
      revision: linkRevision,
      userId: scope.principal.userId,
      state: 'active',
      expiresAtMs: { $gt: now },
      '_managed.phase': 'published',
      'identity.tenantId': scope.tenantId,
      'identity.channelId': scope.channelId,
      'identity.channelRevision': scope.principal.channelRevision,
      'identity.agentId': scope.agentId,
      'identity.teamId': scope.admission.actor.teamId,
      'identity.externalUserId': scope.admission.actor.externalUserId,
    })
    .select('linkId revision userId identity +_managed')
    .read('primary')
    .lean<ChannelIdentityRecord & { _id: Types.ObjectId; _managed: ManagedState }>();
  if (!link?.userId) return null;
  roles.identity = {
    target: {
      kind: 'channelIdentity',
      id: String(link._id),
      incarnation: link._managed.incarnation,
      ...(tenantId && { tenantId }),
    },
    revision: link.revision,
    linkId: link.linkId,
    userId: link.userId,
    channelId: link.identity.channelId,
    channelRevision: link.identity.channelRevision,
    agentId: link.identity.agentId,
    teamId: link.identity.teamId,
    externalUserId: link.identity.externalUserId,
  };
  return roles;
}

type OwnershipAuthority =
  | { key: string; kind: 'response'; owner: ResponseOwner; conversationId?: string }
  | { key: string; kind: 'channel'; authority: ChannelRegistryAuthority };

/** The fixed role graph, not caller-selected models, filters or callbacks. */
function authorities(roles: ChannelOwnership): OwnershipAuthority[] {
  const entries: OwnershipAuthority[] = [roles.creator, roles.owner]
    .filter((owner): owner is ResponseOwner => owner != null)
    .map((owner) => ({ kind: 'response', owner, key: responseScopeKeys(owner, '')[0] }));
  if (roles.owner && roles.conversationId)
    entries.push({
      kind: 'response',
      owner: roles.owner,
      conversationId: roles.conversationId,
      key: responseScopeKeys(roles.owner, roles.conversationId)[1],
    });
  for (const authority of [roles.channel, roles.identity])
    if (authority) entries.push({ kind: 'channel', authority, key: channelRegistryKey(authority) });
  return [...new Map(entries.map((entry) => [entry.key, entry])).values()].sort((left, right) =>
    left.key < right.key ? -1 : 1,
  );
}

/** Publish this descriptor in the same CAS as private payload or its first association. */
export function channelOwnershipFields(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  roles: ChannelOwnership,
): { '_managed.scopeKeys': string[] } {
  managedTargetFilter(mongoose, target);
  return ownershipFields(mongoose, target, roles, 'publication');
}

function ownershipFields(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  roles: ChannelOwnership,
  access: 'publication' | 'cleanup',
): { '_managed.scopeKeys': string[] } {
  if (access === 'cleanup') {
    assertManagedCleanupTenant(target.tenantId);
    managedTargetPredicate(mongoose, target);
  }
  if (
    !target.kind.startsWith('channel') ||
    (target.tenantId || undefined) !== (roles.creator.tenantId || undefined)
  )
    throw new TypeError('Invalid channel ownership target');
  return { '_managed.scopeKeys': channelScopeKeys(mongoose, roles, access) };
}

export type ChannelOwnershipResult =
  | { status: 'registered'; expiredAt?: Date }
  | Exclude<ManagedRegistrationResult, { status: 'registered' }>;

/** Register every cleanup owner before writing any private data. Partial admission stays discoverable. */
export async function registerChannelOwnership(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  roles: ChannelOwnership,
  options: { maxPendingTargetsPerScope?: number } = {},
): Promise<ChannelOwnershipResult> {
  channelOwnershipFields(mongoose, target, roles);
  const entry = managedRegistration(target);
  let expiredAt: Date | undefined;
  for (const anchor of authorities(roles)) {
    const result =
      anchor.kind === 'response'
        ? await registerResponseTarget(
            mongoose,
            anchor.owner,
            anchor.conversationId,
            entry,
            options,
          )
        : await registerChannelTarget(mongoose, anchor.authority, entry, options);
    if (result.status !== 'registered') return result;
    if (result.expiredAt && (!expiredAt || result.expiredAt < expiredAt))
      expiredAt = result.expiredAt;
  }
  return { status: 'registered', ...(expiredAt && { expiredAt }) };
}

/** Every anchor checks its own current epoch/generation and the child's indexed ownership proof. */
export async function settleChannelOwnership(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  roles: ChannelOwnership,
): Promise<void> {
  channelOwnershipFields(mongoose, target, roles);
  const entry = managedRegistration(target);
  for (const anchor of authorities(roles)) {
    if (anchor.kind === 'response')
      await settleResponseTarget(mongoose, anchor.owner, anchor.conversationId, entry);
    else await settleChannelTarget(mongoose, anchor.authority, entry);
  }
}

/** Call after the owning domain has retired/deleted the exact target; this never erases payload. */
export async function reconcileAbsentChannelOwnership(
  mongoose: typeof import('mongoose'),
  target: ManagedStorageTarget,
  roles: ChannelOwnership,
): Promise<void> {
  ownershipFields(mongoose, target, roles, 'cleanup');
  const entry = managedRegistration(target);
  for (const anchor of authorities(roles)) {
    if (anchor.kind === 'response')
      await settleAbsentResponseTarget(mongoose, anchor.owner, anchor.conversationId, entry);
    else await settleAbsentChannelTarget(mongoose, anchor.authority, entry);
  }
}

export function capturedChannelRunOwnership(run: ChannelRunMetadata): ChannelRunOwnership {
  const saved = run.publication;
  if (!saved) throw new ChannelRunConflict('invalid_transition');
  const tenantId = run.tenantId === '_' ? undefined : run.tenantId;
  const roles: ChannelRunOwnership = {
    creator: { userId: saved.creatorId, ...(tenantId && { tenantId }) },
    owner: { userId: run.principal.userId, ...(tenantId && { tenantId }) },
    channel: {
      ...saved.channel,
      channelId: run.channelId,
      agentId: run.agentId,
      createdBy: saved.creatorId,
      teamId: run.admission.actor.teamId,
      appId: run.admission.actor.appId,
    },
  };
  if (saved.identity) {
    if (!run.principal.linkId || !run.principal.linkRevision)
      throw new Error('Channel publication lost its identity');
    roles.identity = {
      ...saved.identity,
      linkId: run.principal.linkId,
      userId: run.principal.userId,
      channelId: run.channelId,
      channelRevision: run.principal.channelRevision,
      agentId: run.agentId,
      teamId: run.admission.actor.teamId,
      externalUserId: run.admission.actor.externalUserId,
    };
  }
  return roles;
}
