import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type {
  ProviderSessionOperationData,
  ProviderSessionRevokeResult,
} from '@librechat/data-schemas';
import type { ResolvedBackchannelLogoutConfig } from '../providerSession/config';
import type { LogoutTokenKeyResolver } from './token';
import type { OpenIDLogger } from '../types';
import { hashProviderSessionId } from '../providerSession/ref';
import { validateLogoutToken } from './token';

export interface BackchannelLogoutClient {
  issuer: string;
  clientId: string;
}

export interface ReceiveBackchannelLogoutDeps {
  config: ResolvedBackchannelLogoutConfig;
  client: BackchannelLogoutClient;
  resolveKey: LogoutTokenKeyResolver;
  revokeProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionRevokeResult>;
  logger: OpenIDLogger;
  now?: () => Date;
}

export type BackchannelLogoutResponse =
  | { status: 200 }
  | { status: 400; body: { error: 'invalid_request' } }
  | { status: 503; body: { code: typeof AUTH_SESSION_CHECK_UNAVAILABLE } };

/** Whether the route should run at all; `off` and an unconfigured provider both keep the
 *  route's pre-existing 404. */
export function isBackchannelLogoutEnabled(
  config: Pick<ResolvedBackchannelLogoutConfig, 'mode'>,
  client: BackchannelLogoutClient | null | undefined,
): boolean {
  return config.mode !== 'off' && client != null;
}

const invalidRequest: BackchannelLogoutResponse = {
  status: 400,
  body: { error: 'invalid_request' },
};
const unavailable: BackchannelLogoutResponse = {
  status: 503,
  body: { code: AUTH_SESSION_CHECK_UNAVAILABLE },
};

async function processBackchannelLogout(
  logoutToken: string | undefined,
  deps: ReceiveBackchannelLogoutDeps,
  now: Date,
): Promise<BackchannelLogoutResponse> {
  if (typeof logoutToken !== 'string' || logoutToken.length === 0) {
    return invalidRequest;
  }

  const validation = await validateLogoutToken(logoutToken, {
    issuer: deps.client.issuer,
    clientId: deps.client.clientId,
    algorithms: deps.config.algorithms,
    clockToleranceSec: deps.config.clockToleranceSec,
    maxTokenAgeSec: deps.config.maxTokenAgeSec,
    resolveKey: deps.resolveKey,
    now: () => now,
  });

  if (!validation.ok) {
    if (validation.code === 'TEMPORARY') {
      deps.logger.warn('[backchannelLogout] temporarily unable to validate', {
        reason: validation.reason,
      });
      return unavailable;
    }
    deps.logger.warn('[backchannelLogout] rejected invalid token', { reason: validation.reason });
    return invalidRequest;
  }

  const { ref, subject } = validation;
  const expiresAt = new Date(
    now.getTime() +
      deps.config.callbackGraceMs +
      deps.config.processingTimeoutMs +
      deps.config.clockToleranceSec * 1000,
  );

  try {
    const result = await deps.revokeProviderSession({
      issuer: ref.issuer,
      clientId: ref.clientId,
      sid: ref.sid,
      subject,
      expiresAt,
      now,
    });

    if (!result.ok) {
      deps.logger.warn('[backchannelLogout] rejected', {
        code: result.code,
        issuer: ref.issuer,
        sidHash: hashProviderSessionId(ref.sid),
      });
      return invalidRequest;
    }

    deps.logger.info('[backchannelLogout] revoked', {
      issuer: ref.issuer,
      sidHash: hashProviderSessionId(ref.sid),
    });
    return { status: 200 };
  } catch {
    deps.logger.error('[backchannelLogout] provider session check unavailable', {
      issuer: ref.issuer,
      sidHash: hashProviderSessionId(ref.sid),
    });
    return unavailable;
  }
}

/** Bounded by `config.processingTimeoutMs`; a write that finishes after the timeout already
 *  answered is discarded here, not undone, so a retry still reaches the same durable write. */
export async function receiveBackchannelLogout(
  logoutToken: string | undefined,
  deps: ReceiveBackchannelLogoutDeps,
): Promise<BackchannelLogoutResponse> {
  const now = deps.now?.() ?? new Date();
  const outcome = processBackchannelLogout(logoutToken, deps, now);

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      deps.logger.error('[backchannelLogout] processing timed out');
      resolve(unavailable);
    }, deps.config.processingTimeoutMs);

    outcome.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(unavailable);
      },
    );
  });
}
