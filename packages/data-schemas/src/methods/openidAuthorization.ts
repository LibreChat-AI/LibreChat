import type { Connection, Model, Types } from 'mongoose';
import type { AuthorizationQueryOptions } from '~/utils/mongoEngine';
import type * as t from '~/types';
import { createOpenIDAuthorizationModels } from '~/models/openidAuthorization';
import { requireNormalizedOpenIdIssuer } from '~/utils/openidIssuer';
import { createIndexesWithRetry } from '~/utils/retry';
import logger from '~/config/winston';

/** `undefined`, `null` and `''` all store and query as the same value: no tenant. */
function normalizeOpenIDTenantId(tenantId: string | null | undefined): string | null {
  return tenantId ? tenantId : null;
}

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

type DuplicateKeyOutcome<TResult> = { retry: true } | { retry: false; result: TResult };

/** Retries an upsert once on E11000 from a racing writer; `onDuplicateKey` may short-circuit
 *  with a result instead of retrying. */
async function withDuplicateKeyRetry<TResult>(
  operation: () => Promise<TResult>,
  onDuplicateKey?: () => Promise<DuplicateKeyOutcome<TResult>>,
): Promise<TResult> {
  try {
    return await operation();
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    if (onDuplicateKey) {
      const outcome = await onDuplicateKey();
      if (!outcome.retry) {
        return outcome.result;
      }
    }
    return await operation();
  }
}

export interface OpenIDSessionDenialInput {
  sessionRevokedAt?: Date | null;
  /** Epoch seconds, from the session's earliest recorded login. */
  sessionFirstLoginIat?: number | null;
  /** Epoch seconds, from the subject boundary's logout-token `iat`. */
  subjectBoundaryIat?: number | null;
}

/** Missing firstLoginIat with a boundary is denied. */
export function isOpenIDSessionDenied(input: OpenIDSessionDenialInput): boolean {
  if (input.sessionRevokedAt != null) {
    return true;
  }
  if (input.subjectBoundaryIat == null) {
    return false;
  }
  if (input.sessionFirstLoginIat == null) {
    return true;
  }
  return input.subjectBoundaryIat >= input.sessionFirstLoginIat;
}

export interface OpenIDAuthorizationMethods {
  upsertOpenIDSubjectBoundary: (data: t.OpenIDSubjectBoundaryInput) => Promise<t.IOpenIDSubject>;
  findOpenIDSubject: (query: t.OpenIDSubjectQuery) => Promise<t.IOpenIDSubject | null>;
  recordOpenIDLogin: (data: t.OpenIDSessionLoginInput) => Promise<t.OpenIDSessionLoginResult>;
  recordOpenIDLogout: (data: t.OpenIDSessionLogoutInput) => Promise<t.IOpenIDSession>;
  findOpenIDSession: (query: t.OpenIDSessionQuery) => Promise<t.IOpenIDSession | null>;
  findOpenIDSessionById: (id: Types.ObjectId | string) => Promise<t.IOpenIDSession | null>;
  revokeOpenIDSessionById: (
    id: Types.ObjectId | string,
    revokedAt: Date,
  ) => Promise<t.IOpenIDSession | null>;
  upsertOpenIDBinding: (data: t.OpenIDBindingInput) => Promise<t.IOpenIDBinding>;
  findOpenIDBinding: (query: t.OpenIDBindingQuery) => Promise<t.IOpenIDBinding | null>;
  findOpenIDBindingBySid: (query: t.OpenIDBindingBySidQuery) => Promise<t.IOpenIDBinding | null>;
  recordOpenIDLogoutEvent: (
    data: t.OpenIDLogoutEventInput,
  ) => Promise<t.OpenIDLogoutEventRecordResult>;
  markOpenIDLogoutEventEnforced: (
    input: t.OpenIDLogoutEventEnforceInput,
  ) => Promise<t.IOpenIDLogout | null>;
  findOpenIDLogoutEvent: (query: t.OpenIDLogoutEventQuery) => Promise<t.IOpenIDLogout | null>;
  listPendingLogoutEvents: (limit: number) => Promise<t.IOpenIDLogout[]>;
}

/** Opens no connection itself; the caller owns the authorization connection's lifecycle. */
export function createOpenIDAuthorizationMethods(
  connection: Connection,
  queryOptions: AuthorizationQueryOptions,
): OpenIDAuthorizationMethods {
  const { OpenIDSubject, OpenIDSession, OpenIDBinding, OpenIDLogout } =
    createOpenIDAuthorizationModels(connection);
  const readOptions = queryOptions.read;
  const writeOptions = queryOptions.write;
  /** Linearizable read concern is valid only for a single-document read. */
  const listReadOptions =
    readOptions.readConcern?.level === 'linearizable'
      ? { ...readOptions, readConcern: { level: 'majority' as const } }
      : readOptions;

  let indexesPromise: Promise<void> | null = null;
  function ensureIndexes(): Promise<void> {
    if (!indexesPromise) {
      indexesPromise = Promise.all(
        [OpenIDSubject, OpenIDSession, OpenIDBinding, OpenIDLogout].map((model) =>
          createIndexesWithRetry(model as unknown as Model<unknown>),
        ),
      )
        .then(() => undefined)
        .catch((error) => {
          indexesPromise = null;
          throw error;
        });
    }
    return indexesPromise;
  }

  async function upsertOpenIDSubjectBoundary(
    data: t.OpenIDSubjectBoundaryInput,
  ): Promise<t.IOpenIDSubject> {
    await ensureIndexes();
    const issuer = requireNormalizedOpenIdIssuer(data.issuer);
    const attempt = () =>
      OpenIDSubject.findOneAndUpdate(
        { issuer, clientId: data.clientId, subject: data.subject },
        {
          $setOnInsert: { issuer, clientId: data.clientId, subject: data.subject },
          $max: { boundaryIat: data.boundaryIat },
        },
        { upsert: true, new: true, ...writeOptions },
      ).lean<t.IOpenIDSubject>();
    try {
      return (await withDuplicateKeyRetry(attempt)) as t.IOpenIDSubject;
    } catch (error) {
      logger.debug('[upsertOpenIDSubjectBoundary] Error upserting subject boundary:', error);
      throw error;
    }
  }

  async function findOpenIDSubject(query: t.OpenIDSubjectQuery): Promise<t.IOpenIDSubject | null> {
    try {
      return await OpenIDSubject.findOne(
        { ...query, issuer: requireNormalizedOpenIdIssuer(query.issuer) },
        undefined,
        readOptions,
      ).lean<t.IOpenIDSubject>();
    } catch (error) {
      logger.debug('[findOpenIDSubject] Error finding subject:', error);
      throw error;
    }
  }

  async function recordOpenIDLogin(
    data: t.OpenIDSessionLoginInput,
  ): Promise<t.OpenIDSessionLoginResult> {
    await ensureIndexes();
    const issuer = requireNormalizedOpenIdIssuer(data.issuer);
    const attempt = async (): Promise<t.OpenIDSessionLoginResult> => {
      const session = await OpenIDSession.findOneAndUpdate(
        { issuer, clientId: data.clientId, sid: data.sid, subject: data.subject },
        {
          $setOnInsert: {
            issuer,
            clientId: data.clientId,
            subject: data.subject,
            sid: data.sid,
            createdAt: data.now ?? new Date(),
          },
          $min: { firstLoginIat: data.loginIat },
        },
        { upsert: true, new: true, ...writeOptions },
      ).lean<t.IOpenIDSession>();
      return { ok: true, session: session as t.IOpenIDSession };
    };
    try {
      return await withDuplicateKeyRetry<t.OpenIDSessionLoginResult>(attempt, async () => {
        const existing = await OpenIDSession.findOne(
          { issuer, clientId: data.clientId, sid: data.sid },
          undefined,
          readOptions,
        ).lean<t.IOpenIDSession>();
        if (existing && existing.subject !== data.subject) {
          return { retry: false, result: { ok: false, error: { code: 'subject_mismatch' } } };
        }
        return { retry: true };
      });
    } catch (error) {
      logger.debug('[recordOpenIDLogin] Error recording login:', error);
      throw error;
    }
  }

  async function recordOpenIDLogout(data: t.OpenIDSessionLogoutInput): Promise<t.IOpenIDSession> {
    await ensureIndexes();
    const issuer = requireNormalizedOpenIdIssuer(data.issuer);
    const attempt = () =>
      OpenIDSession.findOneAndUpdate(
        { issuer, clientId: data.clientId, sid: data.sid },
        {
          $setOnInsert: {
            issuer,
            clientId: data.clientId,
            subject: data.subject,
            sid: data.sid,
            createdAt: data.revokedAt,
          },
          $min: { revokedAt: data.revokedAt },
        },
        { upsert: true, new: true, ...writeOptions },
      ).lean<t.IOpenIDSession>();
    try {
      const revoked = await withDuplicateKeyRetry(attempt);
      if (revoked?.revokedAt == null) {
        throw new Error('recordOpenIDLogout: upserted session has no revokedAt');
      }
      return revoked;
    } catch (error) {
      logger.debug('[recordOpenIDLogout] Error revoking session:', error);
      throw error;
    }
  }

  async function findOpenIDSession(query: t.OpenIDSessionQuery): Promise<t.IOpenIDSession | null> {
    try {
      return await OpenIDSession.findOne(
        { ...query, issuer: requireNormalizedOpenIdIssuer(query.issuer) },
        undefined,
        readOptions,
      ).lean<t.IOpenIDSession>();
    } catch (error) {
      logger.debug('[findOpenIDSession] Error finding session:', error);
      throw error;
    }
  }

  async function findOpenIDSessionById(
    id: Types.ObjectId | string,
  ): Promise<t.IOpenIDSession | null> {
    try {
      return await OpenIDSession.findById(id, undefined, readOptions).lean<t.IOpenIDSession>();
    } catch (error) {
      logger.debug('[findOpenIDSessionById] Error finding session:', error);
      throw error;
    }
  }

  /** Returns null when no session exists for `id`; never creates one. */
  async function revokeOpenIDSessionById(
    id: Types.ObjectId | string,
    revokedAt: Date,
  ): Promise<t.IOpenIDSession | null> {
    try {
      return await OpenIDSession.findByIdAndUpdate(
        id,
        { $min: { revokedAt } },
        { new: true, ...writeOptions },
      ).lean<t.IOpenIDSession>();
    } catch (error) {
      logger.debug('[revokeOpenIDSessionById] Error revoking session:', error);
      throw error;
    }
  }

  /** Denormalizes the session's identity onto the binding so a `sid` cache miss can read the
   *  binding without first resolving the session's ObjectId. */
  async function upsertOpenIDBinding(data: t.OpenIDBindingInput): Promise<t.IOpenIDBinding> {
    await ensureIndexes();
    const session = await OpenIDSession.findById(
      data.sessionId,
      undefined,
      readOptions,
    ).lean<t.IOpenIDSession>();
    if (!session) {
      throw new Error('upsertOpenIDBinding: no session for sessionId');
    }
    const tenantId = normalizeOpenIDTenantId(data.tenantId);
    const attempt = () =>
      OpenIDBinding.findOneAndUpdate(
        { sessionId: data.sessionId, user: data.user, tenantId },
        {
          $setOnInsert: {
            sessionId: data.sessionId,
            user: data.user,
            tenantId,
            issuer: session.issuer,
            clientId: session.clientId,
            sid: session.sid,
            createdAt: new Date(),
          },
        },
        { upsert: true, new: true, ...writeOptions },
      ).lean<t.IOpenIDBinding>();
    try {
      return (await withDuplicateKeyRetry(attempt)) as t.IOpenIDBinding;
    } catch (error) {
      logger.debug('[upsertOpenIDBinding] Error upserting binding:', error);
      throw error;
    }
  }

  async function findOpenIDBinding(query: t.OpenIDBindingQuery): Promise<t.IOpenIDBinding | null> {
    try {
      return await OpenIDBinding.findOne(
        {
          sessionId: query.sessionId,
          user: query.user,
          tenantId: normalizeOpenIDTenantId(query.tenantId),
        },
        undefined,
        readOptions,
      ).lean<t.IOpenIDBinding>();
    } catch (error) {
      logger.debug('[findOpenIDBinding] Error finding binding:', error);
      throw error;
    }
  }

  /** Resolves a binding directly from `sid`, in parallel with the session read; never needs the
   *  session's ObjectId. */
  async function findOpenIDBindingBySid(
    query: t.OpenIDBindingBySidQuery,
  ): Promise<t.IOpenIDBinding | null> {
    try {
      return await OpenIDBinding.findOne(
        {
          issuer: requireNormalizedOpenIdIssuer(query.issuer),
          clientId: query.clientId,
          sid: query.sid,
          user: query.user,
          tenantId: normalizeOpenIDTenantId(query.tenantId),
        },
        undefined,
        readOptions,
      ).lean<t.IOpenIDBinding>();
    } catch (error) {
      logger.debug('[findOpenIDBindingBySid] Error finding binding:', error);
      throw error;
    }
  }

  async function recordOpenIDLogoutEvent(
    data: t.OpenIDLogoutEventInput,
  ): Promise<t.OpenIDLogoutEventRecordResult> {
    await ensureIndexes();
    const issuer = requireNormalizedOpenIdIssuer(data.issuer);
    const attempt = () =>
      OpenIDLogout.findOneAndUpdate(
        { issuer, clientId: data.clientId, jti: data.jti },
        {
          $setOnInsert: {
            issuer,
            clientId: data.clientId,
            subject: data.subject,
            sid: data.sid,
            boundaryIat: data.boundaryIat,
            jti: data.jti,
            receivedAt: data.receivedAt,
            state: 'received',
          },
        },
        { upsert: true, new: true, includeResultMetadata: true, ...writeOptions },
      );
    try {
      const result = await withDuplicateKeyRetry(attempt);
      if (result.value == null) {
        throw new Error('recordOpenIDLogoutEvent: upsert returned no document');
      }
      return {
        created: result.lastErrorObject?.upserted != null,
        event: result.value.toObject() as t.IOpenIDLogout,
      };
    } catch (error) {
      logger.debug('[recordOpenIDLogoutEvent] Error recording logout event:', error);
      throw error;
    }
  }

  async function markOpenIDLogoutEventEnforced(
    input: t.OpenIDLogoutEventEnforceInput,
  ): Promise<t.IOpenIDLogout | null> {
    try {
      return await OpenIDLogout.findOneAndUpdate(
        {
          issuer: requireNormalizedOpenIdIssuer(input.issuer),
          clientId: input.clientId,
          jti: input.jti,
          state: 'received',
        },
        { $set: { state: 'enforced', ...(input.expiresAt && { expiresAt: input.expiresAt }) } },
        { new: true, ...writeOptions },
      ).lean<t.IOpenIDLogout>();
    } catch (error) {
      logger.debug('[markOpenIDLogoutEventEnforced] Error enforcing logout event:', error);
      throw error;
    }
  }

  async function findOpenIDLogoutEvent(
    query: t.OpenIDLogoutEventQuery,
  ): Promise<t.IOpenIDLogout | null> {
    try {
      return await OpenIDLogout.findOne(
        { ...query, issuer: requireNormalizedOpenIdIssuer(query.issuer) },
        undefined,
        readOptions,
      ).lean<t.IOpenIDLogout>();
    } catch (error) {
      logger.debug('[findOpenIDLogoutEvent] Error finding logout event:', error);
      throw error;
    }
  }

  async function listPendingLogoutEvents(limit: number): Promise<t.IOpenIDLogout[]> {
    try {
      return await OpenIDLogout.find({ state: 'received' }, undefined, listReadOptions)
        .sort({ receivedAt: 1 })
        .limit(limit)
        .lean<t.IOpenIDLogout[]>();
    } catch (error) {
      logger.debug('[listPendingLogoutEvents] Error listing pending logout events:', error);
      throw error;
    }
  }

  return {
    upsertOpenIDSubjectBoundary,
    findOpenIDSubject,
    recordOpenIDLogin,
    recordOpenIDLogout,
    findOpenIDSession,
    findOpenIDSessionById,
    revokeOpenIDSessionById,
    upsertOpenIDBinding,
    findOpenIDBinding,
    findOpenIDBindingBySid,
    recordOpenIDLogoutEvent,
    markOpenIDLogoutEventEnforced,
    findOpenIDLogoutEvent,
    listPendingLogoutEvents,
  };
}
