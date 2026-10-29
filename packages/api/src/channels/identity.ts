import { createHash, randomBytes } from 'node:crypto';
import type {
  ChannelExternalIdentity,
  ChannelLink,
  ChannelLinkView,
  ChannelLinkTicket,
  ChannelIdentityResult,
} from 'librechat-data-provider';
import type { ChannelIdentityRecord, ChannelIdentityStorage } from '@librechat/data-schemas';

export interface ChannelLinkPrincipal {
  userId: string;
  tenantId: string;
  accountLabel: string;
}

export interface ChannelIdentityDependencies {
  storage: ChannelIdentityStorage;
  /** Must check current active channel, supported mode, agent, team and exact revision. */
  channelIsCurrent: (identity: ChannelExternalIdentity) => Promise<boolean>;
  /** Current principal existence, tenant membership, agent USE permission and deployment eligibility.
   * Shared owner-only mode additionally requires userId === channel.createdBy. */
  canUse: (identity: ChannelExternalIdentity, userId: string) => Promise<boolean>;
  publicBaseUrl: string;
  ticketLifetimeMs: number;
  linkLifetimeMs: number;
  getLifetimes?: () => Promise<{ ticketLifetimeMs: number; linkLifetimeMs: number }>;
  now?: () => number;
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const nonce = (): string => randomBytes(32).toString('base64url');
const failure = <T>(
  code: Extract<ChannelIdentityResult<T>, { ok: false }>['error']['code'],
): ChannelIdentityResult<T> => ({ ok: false, error: { code } });

export function sameChannelActor(a: ChannelExternalIdentity, b: ChannelExternalIdentity): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.channelId === b.channelId &&
    a.channelRevision === b.channelRevision &&
    a.teamId === b.teamId &&
    a.externalUserId === b.externalUserId &&
    a.agentId === b.agentId
  );
}

function view(record: ChannelIdentityRecord, now: number): ChannelLinkView {
  const expiry = record.state === 'active' ? record.expiresAtMs : record.ticketExpiresAtMs;
  return {
    identity: record.identity,
    linkId: record.linkId,
    revision: record.revision,
    state: record.state !== 'revoked' && expiry <= now ? 'expired' : record.state,
    expiresAtMs: expiry,
    ...(record.accountLabel ? { accountLabel: record.accountLabel } : {}),
  };
}

/** A link is identity consent, never an OAuth refresh credential or a transferable API key. */
export function createChannelIdentityService(deps: ChannelIdentityDependencies) {
  const now = deps.now ?? Date.now;
  const base = new URL(deps.publicBaseUrl);
  if (
    !['https:', 'http:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.hash ||
    base.search ||
    (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  ) {
    throw new Error('Channel link origin must be HTTPS or loopback HTTP');
  }
  if (
    ![deps.ticketLifetimeMs, deps.linkLifetimeMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error('Channel link lifetimes must be positive safe integers');
  }
  async function permitted(record: ChannelIdentityRecord, userId: string): Promise<boolean> {
    return (
      (await deps.channelIsCurrent(record.identity)) && (await deps.canUse(record.identity, userId))
    );
  }
  async function lifetime(kind: 'ticketLifetimeMs' | 'linkLifetimeMs'): Promise<number> {
    const value = (await deps.getLifetimes?.())?.[kind] ?? deps[kind];
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Channel link lifetime is invalid');
    return value;
  }
  async function ticket(
    principal: ChannelLinkPrincipal,
    secret: string,
  ): Promise<ChannelIdentityRecord | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return deps.storage.readChannelTicket(principal.tenantId, hash(secret));
  }
  return {
    async issue(
      identity: ChannelExternalIdentity,
    ): Promise<ChannelIdentityResult<ChannelLinkTicket>> {
      if (!(await deps.channelIsCurrent(identity))) return failure('changed');
      const existing = await deps.storage.readChannelIdentity(identity);
      if (
        existing &&
        ['active', 'accepted'].includes(existing.state) &&
        (existing.state === 'active' ? existing.expiresAtMs : existing.ticketExpiresAtMs) > now() &&
        sameChannelActor(identity, existing.identity)
      )
        return failure('already_linked');
      const secret = nonce();
      const expiry = now() + (await lifetime('ticketLifetimeMs'));
      const record: ChannelIdentityRecord = {
        tenantId: identity.tenantId,
        identity,
        linkId: existing?.linkId ?? nonce(),
        revision: nonce(),
        state: 'pending',
        ticketHash: hash(secret),
        ticketExpiresAtMs: expiry,
        expiresAtMs: expiry,
      };
      if (!(await deps.storage.saveChannelIdentity(record, existing?.revision ?? null)))
        return failure('changed');
      const url = new URL('channels/link', base.href.endsWith('/') ? base : `${base.href}/`);
      url.hash = secret;
      return { ok: true, value: { url: url.href, expiresAtMs: expiry } };
    },
    async preview(
      principal: ChannelLinkPrincipal,
      secret: string,
    ): Promise<ChannelIdentityResult<ChannelLinkView>> {
      const record = await ticket(principal, secret);
      if (!record || record.state === 'revoked') return failure('invalid_ticket');
      if (record.ticketExpiresAtMs <= now()) return failure('expired');
      if (record.userId && record.userId !== principal.userId) return failure('forbidden');
      if (!(await permitted(record, principal.userId))) return failure('forbidden');
      return { ok: true, value: view(record, now()) };
    },
    async accept(
      principal: ChannelLinkPrincipal,
      secret: string,
      expectedRevision: string,
    ): Promise<ChannelIdentityResult<ChannelLinkView>> {
      const record = await ticket(principal, secret);
      if (!record) return failure('invalid_ticket');
      if (record.ticketExpiresAtMs <= now()) return failure('expired');
      if (record.state !== 'pending' || record.revision !== expectedRevision)
        return failure('changed');
      if (!(await permitted(record, principal.userId))) return failure('forbidden');
      const accepted: ChannelIdentityRecord = {
        ...record,
        state: 'accepted',
        revision: nonce(),
        userId: principal.userId,
        accountLabel: principal.accountLabel.slice(0, 200),
      };
      if (!(await deps.storage.saveChannelIdentity(accepted, record.revision)))
        return failure('changed');
      return { ok: true, value: view(accepted, now()) };
    },
    /** Called only after trusted Slack ingress verifies this exact external actor. */
    async confirm(
      identity: ChannelExternalIdentity,
      linkId: string,
      expectedRevision: string,
    ): Promise<ChannelIdentityResult<ChannelLink>> {
      const record = await deps.storage.readChannelLink(identity.tenantId, linkId);
      if (!record || !sameChannelActor(record.identity, identity)) return failure('forbidden');
      if (record.state !== 'accepted' || record.revision !== expectedRevision || !record.userId)
        return failure('changed');
      if (record.ticketExpiresAtMs <= now()) return failure('expired');
      if (!(await permitted(record, record.userId))) return failure('forbidden');
      const active: ChannelIdentityRecord = {
        ...record,
        state: 'active',
        revision: nonce(),
        expiresAtMs: now() + (await lifetime('linkLifetimeMs')),
      };
      if (!(await deps.storage.saveChannelIdentity(active, record.revision)))
        return failure('changed');
      return {
        ok: true,
        value: {
          identity,
          linkId,
          revision: active.revision,
          userId: record.userId,
          expiresAtMs: active.expiresAtMs,
        },
      };
    },
    async inspectActor(
      identity: ChannelExternalIdentity,
    ): Promise<ChannelIdentityResult<ChannelLinkView | null>> {
      if (!(await deps.channelIsCurrent(identity))) return failure('changed');
      const record = await deps.storage.readChannelIdentity(identity);
      if (!record || !sameChannelActor(record.identity, identity)) return { ok: true, value: null };
      return { ok: true, value: view(record, now()) };
    },
    /** Re-run at admission AND continuation; callers must bind this exact revision to their run. */
    async resolve(
      identity: ChannelExternalIdentity,
      expectedRevision?: string,
    ): Promise<ChannelIdentityResult<ChannelLink>> {
      const record = await deps.storage.readChannelIdentity(identity);
      if (!record || !sameChannelActor(record.identity, identity)) return failure('changed');
      if (record.state === 'revoked') return failure('revoked');
      if (record.state !== 'active' || !record.userId) return failure('confirmation_required');
      if (expectedRevision && record.revision !== expectedRevision) return failure('changed');
      if (record.expiresAtMs <= now()) return failure('expired');
      if (!(await permitted(record, record.userId))) return failure('forbidden');
      return {
        ok: true,
        value: {
          identity,
          linkId: record.linkId,
          revision: record.revision,
          userId: record.userId,
          expiresAtMs: record.expiresAtMs,
        },
      };
    },
    async list(principal: ChannelLinkPrincipal): Promise<ChannelLinkView[]> {
      const records = await deps.storage.listChannelLinks(principal.tenantId, principal.userId);
      return records.map((record) => view(record, now()));
    },
    async revoke(
      principal: ChannelLinkPrincipal,
      linkId: string,
      expectedRevision: string,
    ): Promise<ChannelIdentityResult<ChannelLinkView>> {
      const record = await deps.storage.readChannelLink(principal.tenantId, linkId);
      if (!record || record.userId !== principal.userId) return failure('forbidden');
      if (record.revision !== expectedRevision) return failure('changed');
      const revoked: ChannelIdentityRecord = { ...record, state: 'revoked', revision: nonce() };
      if (!(await deps.storage.saveChannelIdentity(revoked, record.revision)))
        return failure('changed');
      return { ok: true, value: view(revoked, now()) };
    },
  };
}
