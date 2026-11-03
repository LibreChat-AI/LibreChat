import { createHash } from 'node:crypto';
import { durableStorageConfigSchema } from 'librechat-data-provider';
import type { ChannelExternalIdentity } from 'librechat-data-provider';
import type { FilterQuery, Types } from 'mongoose';
import type {
  ManagedTarget,
  ManagedState,
  ManagedRegistryState,
  ManagedRegistration,
  ManagedRegistrationIntent,
} from '~/types/managed';
import type { ManagedRegistrationResult } from './registration';
import type { AgentChannelRecord } from '~/models/channel';
import type { ResponseOwner } from '~/models/response';
import {
  assertManagedRegistration,
  sameManagedRegistration,
  managedRegistryCount,
  managedRegistryEpoch,
  managedRegistryAdmissionFilter,
  managedRegistryEntryFilter,
} from './registry';
import {
  managedTargetFilter,
  managedTargetModels,
  assertManagedTenant,
  assertManagedCleanupTenant,
  managedTargetPredicate,
} from './managed';
import { createChannelIdentityModel } from '~/models/channelIdentity';
import { includeManagedAllocations } from '~/utils/managed';
import { createAgentChannelModel } from '~/models/channel';
import { MANAGED_TARGET_KINDS } from '~/types/managed';
import { responseScopeKeys } from './responseScope';

export interface ChannelAuthority {
  target: ManagedTarget<'channel'>;
  revision: string;
  channelId: string;
  agentId: string;
  createdBy: string;
  teamId: string;
  appId: string;
}

export interface IdentityAuthority {
  target: ManagedTarget<'channelIdentity'>;
  revision: string;
  linkId: string;
  userId: string;
  channelId: string;
  channelRevision: string;
  agentId: string;
  teamId: string;
  externalUserId: string;
}

export type ChannelRegistryAuthority = ChannelAuthority | IdentityAuthority;

type RegistryAuthority = ChannelRegistryAuthority | { target: ChannelRegistryAuthority['target'] };
function hasLiveAuthority(authority: RegistryAuthority): authority is ChannelRegistryAuthority {
  return 'revision' in authority;
}

export interface ChannelOwnership {
  creator: ResponseOwner;
  owner?: ResponseOwner;
  channel?: ChannelAuthority;
  identity?: IdentityAuthority;
  conversationId?: string;
}

interface RegistryAnchor extends ManagedRegistryState {
  revision: string;
  tenantId?: string;
}

function isChannel(authority: ChannelRegistryAuthority): authority is ChannelAuthority {
  return authority.target.kind === 'channel';
}

/** Lifetime discovery survives revocation; the generation key additionally fences publication. */
export function channelRegistryKey(
  authority: Pick<ChannelRegistryAuthority, 'target' | 'revision'>,
  generation = true,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'channel-authority',
        authority.target.kind,
        authority.target.id.toLowerCase(),
        authority.target.incarnation,
        authority.target.tenantId || null,
        generation ? authority.revision : null,
      ]),
    )
    .digest('hex');
}

/** Capture a current physical authority before registering any private channel child. */
export async function readChannelAuthority(
  mongoose: typeof import('mongoose'),
  identity: ChannelExternalIdentity,
): Promise<(ChannelAuthority & Pick<AgentChannelRecord, 'credentialMode'>) | null> {
  const tenantId = identity.tenantId === '_' ? undefined : identity.tenantId;
  assertManagedTenant(tenantId);
  const parent = await createAgentChannelModel(mongoose)
    .findOne({
      tenantId: tenantId || { $in: [null, ''] },
      channelId: identity.channelId,
      agentId: identity.agentId,
      revision: identity.channelRevision,
      status: 'active',
      'slack.teamId': identity.teamId,
      '_managed.phase': 'published',
    })
    .select(
      'channelId agentId revision createdBy credentialMode slack.teamId slack.appId +_managed',
    )
    .read('primary')
    .lean<AgentChannelRecord & { _id: Types.ObjectId; _managed: ManagedState }>();
  if (!parent || !parent.slack?.appId) return null;
  return {
    target: {
      kind: 'channel',
      id: String(parent._id),
      incarnation: parent._managed.incarnation,
      ...(tenantId && { tenantId }),
    },
    channelId: parent.channelId,
    agentId: parent.agentId,
    revision: parent.revision,
    createdBy: parent.createdBy,
    credentialMode: parent.credentialMode,
    teamId: identity.teamId,
    appId: parent.slack.appId,
  };
}

function authorityFilter(
  mongoose: typeof import('mongoose'),
  authority: RegistryAuthority,
  open: boolean,
): FilterQuery<RegistryAnchor> {
  if (!['channel', 'channelIdentity'].includes(authority.target.kind))
    throw new TypeError('Invalid channel registry kind');
  if (!open) assertManagedCleanupTenant(authority.target.tenantId);
  const physical = open
    ? managedTargetFilter(mongoose, authority.target)
    : managedTargetPredicate(mongoose, authority.target);
  if (!open) return physical;
  if (!hasLiveAuthority(authority)) throw new TypeError('Live channel authority required');
  const fields = isChannel(authority)
    ? [
        authority.revision,
        authority.channelId,
        authority.agentId,
        authority.createdBy,
        authority.teamId,
        authority.appId,
      ]
    : [
        authority.revision,
        authority.linkId,
        authority.userId,
        authority.channelId,
        authority.channelRevision,
        authority.agentId,
        authority.teamId,
        authority.externalUserId,
      ];
  if (fields.some((value) => typeof value !== 'string' || !value))
    throw new TypeError('Invalid channel registration authority');
  return {
    ...physical,
    '_managed.phase': 'published',
    revision: authority.revision,
    ...(isChannel(authority)
      ? {
          status: 'active',
          channelId: authority.channelId,
          agentId: authority.agentId,
          createdBy: authority.createdBy,
          'slack.teamId': authority.teamId,
          'slack.appId': authority.appId,
        }
      : {
          state: 'active',
          linkId: authority.linkId,
          userId: authority.userId,
          expiresAtMs: { $gt: Date.now() },
          'identity.channelId': authority.channelId,
          'identity.channelRevision': authority.channelRevision,
          'identity.agentId': authority.agentId,
          'identity.teamId': authority.teamId,
          'identity.externalUserId': authority.externalUserId,
        }),
  };
}

/** Fixed ownership roles, installed atomically with the first private payload/association. */
export function channelScopeKeys(
  mongoose: typeof import('mongoose'),
  roles: ChannelOwnership,
  access: 'publication' | 'cleanup' = 'publication',
): string[] {
  const { creator, owner, channel, identity, conversationId } = roles;
  if (access === 'cleanup') assertManagedCleanupTenant(creator.tenantId);
  else assertManagedTenant(creator.tenantId);
  if (
    !creator.userId ||
    (owner &&
      (!owner.userId || (owner.tenantId || undefined) !== (creator.tenantId || undefined))) ||
    (conversationId !== undefined && (!owner || !conversationId)) ||
    (identity &&
      (!channel ||
        !owner ||
        identity.userId !== owner.userId ||
        identity.channelId !== channel.channelId ||
        identity.channelRevision !== channel.revision ||
        identity.agentId !== channel.agentId ||
        identity.teamId !== channel.teamId)) ||
    (channel && channel.createdBy !== creator.userId)
  )
    throw new TypeError('Invalid channel ownership');
  const keys = [responseScopeKeys(creator, '')[0]];
  if (owner) keys.push(responseScopeKeys(owner, '')[0]);
  if (conversationId) keys.push(responseScopeKeys(owner!, conversationId)[1]);
  for (const authority of [channel, identity]) {
    if (!authority) continue;
    authorityFilter(mongoose, authority, false);
    if ((authority.target.tenantId || undefined) !== (creator.tenantId || undefined))
      throw new TypeError('Channel ownership tenant changed');
    keys.push(channelRegistryKey(authority, false), channelRegistryKey(authority));
  }
  return [...new Set(keys)].sort();
}

function registryModel(mongoose: typeof import('mongoose'), authority: RegistryAuthority) {
  return mongoose.model<RegistryAnchor>(managedTargetModels[authority.target.kind]);
}

async function readAnchor(
  mongoose: typeof import('mongoose'),
  authority: RegistryAuthority,
  open: boolean,
): Promise<RegistryAnchor | null> {
  return includeManagedAllocations(
    registryModel(mongoose, authority).findOne(authorityFilter(mongoose, authority, open)),
  )
    .select('revision pending pendingCount retentionEpoch')
    .read('primary')
    .lean();
}

function registryEntry(
  mongoose: typeof import('mongoose'),
  authority: RegistryAuthority,
  entry: ManagedRegistrationIntent,
  retentionEpoch: number,
  cleanup = false,
): ManagedRegistration {
  const stamped: ManagedRegistration = {
    ...entry,
    retentionEpoch,
    ...(hasLiveAuthority(authority) && { authorityRevision: authority.revision }),
  };
  assertManagedRegistration(mongoose, stamped, cleanup ? 'cleanup' : 'publication');
  if ((entry.target.tenantId || undefined) !== (authority.target.tenantId || undefined))
    throw new TypeError('Channel registration tenant changed');
  if (!entry.target.kind.startsWith('channel'))
    throw new TypeError('Canonical history belongs to the Response registry');
  return stamped;
}

async function registerOnce(
  mongoose: typeof import('mongoose'),
  authority: ChannelRegistryAuthority,
  entry: ManagedRegistrationIntent,
  capacity: number,
): Promise<ManagedRegistrationResult> {
  registryEntry(mongoose, authority, entry, 0);
  const model = registryModel(mongoose, authority);
  for (let attempt = 0; attempt < 2; attempt++) {
    const anchor = await readAnchor(mongoose, authority, true);
    if (!anchor) return { status: 'closed' };
    const epoch = managedRegistryEpoch(anchor);
    const count = managedRegistryCount(anchor);
    const stamped = registryEntry(mongoose, authority, entry, epoch);
    const existing = anchor.pending?.find((candidate) => candidate.key === entry.key);
    if (existing)
      return sameManagedRegistration(existing, entry) &&
        existing.authorityRevision === authority.revision
        ? { status: 'registered', retentionEpoch: epoch }
        : { status: 'conflict' };
    if (count >= capacity) return { status: 'capacity' };
    const result = await model.updateOne(
      {
        ...authorityFilter(mongoose, authority, true),
        ...managedRegistryAdmissionFilter(entry.key, capacity, epoch),
      },
      { $push: { pending: stamped }, $inc: { pendingCount: 1 } },
      { timestamps: false },
    );
    if (result.matchedCount) return { status: 'registered', retentionEpoch: epoch };
  }
  return { status: 'retry' };
}

/** Only the canonical current generation can admit a private child. No upsert or mirror. */
export async function registerChannelTarget(
  mongoose: typeof import('mongoose'),
  authority: ChannelRegistryAuthority,
  entry: ManagedRegistrationIntent,
  options: { maxPendingTargetsPerScope?: number } = {},
): Promise<ManagedRegistrationResult> {
  const { maxPendingTargetsPerScope } = durableStorageConfigSchema.parse(options);
  const result = await registerOnce(mongoose, authority, entry, maxPendingTargetsPerScope);
  if (result.status !== 'capacity') return result;
  await reconcileChannelTargets(mongoose, authority);
  return registerOnce(mongoose, authority, entry, maxPendingTargetsPerScope);
}

/**
 * Published children leave discovery only while this exact generation remains open.
 * Erasure uses absence-only mode: hidden/retired allocations are still physically present.
 */
export async function reconcileChannelTargets(
  mongoose: typeof import('mongoose'),
  authority: ChannelRegistryAuthority,
  absenceOnly = false,
): Promise<number> {
  return reconcileTargets(mongoose, authority, absenceOnly);
}

/** Closed registry recovery requires a physical namespace, never erased account or actor data. */
export async function reconcileClosedChannelTarget(
  mongoose: typeof import('mongoose'),
  target: ChannelRegistryAuthority['target'],
): Promise<number> {
  return reconcileTargets(mongoose, { target }, true);
}

/** Normal publication settles only its own entry, without querying unrelated target kinds. */
export async function settleChannelTarget(
  mongoose: typeof import('mongoose'),
  authority: ChannelRegistryAuthority,
  entry: ManagedRegistrationIntent,
): Promise<boolean> {
  registryEntry(mongoose, authority, entry, 0);
  return (await reconcileTargets(mongoose, authority, false, entry)) === 1;
}

/** Positive one-shot absence also permits cleanup after canonical revocation. */
export async function settleAbsentChannelTarget(
  mongoose: typeof import('mongoose'),
  authority: ChannelRegistryAuthority,
  entry: ManagedRegistrationIntent,
): Promise<boolean> {
  registryEntry(mongoose, authority, entry, 0, true);
  return (await reconcileTargets(mongoose, authority, true, entry)) === 1;
}

async function reconcileTargets(
  mongoose: typeof import('mongoose'),
  authority: RegistryAuthority,
  absenceOnly: boolean,
  selected?: ManagedRegistrationIntent,
): Promise<number> {
  const live = hasLiveAuthority(authority) ? authority : undefined;
  if (!absenceOnly && !live) throw new TypeError('Live channel authority required');
  const anchor = await readAnchor(mongoose, authority, !absenceOnly);
  if (!anchor) return 0;
  managedRegistryCount(anchor);
  const epoch = managedRegistryEpoch(anchor);
  const settled: ManagedRegistration[] = [];
  for (const kind of MANAGED_TARGET_KINDS) {
    const entries = (anchor.pending ?? []).filter(
      (entry) =>
        entry.target.kind === kind && (!selected || sameManagedRegistration(entry, selected)),
    );
    if (!entries.length) continue;
    const rows = await includeManagedAllocations(
      mongoose.model(managedTargetModels[kind]).find({
        $or: entries.map((entry) => {
          registryEntry(mongoose, authority, entry, entry.retentionEpoch, absenceOnly);
          return managedTargetPredicate(mongoose, entry.target);
        }),
      }),
    )
      .select('_id _managed.incarnation _managed.phase _managed.scopeKeys')
      .read('primary')
      .lean<Array<{ _id: Types.ObjectId; _managed: ManagedState }>>();
    const present = new Map(rows.map((row) => [`${row._id}:${row._managed.incarnation}`, row]));
    for (const entry of entries) {
      const row = present.get(`${entry.target.id.toLowerCase()}:${entry.target.incarnation}`);
      if (
        !row ||
        (!absenceOnly &&
          live &&
          entry.authorityRevision === live.revision &&
          row._managed.phase === 'published' &&
          [channelRegistryKey(live, false), channelRegistryKey(live)].every((key) =>
            row._managed.scopeKeys?.includes(key),
          ))
      )
        settled.push(entry);
    }
  }
  if (!settled.length) return 0;
  // eslint-disable-next-line no-restricted-syntax -- fixed canonical model, exact physical tenant/incarnation and entry CAS; metadata-only settlement after positive proof.
  const result = await registryModel(mongoose, authority).bulkWrite(
    settled.map((entry) => ({
      updateOne: {
        filter: {
          ...authorityFilter(mongoose, authority, !absenceOnly),
          revision: anchor.revision,
          ...managedRegistryEntryFilter(entry, epoch),
        },
        update: { $pull: { pending: { key: entry.key } }, $inc: { pendingCount: -1 } },
        timestamps: false,
      },
    })),
    { ordered: false },
  );
  return result.matchedCount;
}

/** Closed canonical registries release only absent children; their domains still own drain. */
export async function reconcileClosedChannelRegistries(
  mongoose: typeof import('mongoose'),
  connection: { id: string; channelId: string; createdBy: string; tenantId?: string },
): Promise<void> {
  assertManagedCleanupTenant(connection.tenantId);
  if (!/^[a-f\d]{24}$/i.test(connection.id))
    throw new TypeError('Invalid channel cleanup identity');
  const parent = await includeManagedAllocations(
    createAgentChannelModel(mongoose).findOne({
      _id: new mongoose.Types.ObjectId(connection.id),
      channelId: connection.channelId,
      createdBy: connection.createdBy,
      tenantId: connection.tenantId || { $in: [null, ''] },
      status: 'deleting',
    }),
  )
    .select('_id _managed.incarnation pending pendingCount')
    .read('primary')
    .lean<AgentChannelRecord & ManagedRegistryState & { _managed?: ManagedState }>();
  if (!parent) return;
  if (managedRegistryCount(parent)) {
    if (!parent._managed?.incarnation) throw new Error('Channel registry authority is unavailable');
    await reconcileClosedChannelTarget(mongoose, {
      kind: 'channel',
      id: connection.id,
      incarnation: parent._managed.incarnation,
      ...(connection.tenantId && { tenantId: connection.tenantId }),
    });
  }
  const links = includeManagedAllocations(
    createChannelIdentityModel(mongoose).find({
      tenantId: connection.tenantId || '_',
      'identity.channelId': connection.channelId,
      state: 'revoked',
      $or: [{ 'pending.0': { $exists: true } }, { pendingCount: { $nin: [null, 0] } }],
    }),
  )
    .select('_id _managed.incarnation')
    .read('primary')
    .lean<Array<{ _id: Types.ObjectId; _managed?: ManagedState }>>()
    .cursor({ batchSize: 1 });
  for await (const link of links) {
    if (!link._managed?.incarnation) throw new Error('Link registry authority is unavailable');
    await reconcileClosedChannelTarget(mongoose, {
      kind: 'channelIdentity',
      id: String(link._id),
      incarnation: link._managed.incarnation,
      ...(connection.tenantId && { tenantId: connection.tenantId }),
    });
  }
}
