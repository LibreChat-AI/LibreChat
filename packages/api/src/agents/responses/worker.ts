import type { TurnConversationRequest } from '~/conversations/save';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { getTenantId, tenantStorage } from '@librechat/data-schemas';
import type { IUser, ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { Request, RequestHandler } from 'express';
import type { ResumedAgentExecutionIdentity } from '../remote/lifecycle';
import type { ResponseResumeAdmissionResult } from './types';
import type { ContextRequest } from '~/middleware/tenant';
import type { ServerRequest } from '~/types/http';
import { checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { responseTenantId, isResponseTenantId } from './scope';
import { tenantContextMiddleware } from '~/middleware/tenant';

const audience = 'librechat-responses-worker';
const purpose = 'responses_background';
const resumePurpose = 'responses_resume';
export const RESPONSE_WORKER_TOKEN_EXPIRED = 'response_worker_token_expired';
// Per-attempt security window, not a limit on durable queue work; expiration renews the credential.
const workerTokenLifetime = '60s';
const baseClaims = z.object({
  responseId: z.string().min(1),
  userId: z.string().min(1),
  tenantId: z.string().min(1).refine(isResponseTenantId).optional(),
  sourceKeyId: z.string().min(1),
});
const claimsSchema = z.discriminatedUnion('purpose', [
  baseClaims.extend({ purpose: z.literal(purpose) }),
  baseClaims.extend({
    purpose: z.literal(resumePurpose),
    intentId: z.string().min(1).max(256),
    generationCreatedAt: z.number().int().positive(),
    providerExecutionId: z.string().min(1).max(128),
  }),
]);
type WorkerClaims = z.infer<typeof claimsSchema>;
type WorkerTokenError = 'invalid_response_worker' | typeof RESPONSE_WORKER_TOKEN_EXPIRED;
type WorkerTokenResult =
  | { ok: true; value: WorkerClaims }
  | { ok: false; error: { code: WorkerTokenError } };

function verifyWorkerToken(token: string, secret: string): WorkerTokenResult {
  const verification: jwt.VerifyOptions = { algorithms: ['HS256'], audience };
  try {
    const parsed = claimsSchema.safeParse(jwt.verify(token, secret, verification));
    if (parsed.success) return { ok: true, value: parsed.data };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      try {
        // verify() checks expiration before audience. Revalidate every other constraint before
        // treating this as a renewable credential rather than a forged or malformed request.
        const expired = claimsSchema.safeParse(
          jwt.verify(token, secret, {
            ...verification,
            ignoreExpiration: true,
          }),
        );
        if (expired.success) return { ok: false, error: { code: RESPONSE_WORKER_TOKEN_EXPIRED } };
      } catch {
        // Invalid signatures, audiences, purposes and claim shapes remain permanent denials.
      }
    }
  }
  return { ok: false, error: { code: 'invalid_response_worker' } };
}

interface WorkerAdmission {
  record: StoredResponseRecord;
  storage: ResponseStorage;
  interactive: boolean;
  resume?: ResumedAgentExecutionIdentity & { intentId: string; checkpointNamespace: string };
}
const admitted = new WeakMap<Request, WorkerAdmission>();

export interface BackgroundResponseWorkerDependencies {
  storage: ResponseStorage;
  signingSecret: () => string;
  findUser: (userId: string) => Promise<IUser | null>;
  /** Check original key existence/expiry, current principal, and resolved auth/Agent policy. */
  authorize: (record: StoredResponseRecord, user: IUser) => Promise<boolean>;
  /** Install only alongside a capable resume executor and complete current checkpoint validation. */
  admitResume?: (
    record: StoredResponseRecord,
    user: IUser,
    intentId: string,
  ) => Promise<ResponseResumeAdmissionResult>;
  onError: (error: unknown) => void;
}

/** Distinct purpose is rejected by older initial-execution workers, not silently stripped. */
export function mintResponseResumeWorkerToken(
  record: StoredResponseRecord,
  secret: string,
): string {
  if (
    !record.sourceKeyId ||
    !secret ||
    !record.resume ||
    record.generationCreatedAt == null ||
    !isResponseTenantId(record.tenantId)
  )
    throw new Error('Response resume worker authority unavailable');
  return jwt.sign(
    {
      purpose: resumePurpose,
      responseId: record.responseId,
      userId: record.userId,
      ...(responseTenantId(record.tenantId) == null
        ? {}
        : { tenantId: responseTenantId(record.tenantId) }),
      sourceKeyId: record.sourceKeyId,
      intentId: record.resume.intentId,
      generationCreatedAt: record.generationCreatedAt,
      providerExecutionId: record.resume.providerExecutionId,
    },
    secret,
    { algorithm: 'HS256', audience, expiresIn: workerTokenLifetime },
  );
}

/** A worker credential is server-only, short-lived, and bound to a single API-key-authenticated response. */
export function mintBackgroundResponseWorkerToken(
  record: StoredResponseRecord,
  secret: string,
): string {
  if (!record.sourceKeyId || !secret || !isResponseTenantId(record.tenantId))
    throw new Error('Background response worker authority unavailable');
  return jwt.sign(
    {
      purpose,
      responseId: record.responseId,
      userId: record.userId,
      ...(responseTenantId(record.tenantId) == null
        ? {}
        : { tenantId: responseTenantId(record.tenantId) }),
      sourceKeyId: record.sourceKeyId,
    },
    secret,
    { algorithm: 'HS256', audience, expiresIn: workerTokenLifetime },
  );
}

export function getBackgroundResponseWorkerRecord(req: Request): StoredResponseRecord | undefined {
  return admitted.get(req)?.record;
}

export function getBackgroundResponseWorkerAdmission(req: Request): WorkerAdmission | undefined {
  return admitted.get(req);
}

/** Installed only on Responses ingress. Ordinary bearer authentication stays unchanged. */
export function createBackgroundResponseWorkerAuth(
  deps: BackgroundResponseWorkerDependencies,
  ordinaryAuth: RequestHandler,
): RequestHandler {
  return async (req, res, next) => {
    if (req.headers['x-lc-response-worker'] !== '1') return ordinaryAuth(req, res, next);
    const deny = (code: WorkerTokenError = 'invalid_response_worker') => {
      res.status(401).json({ error: { code, message: 'Unauthorized' } });
    };
    if (req.method !== 'POST' || req.path !== '/') return deny();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return deny();
    let claims: WorkerClaims;
    try {
      const verified = verifyWorkerToken(header.slice(7), deps.signingSecret());
      if (!verified.ok) return deny(verified.error.code);
      claims = verified.value;
    } catch {
      return deny();
    }
    const contextTenant = getTenantId();
    if (
      responseTenantId(contextTenant) != null &&
      responseTenantId(contextTenant) !== claims.tenantId
    )
      return deny();
    try {
      await tenantStorage.run({ tenantId: claims.tenantId, userId: claims.userId }, async () => {
        const [loaded, user] = await Promise.all([
          deps.storage.read(claims, claims.responseId),
          deps.findUser(claims.userId),
        ]);
        let record = loaded;
        if (
          !record ||
          !user ||
          String(user._id) !== record.userId ||
          !isResponseTenantId(user.tenantId) ||
          !isResponseTenantId(record.tenantId) ||
          responseTenantId(user.tenantId) !== claims.tenantId ||
          responseTenantId(record.tenantId) !== claims.tenantId ||
          record.sourceKeyId !== claims.sourceKeyId ||
          !(await deps.authorize(record, user))
        )
          return deny();
        // Initial delivery replay only attaches. Never let an expired generation claim
        // turn an already-enrolled (possibly paused/resumed) response into a replacement job.
        if (claims.purpose === purpose && record.generationCreatedAt != null) {
          res.status(409).json({ code: 'RUN_ALREADY_ADMITTED' });
          return;
        }
        let resume: WorkerAdmission['resume'];
        if (claims.purpose === resumePurpose) {
          const original = record;
          if (
            !deps.admitResume ||
            record.generationCreatedAt !== claims.generationCreatedAt ||
            record.resume?.intentId !== claims.intentId ||
            record.resume.providerExecutionId !== claims.providerExecutionId
          )
            return deny();
          const result = await deps.admitResume(record, user, claims.intentId);
          if (!result.ok) return deny();
          record = result.record;
          if (
            record.responseId !== claims.responseId ||
            record.userId !== claims.userId ||
            !isResponseTenantId(record.tenantId) ||
            responseTenantId(record.tenantId) !== claims.tenantId ||
            record.sourceKeyId !== claims.sourceKeyId ||
            record.generationCreatedAt !== claims.generationCreatedAt ||
            record.agentId !== original.agentId ||
            record.conversationId !== original.conversationId ||
            record.requestJSON !== original.requestJSON ||
            record.resume?.intentId !== claims.intentId ||
            record.resume.providerExecutionId !== claims.providerExecutionId ||
            record.resume.state !== 'admitted' ||
            record.status !== 'in_progress' ||
            record.cancellationRequestedAt != null ||
            !result.checkpointNamespace.startsWith(
              checkpointOwnerNamespacePrefix(record.userId, record.tenantId),
            ) ||
            !(await deps.authorize(record, user))
          )
            return deny();
          resume = {
            intentId: claims.intentId,
            generationCreatedAt: claims.generationCreatedAt,
            providerExecutionId: claims.providerExecutionId,
            checkpointNamespace: result.checkpointNamespace,
          };
        }
        const request = req as ServerRequest &
          Pick<ContextRequest, 'tenantId'> &
          TurnConversationRequest;
        // findUser supplies a lean auth DTO; do not mutate its cached tenant representation.
        request.user = Object.assign({}, user, { id: record.userId, tenantId: claims.tenantId });
        request.tenantId = claims.tenantId;
        // Caller body/headers cannot replace the persisted, already validated request.
        request.body = JSON.parse(record.requestJSON);
        if (record.expiredAt)
          request._agentEventBindingRetention = {
            expiredAt: record.expiredAt,
            isTemporary: record.isTemporary,
          };
        admitted.set(req, {
          record,
          storage: deps.storage,
          interactive: deps.admitResume != null,
          ...(resume ? { resume } : {}),
        });
        tenantContextMiddleware(request, res, next);
      });
    } catch (error) {
      deps.onError(error);
      res.status(503).json({
        error: {
          code: 'response_authority_unavailable',
          message: 'Response authority is unavailable.',
        },
      });
    }
  };
}
