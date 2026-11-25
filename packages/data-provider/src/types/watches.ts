/**
 * A conversation following one pull request: the provider's events about it continue that
 * conversation instead of starting new ones, under the subscription that allowed it.
 */
export interface Watch {
  id: string;
  /** The user whose conversation it continues. */
  user: string;
  tenantId?: string;
  conversationId: string;
  agentId: string;
  /** The subscription whose grant and rules its turns run under. */
  subscription: string;
  /** The connection whose deliveries it follows. */
  connection: string;
  /** The followed item's key, such as `github:pr:<repository id>#<number>`. */
  item: string;
  /** How the item reads to people, such as `owner/repo#123`; the key holds no name. */
  label: string;
  /** The pull request's page, when it is an http(s) address. */
  url?: string;
  /** When it was made, as an ISO date. */
  createdAt: string;
  /** When it ends on its own, as an ISO date. */
  expiresAt: string;
}

/**
 * Why a stored watch continues nothing for now: its subscription is off, no longer allows
 * watching, or no longer governs it (another agent, connection or owner, or gone).
 */
export type WatchPause = 'subscription_off' | 'watching_off' | 'unbound';

/** A watch as its owner lists it: `paused` is absent while events still continue it. */
export interface ListedWatch extends Watch {
  paused?: WatchPause;
}

export interface WatchesResponse {
  watches: ListedWatch[];
}

/** Stable codes a watch route answers a failure with. */
export const watchErrorCodes = ['watch_invalid', 'watch_not_found', 'watch_unavailable'] as const;
export type WatchErrorCode = (typeof watchErrorCodes)[number];
