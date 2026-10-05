import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type {
  IUser,
  IBalance,
  IAuditLog,
  AppConfig,
  IBalanceRequest,
  RecordAuditEntryInput,
  PendingBalanceRequestWithUser,
} from '@librechat/data-schemas';
import type { AdminBalanceListItem } from 'librechat-data-provider';
import type { FilterQuery } from 'mongoose';
import type { Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types/http';
import { getBalanceConfig } from '~/app/config';
import { parsePagination } from './pagination';

const MAX_SEARCH_LENGTH = 200;
/** $100 — generous for a real top-up, low enough to catch a typo'd extra zero. */
const MAX_ADD_CREDIT_AMOUNT = 100_000_000;

const USER_LIST_FIELDS = '_id name email avatar role tenantId';

export interface AdminBalanceDeps {
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  getUserById: (userId: string, fieldsToSelect?: string | string[] | null) => Promise<IUser | null>;
  findBalancesByUsers: (userIds: string[]) => Promise<IBalance[]>;
  findPendingBalanceRequestsByUsers: (userIds: string[]) => Promise<IBalanceRequest[]>;
  findAllPendingBalanceRequests: () => Promise<PendingBalanceRequestWithUser[]>;
  countPendingBalanceRequests: () => Promise<number>;
  applyIdempotentCredit: (params: {
    user: string;
    incrementValue: number;
    idempotencyKey: string;
    context: string;
  }) => Promise<{ resultingBalance: number; applied: boolean; transactionId: string }>;
  claimAuditRecording: (transactionId: string) => Promise<boolean>;
  markAuditRecorded: (transactionId: string) => Promise<void>;
  releaseAuditRecordingLease: (transactionId: string) => Promise<void>;
  claimBalanceRequestResolution: (requestId: string, userId: string) => Promise<boolean>;
  releaseBalanceRequestResolutionLease: (requestId: string) => Promise<void>;
  resolveBalanceRequestIfPending: (
    requestId: string,
    userId: string,
    fields: { resolvedBy: string; resolvedAmount: number },
  ) => Promise<IBalanceRequest | null>;
  recordAuditEntry: (input: RecordAuditEntryInput) => Promise<IAuditLog | null>;
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
}

export function createAdminBalanceHandlers(deps: AdminBalanceDeps): {
  listUsersWithBalance: (req: ServerRequest, res: Response) => Promise<Response>;
  addCredit: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    findUsers,
    countUsers,
    getUserById,
    findBalancesByUsers,
    findPendingBalanceRequestsByUsers,
    findAllPendingBalanceRequests,
    countPendingBalanceRequests,
    applyIdempotentCredit,
    claimAuditRecording,
    markAuditRecorded,
    releaseAuditRecordingLease,
    claimBalanceRequestResolution,
    releaseBalanceRequestResolutionLease,
    resolveBalanceRequestIfPending,
    recordAuditEntry,
    getAppConfig,
  } = deps;

  /**
   * Resolves this user's effective (role/user-override-resolved) balance
   * config — the exact same resolution `addCreditHandler` performs before
   * crediting. Two things specifically depend on using the *live* config
   * here rather than whatever happens to be stored on the user's Balance
   * document:
   *
   * - `enabled`: without this, the list can show a disabled user's balance
   *   as `0`, indistinguishable from a genuinely exhausted balance, and
   *   offer a "Reset limit" action guaranteed to fail server-side.
   * - `refillAmount`: the Balance document's own `refillAmount` field is
   *   only ever populated once, by `checkBalance`'s lazy-init path, the
   *   first time that specific document is created while auto-refill
   *   happens to already be on in config. An admin changing the configured
   *   refill amount afterward does not retroactively update any Balance
   *   document that already existed — so reading from the document instead
   *   of the live config would keep showing a stale (often zero/unset)
   *   amount no matter what the admin just configured.
   */
  async function resolveBalanceConfig(user: {
    role?: string;
    tenantId?: string;
    id: string;
  }): Promise<{ enabled: boolean; refillAmount?: number }> {
    const appConfig = await getAppConfig({
      role: user.role,
      userId: user.id,
      tenantId: user.tenantId,
    });
    const balanceConfig = getBalanceConfig(appConfig);
    return {
      enabled: balanceConfig?.enabled === true,
      refillAmount: balanceConfig?.refillAmount,
    };
  }

  async function buildBalanceListItem(params: {
    id: string;
    name?: string;
    email?: string;
    avatar?: string;
    role?: string;
    tenantId?: string;
    balance?: IBalance;
    pendingRequest?: { requestId: string; requestedAt: string; reason?: string };
  }): Promise<AdminBalanceListItem> {
    const { enabled: balanceEnabled, refillAmount } = await resolveBalanceConfig(params);
    return {
      id: params.id,
      name: params.name ?? '',
      email: params.email ?? '',
      avatar: params.avatar ?? '',
      tokenCredits: params.balance?.tokenCredits ?? 0,
      balanceEnabled,
      lastRefill: params.balance?.lastRefill?.toISOString(),
      refillAmount: refillAmount ?? params.balance?.refillAmount,
      pendingRequest: params.pendingRequest,
    };
  }

  /**
   * Pending requests are joined onto a page of *users* only after that page
   * has already been carved out alphabetically — a request belonging to the
   * 51st user, alphabetically, simply never appears, with no way to filter,
   * count, or prioritize it. This view instead starts from the (small,
   * human-moderated) set of pending requests themselves, so none can hide
   * behind user-list pagination. `pendingCount` is always computed
   * separately from the global total, independent of `search`, so the
   * "Requests (N)" control reflects the true queue size regardless of what
   * the admin is currently viewing or searching.
   */
  async function listPendingRequestsView(
    search: string,
    limit: number,
    offset: number,
  ): Promise<{ items: AdminBalanceListItem[]; total: number }> {
    const allPending = await findAllPendingBalanceRequests();
    const matching = search
      ? allPending.filter((r) => {
          const regex = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          return regex.test(r.user.name ?? '') || regex.test(r.user.email ?? '');
        })
      : allPending;

    const total = matching.length;
    const page = matching.slice(offset, offset + limit);
    const userIds = page.map((r) => r.user.id);
    const balances = await findBalancesByUsers(userIds);
    const balanceByUser = new Map(balances.map((b) => [b.user.toString(), b]));

    const items = await Promise.all(
      page.map((r) =>
        buildBalanceListItem({
          id: r.user.id,
          name: r.user.name,
          email: r.user.email,
          avatar: r.user.avatar,
          role: r.user.role,
          tenantId: r.user.tenantId,
          balance: balanceByUser.get(r.user.id),
          pendingRequest: {
            requestId: r.requestId,
            requestedAt: r.requestedAt.toISOString(),
            reason: r.reason,
          },
        }),
      ),
    );

    return { items, total };
  }

  async function listAllUsersView(
    search: string,
    limit: number,
    offset: number,
  ): Promise<{ items: AdminBalanceListItem[]; total: number }> {
    const filter: FilterQuery<IUser> = {};
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const [users, total] = await Promise.all([
      findUsers(filter, USER_LIST_FIELDS, { limit, offset, sort: { name: 1 } }),
      countUsers(filter),
    ]);

    const userIds = users.map((u) => u._id?.toString()).filter((id): id is string => !!id);
    const [balances, pendingRequests] = await Promise.all([
      findBalancesByUsers(userIds),
      findPendingBalanceRequestsByUsers(userIds),
    ]);
    const balanceByUser = new Map(balances.map((b) => [b.user.toString(), b]));
    const pendingByUser = new Map(pendingRequests.map((r) => [r.user.toString(), r]));

    const items = await Promise.all(
      users.map((u) => {
        const id = u._id?.toString() ?? '';
        const pending = pendingByUser.get(id);
        return buildBalanceListItem({
          id,
          name: u.name,
          email: u.email,
          avatar: u.avatar,
          role: u.role,
          tenantId: u.tenantId,
          balance: balanceByUser.get(id),
          pendingRequest: pending
            ? {
                requestId: pending._id.toString(),
                requestedAt: pending.requestedAt.toISOString(),
                reason: pending.reason,
              }
            : undefined,
        });
      }),
    );

    return { items, total };
  }

  async function listUsersWithBalanceHandler(req: ServerRequest, res: Response) {
    try {
      const rawSearch = req.query.search;
      const search = typeof rawSearch === 'string' ? rawSearch.trim() : '';

      if (search.length > MAX_SEARCH_LENGTH) {
        return res
          .status(400)
          .json({ error: `search must not exceed ${MAX_SEARCH_LENGTH} characters` });
      }

      const view = req.query.filter === 'requests' ? 'requests' : 'all';
      const { limit, offset } = parsePagination(req.query);

      const [{ items, total }, pendingCount] = await Promise.all([
        view === 'requests'
          ? listPendingRequestsView(search, limit, offset)
          : listAllUsersView(search, limit, offset),
        countPendingBalanceRequests(),
      ]);

      return res.status(200).json({ items, total, limit, offset, pendingCount });
    } catch (error) {
      logger.error('[adminBalance] listUsersWithBalance error:', error);
      return res.status(500).json({ error: 'Failed to list user balances' });
    }
  }

  async function addCreditHandler(req: ServerRequest, res: Response) {
    try {
      const { userId } = req.params as { userId: string };
      const { amount, idempotencyKey, requestId } = req.body as {
        amount?: number;
        idempotencyKey?: string;
        requestId?: string;
      };

      if (!isValidObjectIdString(userId)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }
      if (
        typeof amount !== 'number' ||
        !Number.isSafeInteger(amount) ||
        amount <= 0 ||
        amount > MAX_ADD_CREDIT_AMOUNT
      ) {
        return res.status(400).json({
          error: `amount must be a positive integer no greater than ${MAX_ADD_CREDIT_AMOUNT}`,
        });
      }
      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        return res.status(400).json({ error: 'idempotencyKey is required' });
      }
      if (requestId != null && !isValidObjectIdString(requestId)) {
        return res.status(400).json({ error: 'Invalid requestId format' });
      }

      // Verify the target user exists in the caller's tenant *before* touching
      // balance data — `applyIdempotentCredit`'s upsert will otherwise happily
      // create an orphan Balance document for any syntactically-valid ObjectId.
      const targetUser = await getUserById(userId, '_id name email role tenantId');
      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Resolve config for the TARGET user, not the caller — per-user/per-role
      // balance overrides are real and would otherwise be silently ignored.
      const appConfig = await getAppConfig({
        role: targetUser.role,
        userId: targetUser._id?.toString(),
        tenantId: targetUser.tenantId,
      });
      const balanceConfig = getBalanceConfig(appConfig);
      if (!balanceConfig?.enabled) {
        return res.status(400).json({ error: 'Balance is not enabled for this user' });
      }

      // Claim the request *before* crediting — not after. Two concurrent
      // calls for the same requestId (a double-click, or a client retry
      // racing the original) are also independently made safe below by
      // deriving the ledger idempotency key from `requestId` itself, but
      // the claim still matters: without it, a losing concurrent caller
      // would run `applyIdempotentCredit` (a no-op, thanks to the shared
      // key) and then redundantly attempt the audit write and resolve step
      // too, racing the winner for no benefit. Claiming the request first
      // turns that into a hard gate: a caller that loses the claim never
      // reaches `applyIdempotentCredit` at all, and gets a fast, explicit
      // 409 instead of silently duplicating work. The claim is a time-boxed
      // lease, not a terminal state, specifically so a crash (or a thrown
      // error) between here and the final resolve below leaves the request
      // `pending` with an expired lease — reclaimable by a retry — rather
      // than permanently stuck "resolved" with no credit behind it.
      let requestLeaseClaimed = false;
      if (requestId) {
        requestLeaseClaimed = await claimBalanceRequestResolution(requestId, userId);
        if (!requestLeaseClaimed) {
          return res.status(409).json({
            error: 'This request is already being resolved by another operation',
          });
        }
      }

      try {
        // Keyed off `requestId`, not the client-supplied `idempotencyKey`,
        // whenever one is present: a retry of this exact HTTP call (after a
        // crash, a timeout, or this handler's own 500 below) regenerates
        // `idempotencyKey` client-side, so keying the ledger off it alone
        // would let a retry apply a second full credit once the original
        // already landed — the request-resolution lease only ever
        // serializes *concurrent* callers, it does nothing for a sequential
        // retry that arrives after the lease was released. Deriving the
        // ledger key from the immutable `requestId` instead means every
        // retry for the same request converges on the same key, so
        // `applyIdempotentCredit`'s own ledger-level dedup (checked first,
        // before either persistence path, and durable regardless of lease
        // state) recognizes it as already-applied no matter how many
        // attempts came before.
        const creditIdempotencyKey = requestId ? `balance-request:${requestId}` : idempotencyKey;
        const { resultingBalance, applied, transactionId } = await applyIdempotentCredit({
          user: userId,
          incrementValue: amount,
          idempotencyKey: creditIdempotencyKey,
          context: 'admin',
        });

        // Claimed independently of `applied`/ledger-freshness — a crash between
        // the ledger write and this audit write, on a *prior* attempt, must
        // still be repairable by a later retry. `claimAuditRecording` only
        // claims the *attempt*, with a time-boxed, recoverable lease — it never
        // sets the permanent `auditRecorded` flag itself, so a failed or
        // interrupted write below never gets permanently skipped on retry.
        const shouldWriteAudit = await claimAuditRecording(transactionId);

        if (shouldWriteAudit) {
          const adminId = req.user?._id?.toString() ?? req.user?.id ?? '';
          const adminName = req.user?.name ?? req.user?.email ?? 'admin';
          let auditEntry: IAuditLog | null = null;
          try {
            auditEntry = await recordAuditEntry({
              action: 'balance.credit_added',
              actor: { type: 'user', id: adminId, name: adminName },
              target: {
                type: 'user',
                id: userId,
                name: targetUser.name ?? targetUser.email ?? '',
              },
              metadata: { amount, resultingBalance, requestId: requestId ?? null },
              tenantId: targetUser.tenantId,
            });
          } catch (auditError) {
            logger.error('[adminBalance] audit write failed:', auditError);
          }

          // `auditRecorded` is only ever set after a *confirmed* write — never
          // before it — so a thrown error or a fail-open `null` return here
          // leaves it unset and releases the lease instead, letting the very
          // next retry (of this request, or a repair job) reclaim and repair
          // it rather than seeing a permanently "done" flag with no entry
          // behind it.
          if (auditEntry != null) {
            await markAuditRecorded(transactionId);
          } else {
            await releaseAuditRecordingLease(transactionId);
          }
        }

        let requestAlreadyResolved = false;
        if (requestId) {
          const adminId = req.user?._id?.toString() ?? req.user?.id ?? '';
          const resolved = await resolveBalanceRequestIfPending(requestId, userId, {
            resolvedBy: adminId,
            resolvedAmount: amount,
          });
          requestAlreadyResolved = resolved == null;
        }

        return res.status(200).json({
          resultingBalance,
          creditAlreadyApplied: !applied,
          requestAlreadyResolved,
        });
      } catch (innerError) {
        if (requestLeaseClaimed && requestId) {
          try {
            await releaseBalanceRequestResolutionLease(requestId);
          } catch (releaseError) {
            logger.error(
              '[adminBalance] failed to release balance request resolution lease:',
              releaseError,
            );
          }
        }
        throw innerError;
      }
    } catch (error) {
      logger.error('[adminBalance] addCredit error:', error);
      return res.status(500).json({ error: 'Failed to add credit' });
    }
  }

  return {
    listUsersWithBalance: listUsersWithBalanceHandler,
    addCredit: addCreditHandler,
  };
}
