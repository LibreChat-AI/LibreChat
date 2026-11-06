import { OPENID_SESSION_ENDED, OPENID_SESSION_ID_MISSING } from 'librechat-data-provider';
import type {
  ProviderSessionOperationData,
  ProviderSessionEstablishResult,
  ProviderSessionAuthorizeResult,
} from '@librechat/data-schemas';
import type { ProviderSessionRef } from 'librechat-data-provider';
import type { ResolvedBackchannelLogoutConfig } from './config';
import type { OpenIDLogger } from '../types';
import { ProviderSessionUnavailableError } from './errors';
import { hashProviderSessionId } from './ref';

/** A login callback recheck found it older than `callbackGraceMs` allows before establishing. */
export const CALLBACK_EXPIRED = 'CALLBACK_EXPIRED' as const;

export interface ProviderSessionMethodsDeps {
  establish: (data: ProviderSessionOperationData) => Promise<ProviderSessionEstablishResult>;
  authorize: (data: ProviderSessionOperationData) => Promise<ProviderSessionAuthorizeResult>;
}

export interface CreateProviderSessionAuthorizerOptions {
  methods: ProviderSessionMethodsDeps;
  /** Resolves `registration.openidBackchannelLogout`. A rejection must not be treated as mode
   *  `'off'`; callers below surface it as `ProviderSessionUnavailableError`. */
  getConfig: () => Promise<ResolvedBackchannelLogoutConfig>;
  logger: OpenIDLogger;
  now?: () => Date;
}

export interface ProviderSessionEstablishInput {
  ref: ProviderSessionRef | null;
  subject?: string;
  expiresAt: Date;
  /** When the login callback started; checked against `callbackGraceMs`. */
  callbackIssuedAt: Date;
}

export type ProviderSessionEstablishOutcome =
  | { ok: true }
  | {
      ok: false;
      code:
        | typeof OPENID_SESSION_ENDED
        | typeof OPENID_SESSION_ID_MISSING
        | typeof CALLBACK_EXPIRED;
    };

export interface ProviderSessionAuthorizeInput {
  ref: ProviderSessionRef | null;
  subject?: string;
  expiresAt: Date;
  /** Whether this credential predates provider-session association (no ref was ever recorded
   *  for it). Carried through only as denial-log context, not a separate outcome. */
  legacy: boolean;
}

export type ProviderSessionAuthorizeOutcome =
  | { ok: true }
  | { ok: false; code: typeof OPENID_SESSION_ENDED };

export interface ProviderSessionAuthorizer {
  establish: (input: ProviderSessionEstablishInput) => Promise<ProviderSessionEstablishOutcome>;
  /** Final authorization step before publication: Set-Cookie or an equivalent response write. */
  authorize: (input: ProviderSessionAuthorizeInput) => Promise<ProviderSessionAuthorizeOutcome>;
  /** Same checks as `authorize`, run before the IdP grant. Extending `expiresAt` early is safe
   *  because a revoke only ever moves `revokedAt` forward and `expiresAt` is never shortened. */
  preCheck: (
    input: Omit<ProviderSessionAuthorizeInput, 'legacy'>,
  ) => Promise<ProviderSessionAuthorizeOutcome>;
  /** The resolved mode, for callers that must skip provider-session work entirely under `'off'`.
   *  Rejects the same way `authorize`/`establish` do when the config cannot be loaded. */
  getMode: () => Promise<ResolvedBackchannelLogoutConfig['mode']>;
}

function refLogMeta(ref: ProviderSessionRef): {
  issuer: string;
  clientId: string;
  sidHash: string;
} {
  return { issuer: ref.issuer, clientId: ref.clientId, sidHash: hashProviderSessionId(ref.sid) };
}

export function createProviderSessionAuthorizer({
  methods,
  getConfig,
  logger,
  now = () => new Date(),
}: CreateProviderSessionAuthorizerOptions): ProviderSessionAuthorizer {
  /** Loads the config, surfacing a failed load as `ProviderSessionUnavailableError` rather than
   *  any fallback (a stale value, or mode `'off'`). */
  async function loadConfig(): Promise<ResolvedBackchannelLogoutConfig> {
    try {
      return await getConfig();
    } catch (error) {
      logger.error('[providerSession] backchannel-logout config unavailable', { error });
      throw new ProviderSessionUnavailableError('Provider session check unavailable', {
        cause: error,
      });
    }
  }

  async function establish(
    input: ProviderSessionEstablishInput,
  ): Promise<ProviderSessionEstablishOutcome> {
    const config = await loadConfig();
    if (config.mode === 'off') {
      return { ok: true };
    }

    const current = now();
    if (current.getTime() - input.callbackIssuedAt.getTime() > config.callbackGraceMs) {
      return { ok: false, code: CALLBACK_EXPIRED };
    }

    if (input.ref == null) {
      if (config.mode === 'enforce') {
        return { ok: false, code: OPENID_SESSION_ID_MISSING };
      }
      return { ok: true };
    }

    try {
      const result = await methods.establish({
        issuer: input.ref.issuer,
        clientId: input.ref.clientId,
        sid: input.ref.sid,
        subject: input.subject,
        expiresAt: input.expiresAt,
        now: current,
      });
      if (result.ok) {
        return { ok: true };
      }
      logger.warn('[providerSession] establish denied', {
        ...refLogMeta(input.ref),
        resultCode: result.code,
      });
      return { ok: false, code: OPENID_SESSION_ENDED };
    } catch (error) {
      if (config.mode === 'enforce') {
        logger.error('[providerSession] establish check unavailable', refLogMeta(input.ref));
        throw new ProviderSessionUnavailableError('Provider session check unavailable', {
          cause: error,
        });
      }
      logger.warn('[providerSession] establish check unavailable; continuing in record mode', {
        ...refLogMeta(input.ref),
        error,
      });
      return { ok: true };
    }
  }

  async function authorize(
    input: ProviderSessionAuthorizeInput,
  ): Promise<ProviderSessionAuthorizeOutcome> {
    const config = await loadConfig();
    if (config.mode === 'off') {
      return { ok: true };
    }

    if (input.ref == null) {
      return config.mode === 'enforce' ? { ok: false, code: OPENID_SESSION_ENDED } : { ok: true };
    }

    try {
      const result = await methods.authorize({
        issuer: input.ref.issuer,
        clientId: input.ref.clientId,
        sid: input.ref.sid,
        subject: input.subject,
        expiresAt: input.expiresAt,
        now: now(),
      });
      if (result.ok) {
        return { ok: true };
      }
      if (result.code === 'ENDED' || result.code === 'CONFLICT') {
        return { ok: false, code: OPENID_SESSION_ENDED };
      }

      // MISSING: an unassociated or legacy credential. enforce denies it; record fails open
      // while the rollout observes legacy sessions.
      if (config.mode === 'enforce') {
        return { ok: false, code: OPENID_SESSION_ENDED };
      }
      logger.warn(
        '[providerSession] provider session missing or unassociated; allowed in record mode',
        {
          ...refLogMeta(input.ref),
          resultCode: result.code,
          legacy: input.legacy,
        },
      );
      return { ok: true };
    } catch (error) {
      if (config.mode === 'enforce') {
        logger.error('[providerSession] authorize check unavailable', {
          ...refLogMeta(input.ref),
          legacy: input.legacy,
        });
        throw new ProviderSessionUnavailableError('Provider session check unavailable', {
          cause: error,
        });
      }
      logger.warn('[providerSession] authorize check unavailable; continuing in record mode', {
        ...refLogMeta(input.ref),
        legacy: input.legacy,
        error,
      });
      return { ok: true };
    }
  }

  function preCheck(
    input: Omit<ProviderSessionAuthorizeInput, 'legacy'>,
  ): Promise<ProviderSessionAuthorizeOutcome> {
    return authorize({ ...input, legacy: false });
  }

  async function getMode(): Promise<ResolvedBackchannelLogoutConfig['mode']> {
    const config = await loadConfig();
    return config.mode;
  }

  return { establish, authorize, preCheck, getMode };
}
