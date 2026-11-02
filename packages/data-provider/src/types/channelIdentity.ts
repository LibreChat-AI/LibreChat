/** Supplied by authenticated channel ingress, never by browser identity fields. */
export interface ChannelExternalIdentity {
  tenantId: string;
  channelId: string;
  channelRevision: string;
  teamId: string;
  externalUserId: string;
  agentId: string;
}

export interface ChannelLink {
  identity: ChannelExternalIdentity;
  linkId: string;
  revision: string;
  userId: string;
  expiresAtMs: number;
}

export interface ChannelLinkView {
  identity: ChannelExternalIdentity;
  linkId: string;
  revision: string;
  state: 'pending' | 'accepted' | 'active' | 'revoked' | 'expired';
  expiresAtMs: number;
  /** Populated only for the signed-in owner or verified external actor. */
  accountLabel?: string;
}

export interface ChannelLinkTicket {
  url: string;
  expiresAtMs: number;
}

export type ChannelIdentityError =
  | 'invalid_ticket'
  | 'expired'
  | 'changed'
  | 'forbidden'
  | 'already_linked'
  | 'confirmation_required'
  | 'revoked'
  | 'unavailable';

export type ChannelIdentityResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ChannelIdentityError } };

export interface ChannelLinkAcceptance {
  ticket: string;
  expectedRevision: string;
}

/** Browser adapter supplied by the authenticated route host. */
export interface ChannelIdentityClient {
  preview(ticket: string): Promise<ChannelIdentityResult<ChannelLinkView>>;
  accept(input: ChannelLinkAcceptance): Promise<ChannelIdentityResult<ChannelLinkView>>;
  list(): Promise<ChannelLinkView[]>;
  revoke(linkId: string, revision: string): Promise<ChannelIdentityResult<ChannelLinkView>>;
}
