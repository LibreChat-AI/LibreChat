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
import { tenantContextMiddleware } from '~/middleware/tenant';

const audience = 'librechat-responses-worker';
const purpose = 'responses_background';
const resumePurpose = 'responses_resume';
const baseClaims = z.object({
  responseId: z.string().min(1),
  userId: z.string().min(1),
  tenantId: z.string().min(1).optional(),
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
  if (!record.sourceKeyId || !secret || !record.resume || record.generationCreatedAt == null)
    throw new Error('Response resume worker authority unavailable');
  return jwt.sign(
    {
      purpose: resumePurpose,
      responseId: record.responseId,
      userId: record.userId,
      ...(record.tenantId == null ? {} : { tenantId: record.tenantId }),
      sourceKeyId: record.sourceKeyId,
      intentId: record.resume.intentId,
      generationCreatedAt: record.generationCreatedAt,
      providerExecutionId: record.resume.providerExecutionId,
    },
    secret,
    { algorithm: 'HS256', audience, expiresIn: '60s' },
  );
}

/** A worker credential is server-only, short-lived, and bound to a single API-key-authenticated response. */
export function mintBackgroundResponseWorkerToken(
  record: StoredResponseRecord,
  secret: string,
): string {
  if (!record.sourceKeyId || !secret)
    throw new Error('Background response worker authority unavailable');
  return jwt.sign(
    {
      purpose,
      responseId: record.responseId,
      userId: record.userId,
      ...(record.tenantId == null ? {} : { tenantId: record.tenantId }),
      sourceKeyId: record.sourceKeyId,
    },
    secret,
    { algorithm: 'HS256', audience, expiresIn: '60s' },
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
    const deny = () => {
      res.status(401).json({ error: { code: 'invalid_response_worker', message: 'Unauthorized' } });
    };
    if (req.method !== 'POST' || req.path !== '/') return deny();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return deny();
    let claims: z.infer<typeof claimsSchema>;
    try {
      const parsed = claimsSchema.safeParse(
        jwt.verify(header.slice(7), deps.signingSecret(), {
          algorithms: ['HS256'],
          audience,
        }),
      );
      if (!parsed.success) return deny();
      claims = parsed.data;
    } catch {
      return deny();
    }
    const contextTenant = getTenantId();
    if (
      claims.tenantId === '__SYSTEM__' ||
      (contextTenant != null && contextTenant !== claims.tenantId)
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
          user.tenantId !== record.tenantId ||
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
            record.tenantId !== claims.tenantId ||
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
        const request = req as ServerRequest & Pick<ContextRequest, 'tenantId'>;
        user.id = record.userId;
        request.user = user;
        request.tenantId = record.tenantId;
        // Caller body/headers cannot replace the persisted, already validated request.
        request.body = JSON.parse(record.requestJSON);
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
