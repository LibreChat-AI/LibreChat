import { createHash, randomBytes } from 'node:crypto';
import { isSlackReplyURL, SLACK_REPLY_LIFETIME_MS } from 'librechat-data-provider';
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
  /** Absence disables new browser tickets without affecting existing identity authority. */
  publicBaseUrl?: string;
  ticketLifetimeMs: number;
  linkLifetimeMs: number;
  getLifetimes?: () => Promise<{ ticketLifetimeMs: number; linkLifetimeMs: number }>;
  now?: () => number;
  reply?: {
    encrypt: (url: string) => Promise<string>;
    decrypt: (value: string) => Promise<string>;
    update: (url: string, view: ChannelLinkView) => Promise<void>;
    onError: () => void;
  };
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
  if (
    ![deps.ticketLifetimeMs, deps.linkLifetimeMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  ) {
    throw new Error('Channel link lifetimes must be positive safe integers');
  }
  async function permitted(record: ChannelIdentityRecord, userId: string): Promise<boolean> {
    const [current, allowed] = await Promise.all([
      deps.channelIsCurrent(record.identity),
      deps.canUse(record.identity, userId),
    ]);
    return current && allowed;
  }
  async function currentView(record: ChannelIdentityRecord): Promise<ChannelLinkView> {
    const projected = view(record, now());
    if (
      (projected.state === 'active' || projected.state === 'accepted') &&
      (!record.userId || !(await permitted(record, record.userId)))
    )
      return { ...projected, state: 'unavailable' };
    return projected;
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
  async function updateReply(
    record: Pick<ChannelIdentityRecord, 'tenantId' | 'linkId' | 'ticketHash' | 'identity'>,
  ): Promise<void> {
    if (!deps.reply) return;
    try {
      const current = await deps.storage.readChannelLink(record.tenantId, record.linkId);
      const reply = current?.slackReply;
      if (
        !current ||
        !reply ||
        reply.attempt !== record.ticketHash ||
        !sameChannelActor(current.identity, record.identity)
      )
        return;
      if (reply.expiresAtMs <= now() || !(await deps.channelIsCurrent(current.identity))) {
        await deps.storage.clearChannelIdentityReply(
          current.tenantId,
          current.linkId,
          reply.attempt,
        );
        return;
      }
      if (
        current.state !== 'accepted' ||
        reply.claimed ||
        !current.userId ||
        !(await permitted(current, current.userId))
      )
        return;
      const url = await deps.reply.decrypt(reply.encryptedUrl);
      if (!isSlackReplyURL(url)) throw new TypeError('Invalid Slack reply');
      // Consume before the write, including ambiguous failures. Retrying an old accepted
      // write could restore its button after terminal success. Fresh mentions recover.
      if (!(await deps.storage.claimChannelIdentityReply(current, reply))) return;
      await deps.reply.update(url, view(current, now()));
      const latest = await deps.storage.readChannelLink(current.tenantId, current.linkId);
      // Reconcile the exact attempt after a paused write, including invalidation.
      // Never display a replacement attempt's account on this older private card.
      if (reply.expiresAtMs <= now()) return;
      const projected =
        latest?.ticketHash === current.ticketHash &&
        sameChannelActor(latest.identity, current.identity)
          ? await currentView(latest)
          : null;
      if (projected?.state === 'accepted') return;
      await deps.reply.update(
        url,
        projected?.state === 'active'
          ? projected
          : { ...view(current, now()), state: 'unavailable', accountLabel: undefined },
      );
    } catch {
      // Consent has committed; a cosmetic Slack failure must not turn it into a failed mutation.
      deps.reply.onError();
    }
  }
  return {
    /** Best-effort notification after a Slack callback has been acknowledged. */
    async notifyReply(
      identity: ChannelExternalIdentity,
      linkId: string,
      attempt: string,
    ): Promise<void> {
      await updateReply({ tenantId: identity.tenantId, identity, linkId, ticketHash: attempt });
    },
    async registerReply(
      identity: ChannelExternalIdentity,
      linkId: string,
      attempt: string,
      url: string,
    ): Promise<ChannelIdentityResult<null>> {
      if (!deps.reply || !isSlackReplyURL(url) || !/^[a-f0-9]{64}$/.test(attempt))
        return failure('forbidden');
      const record = await deps.storage.readChannelLink(identity.tenantId, linkId);
      if (
        !record ||
        record.ticketHash !== attempt ||
        !sameChannelActor(record.identity, identity) ||
        !['pending', 'accepted'].includes(record.state) ||
        record.ticketExpiresAtMs <= now() ||
        !(await deps.channelIsCurrent(identity))
      )
        return failure('changed');
      const saved = await deps.storage.saveChannelIdentityReply(record, {
        encryptedUrl: await deps.reply.encrypt(url),
        attempt,
        expiresAtMs: Math.min(record.ticketExpiresAtMs, now() + SLACK_REPLY_LIFETIME_MS),
      });
      if (!saved) {
        const existing = await deps.storage.readChannelLink(identity.tenantId, linkId);
        if (
          !existing?.slackReply ||
          existing.ticketHash !== attempt ||
          !sameChannelActor(existing.identity, identity)
        )
          return failure('changed');
      }
      return { ok: true, value: null };
    },
    async issue(
      identity: ChannelExternalIdentity,
    ): Promise<ChannelIdentityResult<ChannelLinkTicket>> {
      if (!deps.publicBaseUrl) return failure('unavailable');
      if (!(await deps.channelIsCurrent(identity))) return failure('changed');
      const existing = await deps.storage.readChannelIdentity(identity);
      if (
        existing &&
        ['active', 'accepted'].includes(existing.state) &&
        (existing.state === 'active' ? existing.expiresAtMs : existing.ticketExpiresAtMs) > now() &&
        sameChannelActor(identity, existing.identity) &&
        existing.userId != null &&
        (await permitted(existing, existing.userId))
      )
        return failure('already_linked');
      // Validate only when issuing a link, before any ticket is persisted.
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
      return {
        ok: true,
        value: {
          url: url.href,
          expiresAtMs: expiry,
          linkId: record.linkId,
          attempt: record.ticketHash,
        },
      };
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
      if (record.state === 'accepted' || record.state === 'active') await updateReply(record);
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
      await updateReply(accepted);
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
      await deps.storage.clearChannelIdentityReply(
        active.tenantId,
        active.linkId,
        active.ticketHash,
      );
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
      return { ok: true, value: await currentView(record) };
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
      return Promise.all(records.map(currentView));
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
      if (
        !(await deps.storage.revokeChannelIdentity(
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
            linkId,
            revision: expectedRevision,
          },
          revoked.revision,
        ))
      )
        return failure('changed');
      return { ok: true, value: view(revoked, now()) };
    },
  };
}
