import type { AgentEventProvider } from 'librechat-data-provider';
import type { Limits, Outcome } from './catalog';

/** One HTTP delivery as it arrived. Transport types stay with the caller. */
export interface Inbound {
  /**
   * The body's bytes exactly as received. A signature is checked over these, so a parsed and
   * re-serialized copy never verifies.
   */
  body: Uint8Array;
  /** Header names in lower case, as Node delivers them. A repeated header arrives as a list. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * A delivery whose signature passed. Only a provider's `verify` makes one, and its `parse`
 * accepts nothing else, so a body cannot be read before it is verified.
 */
export interface Verified {
  provider: AgentEventProvider;
  /**
   * SHA-256 of the signed body, in hex: the delivery's identity. The signature covers the
   * body and nothing else, so this is the one value a sender cannot change without the
   * secret. A provider's own redelivery resends the same body and so has the same digest,
   * and so does a captured delivery posted again under a new delivery id.
   */
  digest: string;
  /**
   * The provider's id for the delivery, from a header the signature does not cover. A label
   * for finding the delivery in the provider's own records; never an identity.
   */
  delivery?: string;
  /**
   * The provider's name for the event, from a header the signature does not cover. `parse`
   * reads the body as that event, and a body of another event does not read as it.
   */
  event?: string;
}

/** Why a delivery is not trusted: no signature, one that does not read, or the wrong one. */
export type Rejected = 'missing' | 'malformed' | 'mismatch';

export type Verdict =
  | { ok: true; value: Verified }
  | { ok: false; error: { code: 'signature'; reason: Rejected } };

/**
 * An outside service that signs and posts events. The order is fixed: `verify` with the
 * deployment's secret for that service, then `parse`, and only then may the caller look up
 * anything the body names, such as the connection for its installation.
 */
export interface Provider {
  name: AgentEventProvider;
  /**
   * Checks the signature over the raw bytes, before anything is parsed. A rejection is an
   * expected outcome and is returned; a missing secret is the caller's error and throws.
   * Neither a result nor an error carries the secret.
   */
  verify(inbound: Inbound, secret: string): Verdict;
  /**
   * Reads a verified delivery into the catalog's events. It never throws for what the body
   * contains, and throws only when handed something `verify` did not return.
   */
  parse(verified: Verified, limits?: Limits): Outcome;
}
