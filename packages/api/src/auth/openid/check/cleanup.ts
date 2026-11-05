import type { Response } from 'express';
import type { OpenIDRequest, SessionOpenIDTokens } from '../types';
import type { OpenIDRefreshRecoveryService } from '../recovery';
import type { RefreshTokenBridgeDeleteInput } from '../types';

export function createOpenIDCheckCleanup(deps: {
  revokeOpenIDRefreshTokenChain: OpenIDRefreshRecoveryService['revokeOpenIDRefreshTokenChain'];
  deleteRefreshTokenBridges: (input: RefreshTokenBridgeDeleteInput) => Promise<unknown>;
  deleteSession: (input: { refreshToken: string }) => Promise<unknown>;
  clearOpenIDAuthTokens: (
    req: OpenIDRequest,
    res: Response,
    userId?: string,
    tenantId?: string,
  ) => void;
  ttl: number;
  runAsTenant: <T>(tenantId: string, work: () => Promise<T>) => Promise<T>;
  retirePrivate?: (req: OpenIDRequest, tokens: SessionOpenIDTokens) => Promise<void>;
  clearPrivate?: (req: OpenIDRequest, res: Response, tokens: SessionOpenIDTokens) => void;
}): {
  retire(req: OpenIDRequest, tokens: SessionOpenIDTokens): Promise<void>;
  clear(req: OpenIDRequest, res: Response, tokens: SessionOpenIDTokens): void;
} {
  async function retireCaptured(req: OpenIDRequest, tokens: SessionOpenIDTokens): Promise<void> {
    if (!tokens.appUserId || !tokens.refreshToken)
      throw new Error('OpenID session identity is unavailable');
    const snapshot: OpenIDRequest = {
      sessionID: req.sessionID,
      session: { openidTokens: tokens },
    };
    await deps.retirePrivate?.(snapshot, tokens);
    const refreshTokens = await deps.revokeOpenIDRefreshTokenChain({
      req: snapshot,
      user: {
        _id: tokens.appUserId,
        openidId: tokens.openidSubject,
        openidIssuer: tokens.openidIssuer,
        tenantId: tokens.tenantId,
      },
      identityContext: tokens,
      refreshTokens: [tokens.refreshToken],
      publicationKeys: [tokens.publicationFlightKey].filter((key): key is string => Boolean(key)),
      ttl: deps.ttl,
    });
    await deps.deleteRefreshTokenBridges({
      refreshTokens,
      userId: tokens.appUserId,
      tenantId: tokens.tenantId,
    });
    await Promise.all(refreshTokens.map((refreshToken) => deps.deleteSession({ refreshToken })));
  }
  return {
    retire(req: OpenIDRequest, tokens: SessionOpenIDTokens): Promise<void> {
      if (tokens.tenantId)
        return deps.runAsTenant(tokens.tenantId, () => retireCaptured(req, tokens));
      return retireCaptured(req, tokens);
    },
    clear(req: OpenIDRequest, res: Response, tokens: SessionOpenIDTokens): void {
      deps.clearOpenIDAuthTokens(req, res, tokens.appUserId, tokens.tenantId);
      deps.clearPrivate?.(req, res, tokens);
    },
  };
}
