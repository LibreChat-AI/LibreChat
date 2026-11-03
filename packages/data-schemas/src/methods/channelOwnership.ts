import type { ChannelOwnership, ChannelRegistryAuthority } from './channelRegistry';
import type { ManagedRegistrationResult } from './registration';
import type { ManagedStorageTarget } from '~/types/managed';
import type { ResponseOwner } from '~/models/response';
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
import { responseScopeKeys } from './responseScope';

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
