import { z } from 'zod';
import { Router } from 'express';
import { unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { MediaPersistenceError } from '@librechat/data-schemas';
import {
  mediaIdSchema,
  mediaSubmissionRequestSchema,
  mediaImportRequestSchema,
  mediaRetryRequestSchema,
  mediaThreadUpdateSchema,
  mediaPageRequestSchema,
  mediaThreadListRequestSchema,
  mediaThreadDetailRequestSchema,
  mediaThreadsDeleteRequestSchema,
  mediaPresetWriteSchema,
  mediaPresetUpdateSchema,
  mergeFileConfig,
} from 'librechat-data-provider';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { MediaErrorCode } from 'librechat-data-provider';
import type { RateLimitResponseLocals } from '~/middleware/limiters';
import type { MediaStaging, MediaUploadStorage } from './staging';
import type { MediaServices, MediaContext } from './service';
import type { MediaAdmissionPolicy } from './admission';
import type { MediaActivityStream } from './events';
import type { MediaStorage } from './storage';
import { mediaContentExtension, normalizeMediaContentType } from './content';
import { getContentFilterError } from '~/middleware/contentFilter';
import { admitRequestMiddleware } from '~/middleware/admission';
import { assertUploadContentAllowed } from '~/files/preflight';
import { parseHostedMediaReference } from './hosted';
import { sanitizeFilename } from '~/utils/files';
import { assertMediaStorage } from './storage';
import { assertMediaAccess } from './service';
import { MediaServiceError } from './errors';

type UploadFile = Express.Multer.File;

export type MediaUploadFactory = (options: {
  storage: MediaUploadStorage;
  limits: { fileSize: number; files: number; fields: number };
  fileFilter(
    req: Request,
    file: UploadFile,
    callback: (error: Error | null, accept?: boolean) => void,
  ): void;
}) => {
  single(field: string): RequestHandler;
};

const persistenceCodes = {
  conflict: 'request_conflict',
  version_conflict: 'version_conflict',
  capacity: 'quota_exceeded',
  not_found: 'not_found',
  retired: 'not_found',
  invalid_input: 'invalid_request',
  unsafe_retry: 'submission_uncertain',
} as const;

function persistenceStatus(code: MediaPersistenceError['code']): number {
  if (code === 'capacity') return 429;
  if (code === 'not_found' || code === 'retired') return 404;
  return 409;
}

/** Errors the router knows how to answer; anything else is an operator-facing defect. */
export function classifyMediaError(
  error: Error,
): { status: number; code: MediaErrorCode } | undefined {
  if (error instanceof MediaServiceError) return { status: error.status, code: error.code };
  const policyError = getContentFilterError(error);
  if (policyError) {
    return policyError.statusCode === 413
      ? { status: 413, code: 'invalid_request' }
      : { status: 403, code: 'forbidden' };
  }
  if (error instanceof z.ZodError) return { status: 422, code: 'invalid_request' };
  if (error instanceof MediaPersistenceError) {
    return { status: persistenceStatus(error.code), code: persistenceCodes[error.code] };
  }
  return undefined;
}

export function sendMediaError(res: Response, error: Error): void {
  const mapped = classifyMediaError(error) ?? { status: 500, code: 'internal_error' as const };
  res.status(mapped.status).json({ error: { code: mapped.code } });
}

/** Aborts work for a client that disconnected before its response was written. */
function disconnectSignal(res: Response): AbortSignal {
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
}

function isMulterError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === 'MulterError' && 'code' in error;
}

function uploadError(error: unknown): Error {
  if (isMulterError(error)) {
    return error.code === 'LIMIT_FILE_SIZE'
      ? new MediaServiceError('invalid_request', 413, 'Media exceeds the configured file limit.')
      : new MediaServiceError('invalid_request', 422, 'Invalid media upload.');
  }
  return error instanceof Error ? error : new Error('Media upload failed.');
}

export function createMediaRouter({
  activity,
  services,
  repository,
  storage,
  resolveContext,
  resolveScope,
  upload,
  staging,
  id,
  now,
  log,
  admission,
}: {
  activity?: MediaActivityStream;
  services: MediaServices;
  repository: MediaMethods;
  storage: MediaStorage;
  resolveContext(request: Request): Promise<MediaContext>;
  resolveScope(request: Request): MediaOwnerScope;
  upload: MediaUploadFactory;
  staging: MediaStaging;
  id: () => string;
  now: () => number;
  log(message: string, error?: Error): void;
  admission?: MediaAdmissionPolicy;
}): Router {
  const router = Router();
  if (admission) router.use(admission.checkBan);
  router.get('/events', async (req, res) => {
    try {
      const context = await resolveContext(req);
      assertMediaAccess(context);
      if (!activity || !context.config.events.enabled)
        throw new MediaServiceError('not_found', 404, 'Media activity is unavailable.');
      await activity.open(context.scope, req, res);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error('Media activity failed');
      if (!res.headersSent) sendMediaError(res, error);
      else {
        log('Media activity disconnected.', error);
        res.end();
      }
    }
  });
  const handle =
    <T>(
      action: (req: Request, context: MediaContext) => Promise<T>,
      status = 200,
      admissionKind?: 'submission' | 'import',
    ): RequestHandler =>
    async (req, res) => {
      try {
        const admit = async (middleware: readonly RequestHandler[]) => {
          const response = res as Response<unknown, RateLimitResponseLocals>;
          response.locals.rateLimitError = (error) => {
            response
              .set('Retry-After', String(error.retryAfterSeconds))
              .status(429)
              .json({ error: { code: 'quota_exceeded' } });
          };
          if (!(await admitRequestMiddleware(req, res, middleware))) {
            throw new MediaServiceError('quota_exceeded', 429, 'Request admission was denied.');
          }
        };
        let submissionReplay: MediaContext['submissionReplay'];
        let importReplay: MediaContext['importReplay'];
        if (admission && admissionKind) {
          const { clientRequestId } = z.object({ clientRequestId: mediaIdSchema }).parse(req.body);
          const scope = resolveScope(req);
          if (admissionKind === 'submission') {
            submissionReplay = {
              clientRequestId,
              receipt: await repository.getMediaSubmission(scope, clientRequestId),
            };
            if (!submissionReplay.receipt) await admit(admission.generationLimiters);
          } else {
            importReplay = {
              clientRequestId,
              receipt: await repository.getMediaImport(scope, clientRequestId),
            };
            if (!importReplay.receipt) await admit(admission.uploadLimiters);
          }
        }
        const context = await resolveContext(req);
        context.submissionReplay = submissionReplay;
        context.importReplay = importReplay;
        if (admission) {
          if (!submissionReplay)
            context.admitGeneration = () => admit(admission.generationLimiters);
          if (!importReplay) context.admitImport = () => admit(admission.uploadLimiters);
        }
        assertMediaAccess(context);
        res.status(status).json(await action(req, context));
      } catch (caught) {
        if (res.headersSent || res.destroyed) return;
        const error = caught instanceof Error ? caught : new Error('Media request failed');
        if (error instanceof MediaPersistenceError && error.code === 'capacity') {
          try {
            await admission?.recordCapacityViolation?.(req, res);
          } catch (violationError) {
            log(
              '[media] Capacity violation recording failed.',
              violationError instanceof Error ? violationError : undefined,
            );
          }
          if (res.headersSent || res.destroyed) return;
        }
        if (!classifyMediaError(error)) {
          log(`[media] Request failed: ${req.method} ${req.path}`, error);
        }
        sendMediaError(res, error);
      }
    };
  const param = (req: Request, name: string) => mediaIdSchema.parse(req.params[name]);
  const found = <T>(value: T | null): T => {
    if (value == null) {
      throw new MediaServiceError('not_found', 404, 'Media resource is unavailable.');
    }
    return value;
  };

  router.get(
    '/catalog',
    handle((_req, context) => services.queries.catalog(context)),
  );
  router.get(
    '/threads',
    handle((req, context) =>
      services.queries.threads(mediaThreadListRequestSchema.parse(req.query), context),
    ),
  );
  router.get(
    '/threads/:threadId',
    handle((req, context) =>
      services.queries.thread(
        param(req, 'threadId'),
        context,
        mediaThreadDetailRequestSchema.parse(req.query),
      ),
    ),
  );
  router.get(
    '/threads/:threadId/turns',
    handle((req, context) => {
      const query = mediaPageRequestSchema.parse(req.query);
      return services.queries.turns(param(req, 'threadId'), query.cursor, query.limit, context);
    }),
  );
  router.get(
    '/threads/:threadId/turns/:turnId/jobs',
    handle(async (req, context) => {
      found(await repository.getMediaThread(context.scope, param(req, 'threadId')));
      const query = mediaPageRequestSchema.parse(req.query);
      return repository.listMediaTurnJobs({
        scope: context.scope,
        threadId: param(req, 'threadId'),
        turnId: param(req, 'turnId'),
        cursor: query.cursor,
        limit: Math.min(
          query.limit ?? context.config.limits.pageSize,
          context.config.limits.maxPageSize,
        ),
      });
    }),
  );
  router.get(
    '/jobs/:jobId',
    handle(async (req, context) =>
      found(await repository.getMediaJobView(context.scope, param(req, 'jobId'))),
    ),
  );
  router.get(
    '/jobs/:jobId/diagnostics',
    handle((req, context) => services.queries.jobDiagnostics(param(req, 'jobId'), context)),
  );
  router.get(
    '/jobs/:jobId/outputs',
    handle(async (req, context) => {
      const job = found(await repository.getMediaJobView(context.scope, param(req, 'jobId')));
      const query = mediaPageRequestSchema.parse(req.query);
      const start = query.cursor == null ? 0 : Number(query.cursor);
      if (!Number.isSafeInteger(start) || start < 0) {
        throw new MediaServiceError('invalid_request', 422, 'Invalid output cursor.');
      }
      const limit = Math.min(
        query.limit ?? context.config.limits.pageSize,
        context.config.limits.maxPageSize,
      );
      const items = job.outputs.slice(start, start + limit);
      return {
        items,
        ...(start + limit < job.outputs.length ? { nextCursor: String(start + limit) } : {}),
      };
    }),
  );
  router.post(
    '/submissions',
    handle(
      (req, context) =>
        services.commands.submit(mediaSubmissionRequestSchema.parse(req.body), context),
      202,
      'submission',
    ),
  );
  router.get(
    '/submissions/:clientRequestId',
    handle(async (req, context) =>
      found(await repository.getMediaSubmission(context.scope, param(req, 'clientRequestId'))),
    ),
  );
  router.post(
    '/imports',
    handle(
      (req, context) => services.commands.import(mediaImportRequestSchema.parse(req.body), context),
      202,
      'import',
    ),
  );
  router.get(
    '/imports/:clientRequestId',
    handle(async (req, context) =>
      found(await repository.getMediaImport(context.scope, param(req, 'clientRequestId'))),
    ),
  );
  router.post(
    '/jobs/:jobId/cancel',
    handle((req, context) => services.commands.cancel(param(req, 'jobId'), context)),
  );
  router.post(
    '/jobs/:jobId/retry',
    handle(
      (req, context) =>
        services.commands.retry(
          param(req, 'jobId'),
          mediaRetryRequestSchema.parse(req.body).clientRequestId,
          context,
        ),
      202,
      'submission',
    ),
  );
  router.patch(
    '/threads/:threadId',
    handle((req, context) =>
      services.commands.updateThread(
        param(req, 'threadId'),
        mediaThreadUpdateSchema.parse(req.body),
        context,
      ),
    ),
  );
  router.delete(
    '/threads',
    handle(
      (req, context) =>
        services.commands.retireMany(mediaThreadsDeleteRequestSchema.parse(req.body), context),
      202,
    ),
  );
  router.delete(
    '/threads/:threadId',
    handle((req, context) => services.commands.retire(param(req, 'threadId'), context), 202),
  );
  router.get(
    '/presets',
    handle((_req, context) => services.presets.list(context)),
  );
  router.post(
    '/presets',
    handle(
      (req, context) =>
        services.presets.create(id(), mediaPresetWriteSchema.parse(req.body), context),
      201,
    ),
  );
  router.patch(
    '/presets/:presetId',
    handle((req, context) =>
      services.presets.update(
        param(req, 'presetId'),
        mediaPresetUpdateSchema.parse(req.body),
        context,
      ),
    ),
  );
  router.delete(
    '/presets/:presetId',
    handle((req, context) => services.presets.remove(param(req, 'presetId'), context)),
  );
  router.post(
    '/uploads/url',
    ...(admission?.uploadLimiters ?? []),
    handle(
      (req, context) =>
        services.commands.uploadURL(
          parseHostedMediaReference(req.body),
          context,
          req.res ? disconnectSignal(req.res) : undefined,
        ),
      201,
    ),
  );
  router.post(
    '/uploads',
    ...(admission?.uploadLimiters ?? []),
    handle(async (req, context) => {
      assertMediaAccess(context, true);
      assertMediaStorage(context);
      const fileConfig = mergeFileConfig(context.appConfig.fileConfig);
      const maxFileBytes = Math.max(
        context.config.transfers.maxImageBytes,
        context.config.transfers.maxVideoBytes,
        context.config.transfers.maxAudioBytes,
      );
      const receive = upload({
        storage: staging.storage(context.config),
        limits: {
          fileSize: Math.min(maxFileBytes, fileConfig.serverFileSizeLimit ?? maxFileBytes),
          files: 1,
          fields: 1,
        },
        fileFilter(_req, file, callback) {
          if (!mediaContentExtension(normalizeMediaContentType(file.mimetype))) {
            callback(
              new MediaServiceError('unsupported', 422, 'Unsupported media reference type.'),
            );
            return;
          }
          callback(null, true);
        },
      }).single('file');
      await new Promise<void>((resolve, reject) =>
        receive(req, req.res!, (error?: unknown) =>
          error ? reject(uploadError(error)) : resolve(),
        ),
      );
      const file = req.file;
      if (!file) {
        throw new MediaServiceError('invalid_request', 422, 'Select a source file.');
      }
      try {
        const type = normalizeMediaContentType(file.mimetype);
        await assertUploadContentAllowed({
          filters: context.appConfig.filters,
          file: { ...file, mimetype: type },
          fileConfig,
          ocrConfigured: false,
          ragConfigured: false,
        });
        const asset = await storage.publish({
          scope: context.scope,
          outputKey: `upload:${id()}`,
          stream: createReadStream(file.path),
          type,
          filename: sanitizeFilename(file.originalname),
          config: context.config,
          expiredAt: new Date(now() + context.config.assets.orphanRetentionMs).toISOString(),
        });
        return { file: asset };
      } finally {
        await unlink(file.path).catch(() => undefined);
      }
    }, 201),
  );
  return router;
}
