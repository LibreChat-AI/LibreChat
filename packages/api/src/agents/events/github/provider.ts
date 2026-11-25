import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Inbound, Lifecycle, Provider, Rejected, Verdict, Verified } from '../provider';
import type { Limits, Outcome } from '../catalog';
import { normalize } from '../catalog';

/** `sha256=` and the 64 hex digits of an HMAC-SHA256, which is all GitHub sends there. */
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;
const EVENT = /^[a-z_]{1,64}$/;
/** GitHub sends a GUID; anything that is not a short plain token is left out. */
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The bytes each verified delivery was checked over, kept here and not on the value handed
 * out: `parse` reads these, so a buffer the caller reuses after `verify` cannot change what
 * is read, and an object that did not come from `verify` has no entry.
 */
const bodies = new WeakMap<Verified, Uint8Array>();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A header sent once; `undefined` when it is absent or repeated. */
function single(headers: Inbound['headers'], name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

function reject(reason: Rejected): Verdict {
  return { ok: false, error: { code: 'signature', reason } };
}

/**
 * GitHub signs the request body with the app's webhook secret and sends the HMAC in
 * `X-Hub-Signature-256`. Nothing else is signed: `X-GitHub-Event` and `X-GitHub-Delivery`
 * are plain headers and there is no signed time, so a delivery cannot be dated, and its
 * identity is the body's digest.
 */
function verify(inbound: Inbound, secret: string): Verdict {
  if (secret.length === 0) {
    throw new Error('A webhook secret is required to verify a delivery');
  }
  const sent = single(inbound.headers, 'x-hub-signature-256');
  if (sent == null) {
    return reject(inbound.headers['x-hub-signature-256'] == null ? 'missing' : 'malformed');
  }
  const match = SIGNATURE.exec(sent);
  if (match == null) {
    return reject('malformed');
  }
  const body = new Uint8Array(inbound.body);
  const expected = createHmac('sha256', secret).update(body).digest();
  if (!timingSafeEqual(expected, Buffer.from(match[1], 'hex'))) {
    return reject('mismatch');
  }
  const event = single(inbound.headers, 'x-github-event');
  const delivery = single(inbound.headers, 'x-github-delivery');
  const verified: Verified = Object.freeze({
    provider: 'github',
    digest: createHash('sha256').update(body).digest('hex'),
    ...(delivery != null && DELIVERY.test(delivery) && { delivery }),
    ...(event != null && EVENT.test(event) && { event }),
  });
  bodies.set(verified, body);
  return { ok: true, value: verified };
}

function malformed(field: string): Outcome {
  return { ok: false, error: { code: 'malformed', field } };
}

/** The JSON a verified body holds, or `undefined` when it is not UTF-8 JSON. */
function read(verified: Verified): unknown {
  const body = bodies.get(verified);
  if (body == null) {
    throw new Error('Only a delivery that verify passed can be read');
  }
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    /** The parser's message quotes the text around the fault, so it is dropped whole. */
    return undefined;
  }
}

/**
 * GitHub's own `installation` event, by action. `created` and `new_permissions_accepted` change
 * nothing here, since an install is bound to a tenant only through the admin flow.
 */
const CHANGES: Readonly<Record<string, Lifecycle['change']>> = {
  deleted: 'removed',
  suspend: 'suspended',
  unsuspend: 'restored',
};

type InstallBody = {
  action?: unknown;
  repository?: unknown;
  installation?: { id?: unknown; app_id?: unknown; account?: unknown } | null;
};

/**
 * An `installation` delivery's change to the install it names. The event header is not
 * signed, and many signed events have an action `deleted` and name their install, so the body
 * must also be shaped as only this event's is: the whole installation object, with its
 * `app_id` and `account`, and no repository. Every other event carries only the install's id,
 * so a relabelled delivery never reads as a change.
 */
function lifecycle(verified: Verified): Lifecycle | null {
  if (verified.event !== 'installation') {
    return null;
  }
  const json = read(verified) as InstallBody | null | undefined;
  if (json == null || typeof json !== 'object' || json.repository !== undefined) {
    return null;
  }
  const change = typeof json.action === 'string' ? CHANGES[json.action] : undefined;
  const install = json.installation;
  const id = install?.id;
  if (
    change == null ||
    typeof id !== 'number' ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof install?.app_id !== 'number' ||
    install.account == null ||
    typeof install.account !== 'object'
  ) {
    return null;
  }
  return { installation: String(id), change };
}

/**
 * The event header is not signed, so it is only a claim about the body. The catalog reads a
 * body by the fields its event defines, and no listed event's body has the fields of
 * another, so a relabelled delivery is `ignored` or `malformed` and never an event.
 */
function parse(verified: Verified, limits?: Limits): Outcome {
  if (!bodies.has(verified)) {
    throw new Error('parse takes only a delivery that verify passed');
  }
  if (verified.event == null) {
    return malformed('x-github-event');
  }
  const json = read(verified);
  if (json === undefined) {
    return malformed('body');
  }
  return normalize('github', verified.event, json, limits);
}

export const github: Provider = { name: 'github', verify, parse, lifecycle };
