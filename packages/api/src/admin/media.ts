import { z } from 'zod';
import { Router } from 'express';
import { SystemCapabilities } from '@librechat/data-schemas';
import {
  mediaIdSchema,
  mediaPageRequestSchema,
  mediaRecoveryRequestSchema,
  MediaWorkerHealth,
} from 'librechat-data-provider';
import type { RecordAuditEntryInput, RecordAuditEntryOptions } from '@librechat/data-schemas';
import type { RequestHandler } from 'express';
import type {
  CapabilityUser,
  GetHeldCapabilitiesFn,
  RequireCapabilityFn,
} from '~/middleware/capabilities';
import type { MediaRecoveryServices } from '~/media/recovery';
import type { ServerRequest } from '~/types/http';
import { classifyMediaError, sendMediaError } from '~/media/http';
import { admitRequestMiddleware } from '~/middleware/admission';
import { MediaServiceError } from '~/media/errors';
import { createMediaLog } from '~/media/logging';
import { buildAuditContext } from './context';

export interface AdminMediaDeps {
  getWorkerHealth?(req: ServerRequest): MediaWorkerHealth | undefined;
  services?: MediaRecoveryServices | ((req: ServerRequest) => MediaRecoveryServices | undefined);
  requireCapability: RequireCapabilityFn;
  getHeldCapabilities: GetHeldCapabilitiesFn;
  recordAuditEntry(
    input: RecordAuditEntryInput,
    options: RecordAuditEntryOptions,
  ): Promise<object | null>;
  log(message: string, error?: Error): void;
}
export function createAdminMediaHandlers(deps: AdminMediaDeps): {
  list: RequestHandler;
  resolve: RequestHandler;
  capabilities: RequestHandler;
} {
  const log = createMediaLog(deps.log);
  async function permissions(user: CapabilityUser) {
    const requested = [
      SystemCapabilities.ACCESS_ADMIN,
      SystemCapabilities.READ_MEDIA,
      SystemCapabilities.MANAGE_MEDIA,
    ];
    const held = await deps.getHeldCapabilities(user, requested);
    const canManage =
      held.has(SystemCapabilities.ACCESS_ADMIN) && held.has(SystemCapabilities.MANAGE_MEDIA);
    return {
      canRead:
        canManage ||
        (held.has(SystemCapabilities.ACCESS_ADMIN) && held.has(SystemCapabilities.READ_MEDIA)),
      canManage,
    };
  }
  async function actor(req: ServerRequest): Promise<CapabilityUser> {
    const id = req.user?.id ?? req.user?._id?.toString();
    if (!id || !req.user?.role)
      throw new MediaServiceError('forbidden', 403, 'Administrator access is required.');
    const user = {
      id,
      role: req.user.role,
      tenantId: req.user.tenantId,
      idOnTheSource: req.user.idOnTheSource ?? null,
    };
    return user;
  }
  async function auditDenied(req: ServerRequest, capability: string): Promise<void> {
    if (!req.user?.id) return;
    try {
      await deps.recordAuditEntry(
        {
          action: 'approval.media_recovery',
          outcome: 'denied',
          severity: 'warning',
          actor: { type: 'user', id: req.user.id, name: req.user.name ?? req.user.id },
          target: {
            type: 'media_job',
            id:
              z.object({ jobId: mediaIdSchema.optional() }).safeParse(req.params).data?.jobId ??
              'list',
          },
          tenantId: req.user.tenantId,
          context: buildAuditContext(req),
          metadata: { requiredAccess: capability },
        },
        { failClosed: false },
      );
    } catch (auditError) {
      log(
        '[media] Recovery denial audit failed.',
        auditError instanceof Error ? auditError : undefined,
      );
    }
  }
  const handle =
    (
      capability: 'canRead' | 'canManage',
      action: (
        req: ServerRequest,
        user: CapabilityUser,
        services: MediaRecoveryServices,
      ) => Promise<object>,
    ): RequestHandler =>
    async (request, res) => {
      let denialAudited = false;
      try {
        const req = request as ServerRequest;
        const user = await actor(req);
        const guards = [
          SystemCapabilities.ACCESS_ADMIN,
          capability === 'canRead'
            ? SystemCapabilities.READ_MEDIA
            : SystemCapabilities.MANAGE_MEDIA,
        ];
        if (
          !(await admitRequestMiddleware(
            request,
            res,
            guards.map(
              (required) => (request, response, next) =>
                deps.requireCapability(required, {
                  onDenied: async (req) => {
                    await auditDenied(req, capability);
                    denialAudited = true;
                  },
                })(request as ServerRequest, response, next),
            ),
          ))
        )
          throw new MediaServiceError('forbidden', 403, 'Media recovery access is required.');
        const services = typeof deps.services === 'function' ? deps.services(req) : deps.services;
        if (!services)
          throw new MediaServiceError('not_ready', 503, 'Media recovery is unavailable.');
        res.status(200).json(await action(req, user, services));
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('Media recovery failed');
        const req = request as ServerRequest;
        if (error instanceof MediaServiceError && error.code === 'forbidden' && req.user?.id) {
          if (!denialAudited) await auditDenied(req, capability);
        }
        if (!classifyMediaError(error)) log('[media] Admin recovery request failed.', error);
        if (res.headersSent || res.destroyed) return;
        sendMediaError(res, error);
      }
    };
  return {
    capabilities: async (request, res) => {
      try {
        res.json(await permissions(await actor(request as ServerRequest)));
      } catch (error) {
        sendMediaError(
          res,
          error instanceof Error ? error : new Error('Media access check failed'),
        );
      }
    },
    list: handle('canRead', async (req, user, services) => ({
      ...(await services.list({
        ...mediaPageRequestSchema.parse(req.query),
        tenantId: user.tenantId ?? null,
      })),
      worker: deps.getWorkerHealth?.(req),
    })),
    resolve: handle('canManage', async (req, user, services) => {
      const request = mediaRecoveryRequestSchema.parse(req.body);
      const { ownerId, jobId } = z
        .object({ ownerId: mediaIdSchema, jobId: mediaIdSchema })
        .parse(req.params);
      return services.resolve({
        scope: { ownerId, tenantId: user.tenantId ?? null },
        jobId,
        actorId: user.id,
        request,
        audit: async (outcome, errorCode) => {
          await deps.recordAuditEntry(
            {
              action: 'approval.media_recovery',
              outcome,
              severity: 'warning',
              actor: { type: 'user', id: user.id, name: req.user?.name ?? user.id },
              target: { type: 'media_job', id: jobId },
              tenantId: user.tenantId,
              metadata: {
                ownerId,
                ...(errorCode ? { errorCode } : {}),
                clientRequestId: request.clientRequestId,
                action: request.action,
                expectedVersion: request.expectedVersion,
                evidence: request.evidence,
                ...(request.action === 'settle'
                  ? { costUSD: request.costUSD, terminalStatus: request.terminalStatus }
                  : {}),
              },
              context: buildAuditContext(req),
            },
            { failClosed: true },
          );
        },
      });
    }),
  };
}

export function createAdminMediaRouter(
  deps: AdminMediaDeps & { requireJwtAuth: RequestHandler },
): Router {
  const router = Router();
  const handlers = createAdminMediaHandlers(deps);
  router.use(deps.requireJwtAuth);
  router.get('/capabilities', handlers.capabilities);
  router.get('/jobs', handlers.list);
  router.post('/jobs/:ownerId/:jobId/recovery', handlers.resolve);
  return router;
}
