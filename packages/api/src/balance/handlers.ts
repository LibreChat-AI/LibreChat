import type { IBalance, IBalanceRequest, AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import { getBalanceConfig } from '~/app/config';

/** Reason is user-supplied free text — clamp it before it ever reaches the DB. */
const MAX_REASON_LENGTH = 500;

/** Mirrors the (unexported) `BalanceLocals` shape set by `createSetBalanceConfig`
 * in `middleware/balance.ts` — `getBalance` reads what that middleware already
 * resolved instead of re-fetching when possible. */
type BalanceLocals = {
  balanceData?: IBalance | null;
  balanceConfigEnabled?: boolean;
};

export interface BalanceDeps {
  findBalanceByUser: (user: string) => Promise<IBalance | null>;
  findPendingBalanceRequestByUser: (userId: string) => Promise<IBalanceRequest | null>;
  createBalanceRequest: (userId: string, reason?: string) => Promise<IBalanceRequest>;
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
}

export function createBalanceHandlers(deps: BalanceDeps): {
  getBalance: (req: ServerRequest, res: Response) => Promise<Response>;
  requestTopUp: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const { findBalanceByUser, findPendingBalanceRequestByUser, createBalanceRequest, getAppConfig } =
    deps;

  async function getBalanceHandler(req: ServerRequest, res: Response) {
    const balanceLocals = (res.locals ?? {}) as BalanceLocals;

    if (balanceLocals.balanceConfigEnabled === false) {
      return res.sendStatus(204);
    }

    const userId = req.user?.id as string;
    const balanceData = balanceLocals.balanceData ?? (await findBalanceByUser(userId));

    if (!balanceData) {
      return res.status(404).json({ error: 'Balance not found' });
    }

    // Resolve the live effective config, same as `requestTopUpHandler` —
    // `autoRefillEnabled`/`refillAmount`/interval fields stored on the
    // Balance document are only ever backfilled once, the first time it was
    // lazily created while auto-refill happened to already be on in config.
    // An admin changing these afterward never retroactively updates an
    // existing document, so the live config must take priority (same
    // bug/fix as the admin Balance list's `resolveBalanceConfig`).
    const appConfig = await getAppConfig({
      role: req.user?.role,
      userId,
      tenantId: req.user?.tenantId,
    });
    const balanceConfig = getBalanceConfig(appConfig);
    const autoRefillEnabled =
      balanceConfig?.autoRefillEnabled ?? balanceData.autoRefillEnabled ?? false;
    const refillAmount = balanceConfig?.refillAmount ?? balanceData.refillAmount;

    // Explicit public-field whitelist — never spread `balanceData` directly.
    // It's a raw Balance document, which also carries internal-only fields
    // (`user`, `tenantId`, and `recentIdempotencyKeys` — the admin-credit
    // idempotency ring buffer from `applyIdempotentCredit` — none of which
    // belong in a response a browser can read) alongside the ones actually
    // declared on `TBalanceResponse`.
    const responseBody: Record<string, unknown> = {
      tokenCredits: balanceData.tokenCredits,
      autoRefillEnabled,
    };
    // Independent of `autoRefillEnabled` — the client needs the configured
    // allocation size to show a "running low" warning relative to it even
    // when automatic refilling itself is off.
    if (refillAmount != null) {
      responseBody.refillAmount = refillAmount;
    }
    if (autoRefillEnabled) {
      responseBody.refillIntervalValue =
        balanceConfig?.refillIntervalValue ?? balanceData.refillIntervalValue;
      responseBody.refillIntervalUnit =
        balanceConfig?.refillIntervalUnit ?? balanceData.refillIntervalUnit;
      responseBody.lastRefill = balanceData.lastRefill;
    }

    const pending = await findPendingBalanceRequestByUser(userId);
    if (pending) {
      responseBody.pendingCreditRequest = {
        requestId: pending._id.toString(),
        requestedAt: pending.requestedAt.toISOString(),
        reason: pending.reason,
      };
    }

    return res.status(200).json(responseBody);
  }

  async function requestTopUpHandler(req: ServerRequest, res: Response) {
    const userId = req.user?.id as string;
    const { reason } = (req.body ?? {}) as { reason?: unknown };
    const trimmedReason =
      typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim().slice(0, MAX_REASON_LENGTH)
        : undefined;

    const appConfig = await getAppConfig({
      role: req.user?.role,
      userId,
      tenantId: req.user?.tenantId,
    });
    const balanceConfig = getBalanceConfig(appConfig);
    if (!balanceConfig?.enabled) {
      return res.status(400).json({ error: 'Balance is not enabled' });
    }

    const request = await createBalanceRequest(userId, trimmedReason);

    return res.status(200).json({
      requestId: request._id.toString(),
      requestedAt: request.requestedAt.toISOString(),
      reason: request.reason,
    });
  }

  return {
    getBalance: getBalanceHandler,
    requestTopUp: requestTopUpHandler,
  };
}
