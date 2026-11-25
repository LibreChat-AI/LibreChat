import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { MAX_PASSKEYS_PER_USER } from 'librechat-data-provider';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyDeviceType } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import { isEnabled } from '~/utils';

/** How long a generated challenge stays valid, in milliseconds. */
export const PASSKEY_CHALLENGE_TTL: number = 5 * 60 * 1000;

/** Matches the challenge TTL so the authenticator prompt cannot outlive the challenge. */
const CEREMONY_TIMEOUT = PASSKEY_CHALLENGE_TTL;

export interface PasskeyConfig {
  enabled: boolean;
  /** Registrable domain the credential is scoped to (no scheme, no port). */
  rpID: string;
  /** Human-readable name shown by the authenticator during registration. */
  rpName: string;
  /** Origins a ceremony is allowed to originate from. */
  origins: string[];
}

/** The stored credential fields the ceremony helpers need. */
export interface PasskeyCredential {
  credentialId: string;
  publicKey: Buffer | Uint8Array;
  counter: number;
  transports?: string[];
}

export interface VerifiedPasskeyRegistration {
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string[];
  deviceType: PasskeyDeviceType;
  backedUp: boolean;
}

/** Minimal key/value contract satisfied by the app's Keyv cache stores. */
export interface PasskeyChallengeStore {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string, ttl?: number) => Promise<unknown>;
  /** Resolves true only for the caller that actually removed the key. */
  delete: (key: string) => Promise<boolean>;
  /** Optional atomic get-and-delete (Redis GETDEL). Prefer when available. */
  getDel?: (key: string) => Promise<string | undefined>;
}

/** Upper bound on the ceremony error text copied into a log line. */
const MAX_LOGGED_REASON_LENGTH = 200;

/** Line breaks, ANSI escapes and other control characters that could forge log records. */
// eslint-disable-next-line no-control-regex
const LOG_UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Ceremony errors interpolate attacker-supplied `clientDataJSON` fields into
 * their message, so the text is flattened to a single bounded line before it
 * reaches the logger and cannot fabricate additional log records.
 */
function logSafeReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const flattened = message.replace(LOG_UNSAFE_CHARACTERS, ' ').trim();
  if (!flattened) {
    return 'unknown error';
  }
  return flattened.length > MAX_LOGGED_REASON_LENGTH
    ? `${flattened.slice(0, MAX_LOGGED_REASON_LENGTH)}... [truncated]`
    : flattened;
}

function hostnameOf(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolves passkey settings from the environment.
 *
 * `PASSKEY_RP_ID` and `PASSKEY_ORIGINS` are optional: both are derived from
 * `DOMAIN_CLIENT` so a standard deployment needs only `ALLOW_PASSKEY_LOGIN=true`.
 * A credential is permanently bound to the RP ID it was created under, so an
 * operator changing `DOMAIN_CLIENT` later must pin `PASSKEY_RP_ID` to keep
 * existing passkeys usable.
 */
export function getPasskeyConfig(env: NodeJS.ProcessEnv = process.env): PasskeyConfig {
  const clientOrigin = normalizeOrigin(env.DOMAIN_CLIENT ?? '');
  const serverOrigin = normalizeOrigin(env.DOMAIN_SERVER ?? '');

  const configuredOrigins = (env.PASSKEY_ORIGINS ?? '')
    .split(',')
    .map(normalizeOrigin)
    .filter((origin): origin is string => !!origin);

  const origins = configuredOrigins.length
    ? configuredOrigins
    : [clientOrigin, serverOrigin].filter((origin): origin is string => !!origin);

  const rpID = env.PASSKEY_RP_ID?.trim() || hostnameOf(clientOrigin) || 'localhost';

  return {
    enabled: isEnabled(env.ALLOW_PASSKEY_LOGIN),
    rpID,
    rpName: env.PASSKEY_RP_NAME?.trim() || env.APP_TITLE?.trim() || 'LibreChat',
    origins: origins.length ? Array.from(new Set(origins)) : ['http://localhost:3080'],
  };
}

/**
 * True when passkeys are switched on and the deployment has at least one origin
 * to validate ceremonies against.
 */
export function isPasskeyEnabled(config: PasskeyConfig = getPasskeyConfig()): boolean {
  return config.enabled && config.origins.length > 0;
}

/** The schema's bounds for `passkeys.perUserMax`, applied to every source of the cap. */
const isCapWithinBounds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100;

/**
 * yaml wins over the environment, which wins over the documented default, so a
 * deployment that sets neither keeps exactly the behavior it has today. Every
 * source is held to the schema's bounds: principal-scoped database overrides
 * merge in without passing through `configSchema`, and a stray value must
 * neither brick enrollment nor lift the cap.
 */
export function resolveMaxPasskeysPerUser(
  config?: TCustomConfig['passkeys'],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fromConfig: unknown = config?.perUserMax;
  if (isCapWithinBounds(fromConfig)) {
    return fromConfig;
  }
  const fromEnv = Number(env.MAX_PASSKEYS_PER_USER);
  return isCapWithinBounds(fromEnv) ? fromEnv : MAX_PASSKEYS_PER_USER;
}

/** Namespaced cache key for a pending registration ceremony. */
export const registrationChallengeKey = (userId: string): string => `passkey-reg:${userId}`;

/** Namespaced cache key for a pending authentication ceremony. */
export const authenticationChallengeKey = (sessionId: string): string =>
  `passkey-auth:${sessionId}`;

/**
 * Reads a challenge and immediately invalidates it, so a challenge can back at
 * most one ceremony even if the client replays the verification request.
 *
 * Prefers atomic get-and-delete when the store implements `getDel` (e.g. Redis
 * GETDEL). Otherwise the delete arbitrates: `DEL` and `Map#delete` report removal to
 * exactly one caller, so a replayed or concurrent verification cannot share a challenge.
 */
export async function consumeChallenge(
  store: PasskeyChallengeStore,
  key: string,
): Promise<string | undefined> {
  if (typeof store.getDel === 'function') {
    const value = await store.getDel(key);
    return value ?? undefined;
  }

  const challenge = await store.get(key);
  if (challenge == null) {
    return undefined;
  }
  /** Concurrent readers can all see the value; only the one whose delete removed it may use it. */
  return (await store.delete(key)) ? challenge : undefined;
}

/**
 * Builds registration options for an already-authenticated user and stores the
 * challenge under that user's id.
 */
export async function createPasskeyRegistrationOptions({
  config,
  store,
  user,
  existingCredentials = [],
}: {
  config: PasskeyConfig;
  store: PasskeyChallengeStore;
  user: { id: string; email: string; name?: string; username?: string };
  existingCredentials?: PasskeyCredential[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const options = await generateRegistrationOptions({
    rpID: config.rpID,
    rpName: config.rpName,
    userID: new Uint8Array(Buffer.from(user.id, 'utf8')),
    userName: user.email,
    userDisplayName: user.name || user.username || user.email,
    timeout: CEREMONY_TIMEOUT,
    attestationType: 'none',
    excludeCredentials: existingCredentials.map((credential) => ({
      id: credential.credentialId,
      transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });

  await store.set(registrationChallengeKey(user.id), options.challenge, PASSKEY_CHALLENGE_TTL);
  return options;
}

/**
 * Verifies an attestation against the challenge issued for `userId` and returns
 * the credential fields to persist. Returns `null` when verification fails.
 */
export async function verifyPasskeyRegistration({
  config,
  store,
  userId,
  response,
}: {
  config: PasskeyConfig;
  store: PasskeyChallengeStore;
  userId: string;
  response: RegistrationResponseJSON;
}): Promise<VerifiedPasskeyRegistration | null> {
  const expectedChallenge = await consumeChallenge(store, registrationChallengeKey(userId));
  if (!expectedChallenge) {
    return null;
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    logger.warn(`[passkey] Registration verification failed: ${logSafeReason(error)}`);
    return null;
  }

  if (!verification.verified) {
    return null;
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ?? response.response.transports ?? [],
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

/**
 * Builds authentication options for an anonymous caller. No `allowCredentials`
 * is sent, so the browser offers whichever discoverable credential the user has
 * for this RP and the server never confirms whether an account exists.
 *
 * The returned `sessionId` is the opaque handle the client must send back with
 * the assertion; it is the only thing tying the assertion to its challenge.
 *
 * User verification is requested as `required` so the authenticator collects the
 * PIN or biometric during the ceremony, matching what verification enforces.
 */
export async function createPasskeyAuthenticationOptions({
  config,
  store,
}: {
  config: PasskeyConfig;
  store: PasskeyChallengeStore;
}): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; sessionId: string }> {
  const options = await generateAuthenticationOptions({
    rpID: config.rpID,
    timeout: CEREMONY_TIMEOUT,
    userVerification: 'required',
  });

  const sessionId = randomUUID();
  await store.set(authenticationChallengeKey(sessionId), options.challenge, PASSKEY_CHALLENGE_TTL);

  return { options, sessionId };
}

/**
 * Verifies an assertion against the challenge issued for `sessionId`.
 * Returns the authenticator's new signature counter and current backup state on
 * success, `null` otherwise.
 *
 * A passkey assertion is a complete single-factor login here, so user
 * verification is required: an assertion carrying only the user-present flag,
 * which mere possession of the authenticator produces, is rejected.
 */
export async function verifyPasskeyAuthentication({
  config,
  store,
  sessionId,
  response,
  credential,
}: {
  config: PasskeyConfig;
  store: PasskeyChallengeStore;
  sessionId: string;
  response: AuthenticationResponseJSON;
  credential: PasskeyCredential;
}): Promise<{ newCounter: number; backedUp: boolean } | null> {
  const expectedChallenge = await consumeChallenge(store, authenticationChallengeKey(sessionId));
  if (!expectedChallenge) {
    return null;
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransportFuture[] | undefined,
      },
    });
  } catch (error) {
    logger.warn(`[passkey] Authentication verification failed: ${logSafeReason(error)}`);
    return null;
  }

  if (!verification.verified) {
    return null;
  }

  const { newCounter, credentialBackedUp } = verification.authenticationInfo;
  return { newCounter, backedUp: credentialBackedUp };
}

/**
 * Derives a default label for a new credential from the authenticator's
 * transports, so the list in account settings is readable without the user
 * having to name every key.
 */
export function defaultPasskeyName(transports: string[] = []): string {
  if (transports.includes('hybrid')) {
    return 'Phone or tablet';
  }
  if (transports.includes('usb') || transports.includes('nfc')) {
    return 'Security key';
  }
  if (transports.includes('internal')) {
    return 'This device';
  }
  return 'Passkey';
}
