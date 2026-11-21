import type { Model } from 'mongoose';
import type {
  IProviderSession,
  ProviderSessionOperationData,
  ProviderSessionEstablishResult,
  ProviderSessionAuthorizeResult,
  ProviderSessionRevokeResult,
} from '~/types';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

function hasErrorCode(error: unknown): error is { code: number } {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'number'
  );
}

function isDuplicateKeyError(error: unknown): boolean {
  return hasErrorCode(error) && error.code === 11000;
}

const MAJORITY_WRITE_CONCERN = { writeConcern: { w: 'majority' as const } };

/** `expiresAt` is a cleanup deadline the caller must set in the future; a past or equal value
 *  is a caller bug, not an expected outcome. */
function assertFutureExpiry(expiresAt: Date, now: Date, context: string): void {
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error(`[${context}] expiresAt (${expiresAt.toISOString()}) must be after now`);
  }
}

export function createProviderSessionMethods(mongoose: typeof import('mongoose')): {
  establishProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionEstablishResult>;
  authorizeProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionAuthorizeResult>;
  revokeProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionRevokeResult>;
} {
  let indexesPromise: Promise<void> | null = null;

  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      const ProviderSession = mongoose.models.ProviderSession as Model<IProviderSession>;
      indexesPromise = createIndexesWithRetry(ProviderSession).catch((error) => {
        indexesPromise = null;
        throw error;
      });
    }
    return indexesPromise;
  }

  /** Matches only when the stored subject, if any, agrees with the one supplied here. */
  function subjectFilter(subject: string | undefined): Record<string, unknown> {
    return subject != null ? { $or: [{ subject: { $exists: false } }, { subject }] } : {};
  }

  async function establishProviderSession(
    data: ProviderSessionOperationData,
  ): Promise<ProviderSessionEstablishResult> {
    const { issuer, clientId, sid, subject, expiresAt } = data;
    const now = data.now ?? new Date();
    assertFutureExpiry(expiresAt, now, 'establishProviderSession');
    const ProviderSession = mongoose.models.ProviderSession as Model<IProviderSession>;
    await ensureIndexes();

    const attemptUpsert = () =>
      ProviderSession.findOneAndUpdate(
        {
          issuer,
          clientId,
          sid,
          revokedAt: { $exists: false },
          expiresAt: { $gt: now },
          ...subjectFilter(subject),
        },
        {
          $max: { expiresAt },
          ...(subject != null ? { $set: { subject } } : {}),
          $setOnInsert: { issuer, clientId, sid, createdAt: now },
        },
        { upsert: true, new: true, ...MAJORITY_WRITE_CONCERN },
      );

    try {
      const established = await attemptUpsert();
      if (established) {
        return { ok: true };
      }
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger.debug('[establishProviderSession] Error establishing session:', error);
        throw error;
      }
    }

    /** A record with this key exists but did not satisfy the filter above: classify it. */
    try {
      const existing = await ProviderSession.findOne({ issuer, clientId, sid })
        .read('primary')
        .lean<IProviderSession>();

      if (!existing) {
        /** Removed by TTL between the write above and this read: retry once. */
        const retried = await attemptUpsert();
        return retried ? { ok: true } : { ok: false, code: 'CONFLICT' };
      }
      if (existing.revokedAt) {
        return { ok: false, code: 'ENDED' };
      }
      if (subject != null && existing.subject != null && existing.subject !== subject) {
        return { ok: false, code: 'CONFLICT' };
      }

      const reactivated = await ProviderSession.findOneAndUpdate(
        { issuer, clientId, sid, revokedAt: { $exists: false }, ...subjectFilter(subject) },
        {
          $max: { expiresAt },
          ...(subject != null ? { $set: { subject } } : {}),
        },
        { new: true, ...MAJORITY_WRITE_CONCERN },
      );
      if (reactivated) {
        return { ok: true };
      }

      const recheck = await ProviderSession.findOne({ issuer, clientId, sid })
        .read('primary')
        .lean<IProviderSession>();
      return recheck?.revokedAt ? { ok: false, code: 'ENDED' } : { ok: false, code: 'CONFLICT' };
    } catch (error) {
      logger.debug('[establishProviderSession] Error classifying conflict:', error);
      throw error;
    }
  }

  async function authorizeProviderSession(
    data: ProviderSessionOperationData,
  ): Promise<ProviderSessionAuthorizeResult> {
    const { issuer, clientId, sid, subject, expiresAt } = data;
    const now = data.now ?? new Date();
    assertFutureExpiry(expiresAt, now, 'authorizeProviderSession');
    const ProviderSession = mongoose.models.ProviderSession as Model<IProviderSession>;
    await ensureIndexes();

    try {
      const authorized = await ProviderSession.findOneAndUpdate(
        {
          issuer,
          clientId,
          sid,
          revokedAt: { $exists: false },
          expiresAt: { $gt: now },
          ...subjectFilter(subject),
        },
        { $max: { expiresAt } },
        { new: true, ...MAJORITY_WRITE_CONCERN },
      );
      if (authorized) {
        return { ok: true };
      }

      const existing = await ProviderSession.findOne({ issuer, clientId, sid })
        .read('primary')
        .lean<IProviderSession>();
      if (!existing) {
        return { ok: false, code: 'MISSING' };
      }
      if (existing.revokedAt) {
        return { ok: false, code: 'ENDED' };
      }
      if (existing.expiresAt <= now) {
        return { ok: false, code: 'MISSING' };
      }
      if (subject != null && existing.subject != null && existing.subject !== subject) {
        return { ok: false, code: 'CONFLICT' };
      }
      return { ok: false, code: 'MISSING' };
    } catch (error) {
      logger.debug('[authorizeProviderSession] Error authorizing session:', error);
      throw error;
    }
  }

  async function revokeProviderSession(
    data: ProviderSessionOperationData,
  ): Promise<ProviderSessionRevokeResult> {
    const { issuer, clientId, sid, subject, expiresAt } = data;
    const now = data.now ?? new Date();
    assertFutureExpiry(expiresAt, now, 'revokeProviderSession');
    const ProviderSession = mongoose.models.ProviderSession as Model<IProviderSession>;
    await ensureIndexes();

    const filter = { issuer, clientId, sid, ...subjectFilter(subject) };
    const update = {
      $min: { revokedAt: now },
      $max: { expiresAt },
      $setOnInsert: {
        issuer,
        clientId,
        sid,
        createdAt: now,
        ...(subject != null ? { subject } : {}),
      },
    };

    try {
      const revoked = await ProviderSession.findOneAndUpdate(filter, update, {
        upsert: true,
        new: true,
        ...MAJORITY_WRITE_CONCERN,
      });
      if (revoked) {
        return { ok: true };
      }
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        logger.debug('[revokeProviderSession] Error revoking session:', error);
        throw error;
      }
    }

    /** The key exists now; the upsert above raced another writer. Re-run without upsert. */
    try {
      const retried = await ProviderSession.findOneAndUpdate(
        filter,
        update,
        MAJORITY_WRITE_CONCERN,
      );
      if (retried) {
        return { ok: true };
      }

      const existing = await ProviderSession.findOne({ issuer, clientId, sid })
        .read('primary')
        .lean<IProviderSession>();
      if (subject != null && existing?.subject != null && existing.subject !== subject) {
        return { ok: false, code: 'SUBJECT_MISMATCH' };
      }

      /** No real subject conflict: the stored record carries no subject, so this revoke
       *  still applies, by key alone. */
      const final = await ProviderSession.findOneAndUpdate(
        { issuer, clientId, sid },
        update,
        MAJORITY_WRITE_CONCERN,
      );
      if (!final) {
        throw new Error('[revokeProviderSession] final update matched no document');
      }
      return { ok: true };
    } catch (error) {
      logger.debug('[revokeProviderSession] Error revoking session:', error);
      throw error;
    }
  }

  return {
    establishProviderSession,
    authorizeProviderSession,
    revokeProviderSession,
  };
}

export type ProviderSessionMethods = ReturnType<typeof createProviderSessionMethods>;
