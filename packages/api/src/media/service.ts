import {
  getTempChatRetentionHours,
  MediaPersistenceError,
  createChatExpirationDate,
} from '@librechat/data-schemas';
import {
  messageFilterPiiSchema,
  TOKEN_CREDITS_PER_USD,
  createMediaSubmissionSchema,
  createMediaImportSchema,
  createMediaPresetSchema,
  createMediaPresetUpdateSchema,
  mediaProviderDiagnosticSchema,
  RetentionMode,
} from 'librechat-data-provider';
import type {
  MediaAsset,
  MediaThread,
  MediaTurn,
  MediaJob,
  MediaCatalog,
  MediaConfig,
  MediaIntegration,
  MediaPreset,
  MediaPresetUpdate,
  MediaPresetWrite,
  MediaSubmissionRequest,
  MediaImportRequest,
  MediaSubmissionReceipt,
  MediaImportReceipt,
  MediaThreadListRequest,
  MediaThreadDetailRequest,
  MediaThreadUpdate,
  MediaThreadsDeleteRequest,
  MediaThreadsDeletionReceipt,
  MediaURLUploadRequest,
  MediaURLUploadResponse,
  MediaUserKey,
  MediaThreadDetail,
  MediaActivity,
  MediaJobDiagnosticsResponse,
} from 'librechat-data-provider';
import type {
  AppConfig,
  MediaPage,
  MediaMethods,
  MediaOwnerScope,
  MediaPresetMethods,
  MediaPublicationOptions,
  MediaStoredJob,
  MediaAccountingMethods,
  MediaExecutionSnapshot,
} from '@librechat/data-schemas';
import type {
  MediaConnection,
  MediaProviderAdapter,
  MediaProviderUsage,
  MediaProviderContext,
  MediaProviderPart,
  MediaProviderInput,
} from './provider';
import type { ModerationCheck } from '~/middleware/moderation';
import type { MediaLifecycleObserver } from './telemetry';
import type { MediaHostedDependencies } from './hosted';
import type { MediaCatalogCache } from './catalogCache';
import type { MediaTitleGenerator } from './title';
import type { MediaModelTracer } from './tracing';
import type { SafeUserInput } from '~/utils/env';
import type { MediaContext } from './context';
import { createMediaCatalog, selectMediaRoute, validateMediaOffering } from './catalog';
import { importHostedMediaReference, verifyHostedMediaReference } from './hosted';
import { extractModelParameterContent } from '~/protection/adapters/submissions';
import { mediaInputByteLimit, prepareMediaInputContent } from './content';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { isContentFilterError } from '~/middleware/contentFilter';
import { UninspectableFileError } from '~/protection/files';
import { isMediaConnectionBinding } from './provider';
import { assertMediaStorage } from './storage';
import { MediaServiceError } from './errors';
import { observeMedia } from './telemetry';

export type { MediaContext } from './context';

export interface MediaAccounting {
  snapshot?(
    model: string,
    integration: MediaIntegration,
    appConfig: AppConfig,
  ): MediaExecutionSnapshot['tokenPricing'];
  ensureReady?(): Promise<void>;
  scopes?: MediaAccountingMethods['listMediaAccountingScopes'];
  reconcile?(scope: MediaOwnerScope, config: MediaConfig): Promise<number>;
  reserve(job: MediaStoredJob, integration: MediaIntegration, context: MediaContext): Promise<void>;
  settle(
    job: MediaStoredJob,
    usage: MediaProviderUsage | undefined,
    context: MediaContext,
  ): Promise<void>;
  release(job: MediaStoredJob, context: MediaContext): Promise<void>;
}

export interface MediaServiceDependencies extends MediaHostedDependencies {
  publishActivity?(scope: MediaOwnerScope, activity: MediaActivity): Promise<void>;
  catalogCache?: MediaCatalogCache;
  observer?: MediaLifecycleObserver;
  modelTracer?: MediaModelTracer;
  repository: MediaMethods & MediaPresetMethods;
  ensureReady?(): Promise<void>;
  /** Retention window for temporary creations recovered outside a request; derived from the host config. */
  temporaryRetentionMs?: number;
  reconcileNative?(scope: MediaOwnerScope, config: MediaConfig): Promise<void>;
  reconcileFileConsumers?(scope: MediaOwnerScope, config: MediaConfig): Promise<void>;
  isLeader?(): Promise<boolean>;
  /** Removes abandoned upload staging files older than `staleBefore`. */
  sweepStaging?(staleBefore: number): Promise<number>;
  /** Applies the host's existing file deletion retry policy to a failed media original. */
  deferAssetDeletion?(scope: MediaOwnerScope, fileId: string): Promise<void>;
  deferAssetWriteDeletion?(scope: MediaOwnerScope, writeId: string): Promise<void>;
  reconcileNativeConsumers?(
    scope: MediaOwnerScope,
    config: MediaConfig,
    threadId?: string,
  ): Promise<void>;
  adapters: readonly MediaProviderAdapter[];
  moderate?: ModerationCheck;
  resolveConnection(input: {
    scope: MediaOwnerScope;
    integration: MediaIntegration;
    appConfig: AppConfig;
    minValidityMs: number;
    user?: SafeUserInput;
  }): Promise<MediaConnection>;
  describeUserKey?(input: {
    integration: MediaIntegration;
    appConfig: AppConfig;
  }): MediaUserKey | undefined;
  loadContext(scope: MediaOwnerScope): Promise<MediaContext>;
  withScope<T>(scope: MediaOwnerScope, operation: () => Promise<T>): Promise<T>;
  asSystem<T>(operation: () => Promise<T>): Promise<T>;
  accounting: MediaAccounting;
  /** Names new threads in the background after the submission receipt is returned. */
  titles?: MediaTitleGenerator;
  log(message: string, error?: Error): void;
  warn?(message: string, error?: Error): void;
  info?(message: string): void;
}

export function assertMediaAccess(context: MediaContext, create = false): void {
  if (!context.canUse || (create && !context.canCreate)) {
    throw new MediaServiceError('forbidden', 403, 'Media access is not permitted.');
  }
  if (create && !context.config.enabled) {
    throw new MediaServiceError('disabled', 403, 'Media generation is disabled.');
  }
}

const HOUR_MS = 3_600_000;
/** Temporary creations share the chat retention policy so one setting governs both surfaces. */
export function mediaTemporaryRetentionMs(interfaceConfig: AppConfig['interfaceConfig']): number {
  return getTempChatRetentionHours(interfaceConfig) * HOUR_MS;
}
/** Freeze the same saved/temporary retention deadline as chat before publication can be interrupted. */
export function mediaPublicationExpiresAt(context: MediaContext, temporary = false): string | null {
  if (context.publicationExpiresAt) return context.publicationExpiresAt;
  const policy = context.appConfig.interfaceConfig;
  return temporary || policy?.retentionMode === RetentionMode.ALL
    ? createChatExpirationDate(policy, temporary).toISOString()
    : null;
}
function publicationOptions(context: MediaContext): MediaPublicationOptions {
  return {
    maxRetainers: context.config.limits.maxAssetRetainers,
    maxTitleChars: context.config.limits.maxTitleChars,
    temporaryRetentionMs: mediaTemporaryRetentionMs(context.appConfig.interfaceConfig),
  };
}
/** Freezes the resolved connection so dispatch can detect any change made after admission. */
function preparedExecution(
  selection: MediaSubmissionRequest['selection'],
  ready: PreparedMedia,
  appConfig: AppConfig,
  accounting: MediaAccounting,
): MediaExecutionSnapshot {
  const accountingMode = mediaAccountingMode(appConfig);
  return {
    connectionId: selection.connectionId,
    modelId: selection.modelId,
    api: ready.connection.api,
    catalogVersion: selection.catalogVersion,
    bindingRevision: ready.connection.binding,
    billing:
      ready.integration.billing ??
      (accountingMode === 'transactions' ? { creditsPerUSD: TOKEN_CREDITS_PER_USD } : undefined),
    providerTag: ready.providerTag,
    ...(ready.integration.endpointRef.kind === 'direct'
      ? {}
      : { endpointRef: ready.integration.endpointRef }),
    accountingMode,
    tokenPricing: accounting.snapshot?.(selection.modelId, ready.integration, appConfig),
    accountingShortfall: appConfig.media?.accounting.shortfall ?? 'debt',
    cancellation: ready.cancellation,
  };
}
function presetError(error: unknown): never {
  if (error instanceof MediaPersistenceError && error.code === 'capacity') {
    throw new MediaServiceError('quota_exceeded', 429, 'The preset limit has been reached.');
  }
  throw error;
}

export interface PreparedMedia {
  integration: MediaIntegration;
  connection: MediaConnection;
  inputs: MediaProviderInput[];
  providerTag?: string;
  cancellation?: MediaExecutionSnapshot['cancellation'];
  continuation?: MediaProviderContext['continuation'];
}
export interface MediaServices {
  prepare(
    request: MediaSubmissionRequest,
    context: MediaContext,
    requireCatalogVersion: boolean,
    signal?: AbortSignal,
    admission?: boolean,
  ): Promise<PreparedMedia>;
  commands: {
    uploadURL(
      input: MediaURLUploadRequest,
      context: MediaContext,
      signal?: AbortSignal,
    ): Promise<MediaURLUploadResponse>;
    submit(input: MediaSubmissionRequest, context: MediaContext): Promise<MediaSubmissionReceipt>;
    import(input: MediaImportRequest, context: MediaContext): Promise<MediaImportReceipt>;
    retry(
      jobId: string,
      clientRequestId: string,
      context: MediaContext,
    ): Promise<MediaSubmissionReceipt>;
    cancel(jobId: string, context: MediaContext): Promise<MediaJob | null>;
    updateThread(
      threadId: string,
      update: MediaThreadUpdate,
      context: MediaContext,
    ): Promise<MediaThread>;
    retire(
      threadId: string,
      context: MediaContext,
    ): Promise<{ threadId: string; phase: 'retiring' }>;
    retireMany(
      input: MediaThreadsDeleteRequest,
      context: MediaContext,
    ): Promise<MediaThreadsDeletionReceipt>;
  };
  queries: {
    jobDiagnostics(jobId: string, context: MediaContext): Promise<MediaJobDiagnosticsResponse>;
    catalog(context: MediaContext): Promise<MediaCatalog>;
    threads(query: MediaThreadListRequest, context: MediaContext): Promise<MediaPage<MediaThread>>;
    thread(
      threadId: string,
      context: MediaContext,
      query?: MediaThreadDetailRequest,
    ): Promise<MediaThreadDetail>;
    turns(
      threadId: string,
      cursor: string | undefined,
      limit: number | undefined,
      context: MediaContext,
    ): Promise<MediaPage<MediaTurn>>;
  };
  presets: {
    list(context: MediaContext): Promise<{ items: MediaPreset[] }>;
    create(presetId: string, input: MediaPresetWrite, context: MediaContext): Promise<MediaPreset>;
    update(
      presetId: string,
      update: MediaPresetUpdate,
      context: MediaContext,
    ): Promise<MediaPreset>;
    remove(presetId: string, context: MediaContext): Promise<{ presetId: string }>;
  };
}

export function createMediaServices(deps: MediaServiceDependencies): MediaServices {
  const catalog = createMediaCatalog({
    cache: deps.catalogCache,
    transport: deps.transport,
    adapters: deps.adapters,
    now: deps.now,
  });
  const resolve = (context: MediaContext, integration: MediaIntegration) =>
    deps.resolveConnection({
      scope: context.scope,
      integration,
      appConfig: context.appConfig,
      minValidityMs: context.config.credentials.minValidityAtDispatchMs,
      user: context.user,
    });
  const snapshot = (context: MediaContext) =>
    catalog.read(
      context.config,
      (integration) => {
        assertMediaStorage(context);
        if (context.appConfig.balance?.enabled && !integration.billing?.maxCostUSD) {
          throw new MediaServiceError(
            'not_ready',
            422,
            'A media cost reservation must be configured before generation.',
          );
        }
        return resolve(context, integration);
      },
      context.scope,
      (integration) => deps.describeUserKey?.({ integration, appConfig: context.appConfig }),
    );

  async function prepare(
    request: MediaSubmissionRequest,
    context: MediaContext,
    requireCatalogVersion: boolean,
    signal?: AbortSignal,
    admission = false,
  ) {
    assertMediaAccess(context, true);
    const integration = context.config.integrations.find(
      (entry) => entry.id === request.selection.connectionId,
    );
    if (integration?.enabled === false) {
      throw new MediaServiceError('forbidden', 403, 'This media provider is disabled.');
    }
    assertMediaStorage(context);
    const current = await snapshot(context);
    if (requireCatalogVersion && current.catalog.version !== request.selection.catalogVersion) {
      throw new MediaServiceError('stale_catalog', 409, 'The media model catalog changed.');
    }
    const modelOffering = current.resolved.get(
      `${request.selection.connectionId}:${request.selection.modelId}`,
    );
    if (!modelOffering || !integration) {
      throw new MediaServiceError('unsupported', 422, 'The media model is unavailable.');
    }
    const selected = selectMediaRoute(modelOffering, request.selection.providerTag);
    validateMediaOffering(request, selected.offering, context.config.limits);
    const connection = await resolve(context, integration);
    const assets: MediaAsset[] = [];
    const inputs = await Promise.all(
      request.inputs.map(async (input) => {
        const { asset, data, digest } = await deps.storage.read(
          context.scope,
          input.file_id,
          mediaInputByteLimit(input.role, context.config),
        );
        const content = await prepareMediaInputContent(
          input.role,
          asset.type,
          data,
          context.config,
        );
        const sourceURL = input.sourceURL
          ? await verifyHostedMediaReference(
              { url: input.sourceURL, role: input.role === 'audio' ? 'audio' : 'video' },
              digest,
              context,
              deps.transport,
              signal,
            )
          : undefined;
        assets.push(asset);
        return { ...input, ...content, ...(sourceURL ? { sourceURL } : {}) };
      }),
    );
    let continuation: MediaProviderContext['continuation'];
    validateMediaOffering(
      {
        ...request,
        inputs: inputs.map(({ data, ...input }) => ({ ...input, bytes: data.length })),
      },
      selected.offering,
      context.config.limits,
    );
    if (connection.api === 'google.generateContent' && request.threadId && request.parentTurnId) {
      const parent = await deps.repository.getMediaParentContext(
        context.scope,
        request.threadId,
        request.parentTurnId,
      );
      if (
        parent &&
        parent.execution.modelId === request.selection.modelId &&
        isMediaConnectionBinding(connection, parent.execution.bindingRevision) &&
        parent.provider.recovery?.parts
      ) {
        const parts: MediaProviderPart[] = [];
        for (const part of parent.provider.recovery.parts) {
          if (part.kind === 'text') {
            parts.push(part);
            continue;
          }
          if (part.kind !== 'image' || !part.fileId) {
            throw new MediaServiceError(
              'not_ready',
              409,
              'The selected native continuation is incomplete.',
            );
          }
          const { asset, data } = await deps.storage.read(
            context.scope,
            part.fileId,
            context.config.transfers.maxImageBytes,
          );
          const content = await prepareMediaInputContent(
            'reference',
            asset.type,
            data,
            context.config,
          );
          parts.push({
            kind: 'image',
            ordinal: part.ordinal,
            ...content,
            thoughtSignature: part.thoughtSignature,
          });
        }
        const parentInputs = await Promise.all(
          parent.request.inputs.map(async (input) => {
            if (input.role === 'audio' || input.role === 'video') {
              throw new MediaServiceError(
                'unsupported',
                422,
                'Unsupported native continuation input.',
              );
            }
            const { asset, data } = await deps.storage.read(
              context.scope,
              input.file_id,
              context.config.transfers.maxImageBytes,
            );
            const content = await prepareMediaInputContent(
              input.role,
              asset.type,
              data,
              context.config,
            );
            assets.push(asset);
            return { ...input, ...content };
          }),
        );
        const imageParts = parts.filter((part) => part.kind === 'image');
        const inputCount = inputs.length + parentInputs.length + imageParts.length;
        const descriptors = parts.map((part) =>
          part.kind === 'text'
            ? part
            : {
                kind: part.kind,
                ordinal: part.ordinal,
                type: part.type,
                thoughtSignature: part.thoughtSignature,
              },
        );
        if (
          inputCount >
            Math.min(
              context.config.limits.maxInputs,
              selected.offering.capabilities.find(
                (capability) => capability.operation === request.operation,
              )?.inputs.max ?? 0,
            ) ||
          parts.length > context.config.limits.maxNativeParts ||
          Buffer.byteLength(JSON.stringify(descriptors), 'utf8') >
            context.config.limits.maxNativeRecordingBytes ||
          parent.request.prompt.length + request.prompt.length >
            context.config.limits.maxPromptChars
        ) {
          throw new MediaServiceError(
            'invalid_request',
            422,
            'Native continuation exceeds the configured context limit.',
          );
        }
        continuation = { prompt: parent.request.prompt, inputs: parentInputs, parts };
      }
    }
    try {
      assertModelBoundContent({
        filters: context.appConfig.filters,
        legacyPii: context.appConfig.messageFilter?.pii
          ? messageFilterPiiSchema.parse(context.appConfig.messageFilter.pii)
          : undefined,
        submittedMessages: [
          { role: 'user', content: request.prompt },
          ...(continuation ? [{ role: 'user', content: continuation.prompt }] : []),
        ],
        files: assets,
        modelParameters: { options: request.parameters },
      });
      if (
        admission &&
        (await deps.moderate?.([
          request.prompt,
          ...(continuation ? [continuation.prompt] : []),
          ...extractModelParameterContent({ options: request.parameters }).map((part) => part.text),
        ]))
      ) {
        throw new MediaServiceError('forbidden', 403, 'Media input was blocked by content policy.');
      }
    } catch (error) {
      if (isContentFilterError(error) || error instanceof UninspectableFileError) {
        throw new MediaServiceError('forbidden', 403, 'Media input was blocked by content policy.');
      }
      throw error;
    }
    const execution = selected.offering.capabilities.find(
      (capability) => capability.operation === request.operation,
    )?.execution;
    return {
      integration,
      connection,
      inputs,
      providerTag: selected.providerTag,
      continuation,
      ...(execution?.kind === 'remote-job' && execution.cancellation !== 'unsupported'
        ? { cancellation: execution.cancellation }
        : {}),
    };
  }

  const pageLimit = (context: MediaContext, requested?: number) =>
    Math.min(requested ?? context.config.limits.pageSize, context.config.limits.maxPageSize);

  return {
    prepare,
    commands: {
      async uploadURL(input, context, signal) {
        assertMediaAccess(context, true);
        return importHostedMediaReference(input, context, deps, signal);
      },
      async submit(
        input: MediaSubmissionRequest,
        context: MediaContext,
      ): Promise<MediaSubmissionReceipt> {
        assertMediaAccess(context, true);
        const request = createMediaSubmissionSchema(context.config.limits).parse(input);
        const replay =
          context.submissionReplay?.clientRequestId === request.clientRequestId
            ? context.submissionReplay.receipt
            : await deps.repository.getMediaSubmission(context.scope, request.clientRequestId);
        if (!replay) await context.admitGeneration?.();
        const ready = replay ? undefined : await prepare(request, context, true, undefined, true);
        const existing = replay
          ? await deps.repository.getMediaJob(context.scope, replay.jobId)
          : undefined;
        const execution =
          existing?.execution ??
          (ready
            ? preparedExecution(request.selection, ready, context.appConfig, deps.accounting)
            : undefined);
        if (!execution) {
          throw new MediaServiceError('not_found', 404, 'Submission is unavailable.');
        }
        const staged = await deps.repository.stageMediaSubmission({
          scope: context.scope,
          request,
          execution,
          maxActiveJobs: context.config.queue.maxPendingPerUser,
          maxPendingTotal: context.config.queue.maxPendingTotal,
          temporary: context.temporary ?? request.temporary,
          publicationExpiresAt: mediaPublicationExpiresAt(
            context,
            context.temporary ?? request.temporary,
          ),
        });
        const receipt =
          (await deps.repository.publishMediaSubmission(
            context.scope,
            staged.jobId,
            publicationOptions(context),
          )) ?? staged;
        void deps
          .publishActivity?.(context.scope, { threadId: receipt.threadId, version: 0 })
          .catch((error) =>
            deps.log('Media activity delivery failed.', error instanceof Error ? error : undefined),
          );
        return receipt;
      },
      async import(input: MediaImportRequest, context: MediaContext): Promise<MediaImportReceipt> {
        assertMediaAccess(context, true);
        const parsed = createMediaImportSchema(context.config.limits).parse(input);
        const replay =
          context.importReplay?.clientRequestId === parsed.clientRequestId
            ? context.importReplay.receipt
            : await deps.repository.getMediaImport(context.scope, parsed.clientRequestId);
        if (replay) {
          return deps.repository.stageMediaImport({
            scope: context.scope,
            request: parsed,
            identityRequest: parsed,
          });
        }
        await context.admitImport?.();
        const request = {
          ...parsed,
          inputs: await Promise.all(
            parsed.inputs.map(async (reference) => ({
              ...reference,
              file_id: (
                await deps.storage.capture(context.scope, reference.file_id, context.config)
              ).file_id,
            })),
          ),
        };
        const receipt = await deps.repository.stageMediaImport({
          scope: context.scope,
          request,
          identityRequest: parsed,
          publicationExpiresAt: mediaPublicationExpiresAt(context, parsed.temporary),
        });
        return (
          (await deps.repository.publishMediaImport(
            context.scope,
            receipt.turnId,
            publicationOptions(context),
          )) ?? receipt
        );
      },
      async retry(jobId: string, clientRequestId: string, context: MediaContext) {
        assertMediaAccess(context, true);
        const old = await deps.repository.getMediaJob(context.scope, jobId);
        if (!old) {
          throw new MediaServiceError('not_found', 404, 'The job is unavailable.');
        }
        const replay =
          context.submissionReplay?.clientRequestId === clientRequestId
            ? context.submissionReplay.receipt
            : await deps.repository.getMediaSubmission(context.scope, clientRequestId);
        if (!replay) await context.admitGeneration?.();
        const ready = replay
          ? undefined
          : await prepare(old.request, context, false, undefined, true);
        const receipt = await deps.repository.retryMediaJob({
          scope: context.scope,
          jobId,
          clientRequestId,
          maxActiveJobs: context.config.queue.maxPendingPerUser,
          maxPendingTotal: context.config.queue.maxPendingTotal,
          ...(ready
            ? {
                execution: preparedExecution(
                  old.request.selection,
                  ready,
                  context.appConfig,
                  deps.accounting,
                ),
              }
            : {}),
        });
        return (
          (await deps.repository.publishMediaSubmission(
            context.scope,
            receipt.jobId,
            publicationOptions(context),
          )) ?? receipt
        );
      },
      async cancel(jobId: string, context: MediaContext) {
        assertMediaAccess(context);
        const job = await deps.repository.cancelMediaJob(
          context.scope,
          jobId,
          deps.adapters.filter((adapter) => adapter.cancel).map((adapter) => adapter.api),
        );
        if (!job) {
          throw new MediaServiceError('not_found', 404, 'The job is unavailable.');
        }
        if (job.executionOwner !== 'media' || (job.phase !== 'cancelled' && !job.cancellation)) {
          throw new MediaServiceError(
            'cancel_unsupported',
            409,
            'This media job does not support cancellation.',
          );
        }
        observeMedia(deps.observer, {
          kind: 'cancellation',
          result: 'completed',
          jobId,
          tenantId: context.scope.tenantId,
          phase: job.phase,
          executionOwner: job.executionOwner,
          operation: job.operation,
        });
        void deps
          .publishActivity?.(context.scope, { threadId: job.threadId, version: job.version })
          .catch((error) =>
            deps.log('Media activity delivery failed.', error instanceof Error ? error : undefined),
          );
        return job;
      },
      async updateThread(threadId: string, update: MediaThreadUpdate, context: MediaContext) {
        assertMediaAccess(context);
        if (update.title && update.title.length > context.config.limits.maxTitleChars) {
          throw new MediaServiceError(
            'invalid_request',
            422,
            'The title exceeds the configured limit.',
          );
        }
        const result = await deps.repository.updateMediaThread({
          scope: context.scope,
          threadId,
          ...update,
        });
        if (!result) {
          throw new MediaServiceError('version_conflict', 409, 'The thread changed.');
        }
        return result;
      },
      async retire(threadId: string, context: MediaContext) {
        assertMediaAccess(context);
        await deps.reconcileNativeConsumers?.(context.scope, context.config, threadId);
        if (!(await deps.repository.retireMediaThread(context.scope, threadId))) {
          throw new MediaServiceError('not_found', 404, 'The thread is unavailable.');
        }
        return { threadId, phase: 'retiring' as const };
      },
      async retireMany(input: MediaThreadsDeleteRequest, context: MediaContext) {
        assertMediaAccess(context);
        if (input.mode === 'all') {
          await deps.reconcileNativeConsumers?.(context.scope, context.config);
          const retired = await deps.repository.retireAllMediaThreads(context.scope);
          return { retired, failures: [] };
        }
        if (input.threadIds.length > context.config.limits.maxPageSize) {
          throw new MediaServiceError('invalid_request', 422, 'Too many selected creations.');
        }
        const result: MediaThreadsDeletionReceipt = { retired: 0, failures: [] };
        for (const threadId of new Set(input.threadIds)) {
          try {
            await deps.reconcileNativeConsumers?.(context.scope, context.config, threadId);
            if (!(await deps.repository.retireMediaThread(context.scope, threadId))) {
              throw new MediaServiceError('not_found', 404, 'The thread is unavailable.');
            }
            result.retired++;
          } catch (error) {
            result.failures.push({
              threadId,
              error: {
                code: error instanceof MediaServiceError ? error.code : 'internal_error',
              },
            });
          }
        }
        return result;
      },
    },
    queries: {
      async jobDiagnostics(
        jobId: string,
        context: MediaContext,
      ): Promise<MediaJobDiagnosticsResponse> {
        assertMediaAccess(context);
        const result = await deps.repository.getMediaJobDiagnostics(context.scope, jobId);
        if (!result) {
          throw new MediaServiceError('not_found', 404, 'The job is unavailable.');
        }
        const diagnostic = mediaProviderDiagnosticSchema.safeParse(result.diagnostic);
        return diagnostic.success ? { diagnostic: diagnostic.data } : {};
      },
      async catalog(context: MediaContext): Promise<MediaCatalog> {
        assertMediaAccess(context);
        if (!context.config.enabled) {
          return {
            schemaVersion: 1,
            version: 'disabled',
            offerings: [],
            limits: context.config.limits,
          };
        }
        return (await snapshot(context)).catalog;
      },
      async threads(query: MediaThreadListRequest, context: MediaContext) {
        assertMediaAccess(context);
        if (query.search && query.search.length > context.config.limits.maxTitleChars) {
          throw new MediaServiceError(
            'invalid_request',
            422,
            'The search exceeds the configured title limit.',
          );
        }
        return deps.repository.listMediaThreads({
          scope: context.scope,
          cursor: query.cursor,
          limit: pageLimit(context, query.limit),
          filter: query.filter,
          include: query.include,
          search: query.search,
        });
      },
      async thread(threadId: string, context: MediaContext, query: MediaThreadDetailRequest = {}) {
        assertMediaAccess(context);
        const [thread, turns, latestImageContext, latestVideoContext] = await Promise.all([
          deps.repository.getMediaThread(context.scope, threadId),
          deps.repository.listMediaTurns({
            scope: context.scope,
            threadId,
            limit: pageLimit(context),
            jobsPerTurn: pageLimit(context),
          }),
          deps.repository.getMediaLatestImageContext({ scope: context.scope, threadId }),
          query.include === 'videoContext'
            ? deps.repository.getMediaLatestVideoContext({ scope: context.scope, threadId })
            : undefined,
        ]);
        if (!thread) {
          throw new MediaServiceError('not_found', 404, 'The thread is unavailable.');
        }
        return {
          thread,
          turns,
          latestImageContext: latestImageContext ?? undefined,
          ...(query.include === 'videoContext' &&
          (latestVideoContext || query.videoContextVersion === '2')
            ? { latestVideoContext: latestVideoContext ?? null }
            : {}),
        };
      },
      async turns(
        threadId: string,
        cursor: string | undefined,
        limit: number | undefined,
        context: MediaContext,
      ) {
        assertMediaAccess(context);
        return deps.repository.listMediaTurns({
          scope: context.scope,
          threadId,
          cursor,
          limit: pageLimit(context, limit),
          jobsPerTurn: pageLimit(context),
        });
      },
    },
    presets: {
      async list(context: MediaContext) {
        assertMediaAccess(context);
        return { items: await deps.repository.listMediaPresets(context.scope) };
      },
      async create(presetId: string, input: MediaPresetWrite, context: MediaContext) {
        assertMediaAccess(context, true);
        const write = createMediaPresetSchema(context.config.limits).parse(input);
        assertModelBoundContent({
          filters: context.appConfig.filters,
          legacyPii: context.appConfig.messageFilter?.pii
            ? messageFilterPiiSchema.parse(context.appConfig.messageFilter.pii)
            : undefined,
          submittedMessages: [{ role: 'user', content: write.title }],
          modelParameters: { options: write.settings.parameters },
        });
        return deps.repository
          .createMediaPreset({
            scope: context.scope,
            presetId,
            write,
            maxPresets: context.config.limits.maxPresets,
            maxInputs: context.config.limits.maxInputs,
            consumerConfig: context.config.limits,
          })
          .catch(presetError);
      },
      async update(presetId: string, input: MediaPresetUpdate, context: MediaContext) {
        assertMediaAccess(context, true);
        const update = createMediaPresetUpdateSchema(context.config.limits).parse(input);
        assertModelBoundContent({
          filters: context.appConfig.filters,
          legacyPii: context.appConfig.messageFilter?.pii
            ? messageFilterPiiSchema.parse(context.appConfig.messageFilter.pii)
            : undefined,
          submittedMessages: update.title ? [{ role: 'user', content: update.title }] : [],
          modelParameters: { options: update.settings?.parameters },
        });
        const preset = await deps.repository.updateMediaPreset({
          scope: context.scope,
          presetId,
          update,
          maxInputs: context.config.limits.maxInputs,
          consumerConfig: context.config.limits,
        });
        if (!preset) {
          throw new MediaServiceError('not_found', 404, 'The preset is unavailable.');
        }
        return preset;
      },
      async remove(presetId: string, context: MediaContext) {
        assertMediaAccess(context, true);
        if (
          !(await deps.repository.deleteMediaPreset(context.scope, presetId, context.config.limits))
        ) {
          throw new MediaServiceError('not_found', 404, 'The preset is unavailable.');
        }
        return { presetId };
      },
    },
  };
}

export const mediaAccountingMode = (appConfig: AppConfig): 'balance' | 'transactions' | 'none' => {
  if (appConfig.balance?.enabled) return 'balance';
  return appConfig.transactions?.enabled === false ? 'none' : 'transactions';
};
