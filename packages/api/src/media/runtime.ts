import { randomUUID } from 'node:crypto';
import { FileSources } from 'librechat-data-provider';
import { getMediaConfig } from '@librechat/data-schemas';
import {
  FileContext,
  getNativeContinuationRefs,
  parseNativeMessageReference,
} from 'librechat-data-provider';
import type {
  MediaMethods,
  MediaNativeMethods,
  MediaPresetMethods,
  MediaTitleMethods,
  MediaRecoveryMethods,
  AppConfig,
  IUser,
  MediaOwnerScope,
  KeyMethods,
  MediaFileConsumerMethods,
} from '@librechat/data-schemas';
import type { NativeMessageMethods } from '@librechat/data-schemas';
import type { MediaConfig } from 'librechat-data-provider';
import type { Request, Router } from 'express';
import type {
  GeneratedImageFile,
  GeneratedImageRequest,
  SaveGeneratedImageOptions,
} from '~/files/generated';
import type {
  MediaAccounting,
  MediaContext,
  MediaServices,
  MediaServiceDependencies,
} from './service';
import type { MediaChatSource, NativeMediaFactory, NativeMediaUsageSink } from './native';
import type { BalanceCreditReservationDeps } from '~/middleware/checkBalance';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import type { ModerationCheck } from '~/middleware/moderation';
import type { MediaVertexCredentialProvider } from './vertex';
import type { MediaDerivativeProcessor } from './derivatives';
import type { MediaLifecycleObserver } from './telemetry';
import type { MediaRecoveryServices } from './recovery';
import type { MediaAdmissionPolicy } from './admission';
import type { MediaCatalogCache } from './catalogCache';
import type { MediaStrategyResolver } from './objects';
import type { MediaProviderAdapter } from './provider';
import type { MediaEnvironment } from './credentials';
import type { RecordUsageDeps } from '~/agents/usage';
import type { MediaTransport } from './transport';
import type { MediaObjectStore } from './objects';
import type { MediaModelTracer } from './tracing';
import type { MediaUploadFactory } from './http';
import type { EndpointDbMethods } from '~/types';
import type { MediaWorker } from './worker';
import { createMediaTitleGenerator, createMediaTitleModelResolver } from './title';
import { createMediaServices, mediaTemporaryRetentionMs } from './service';
import { createMediaStorage, resolveMediaStorageSource } from './storage';
import { createMediaCredentialResolver } from './credentials';
import { createRESTMediaAdapters } from './adapters/rest';
import { createMediaRecoveryServices } from './recovery';
import { readNativeMessageImage } from './nativeFiles';
import { getRoleForAccess } from '~/middleware/access';
import { createNativeMediaFactory } from './native';
import { createMediaContentRouter } from './stream';
import { resolveMediaPermissions } from './config';
import { ALLOWED_USER_FIELDS } from '~/utils/env';
import { createMediaTools } from '~/tools/media';
import { MediaActivityStream } from './events';
import { createMediaStaging } from './staging';
import { createMediaWorker } from './worker';
import { MediaServiceError } from './errors';
import { mediaToolContext } from './context';
import { createMediaRouter } from './http';

type MediaActor = NonNullable<MediaContext['user']>;
export interface MediaRuntimeDependencies {
  eventTransport?: IEventTransport;
  now?(): number;
  saveNativeImage?(url: string, options: SaveGeneratedImageOptions): Promise<GeneratedImageFile>;
  getNativeFileStrategy?: MediaStrategyResolver;
  catalogCache?: MediaCatalogCache;
  isLeader?: () => Promise<boolean>;
  observer?: MediaLifecycleObserver;
  modelTracer?: MediaModelTracer;
  appConfig: AppConfig;
  repository: MediaMethods &
    Pick<KeyMethods, 'getUserKeySnapshot'> &
    MediaNativeMethods &
    MediaPresetMethods &
    Partial<
      MediaTitleMethods & MediaRecoveryMethods & MediaFileConsumerMethods & NativeMessageMethods
    >;
  /** Enables LLM-generated thread titles; provider credentials and billing come from the host. */
  titles?: {
    db: EndpointDbMethods;
    usage?: RecordUsageDeps;
    admission?: Omit<BalanceCreditReservationDeps, 'balanceConfig'>;
  };
  getUserById(id: string, select: string): Promise<Omit<MediaActor, 'id'> | null>;
  getRoleByName(
    name: string,
  ): Promise<{ permissions?: { MEDIA?: { USE?: boolean; CREATE?: boolean } } } | null>;
  getAppConfig(options: {
    userId?: string;
    role?: string;
    tenantId?: string;
    idOnTheSource?: string | null;
    failClosed?: boolean;
  }): Promise<AppConfig>;
  tenantContext: { run<T>(scope: { tenantId?: string }, work: () => Promise<T>): Promise<T> };
  asSystem<T>(work: () => Promise<T>): Promise<T>;
  environment: MediaEnvironment;
  vertexCredentials?: MediaVertexCredentialProvider;
  decrypt(value: string): Promise<string>;
  resolveConfigSecret?(value: string): string | undefined;
  transport: MediaTransport;
  adapters?: readonly MediaProviderAdapter[];
  admission?: MediaAdmissionPolicy;
  moderate?: ModerationCheck;
  upload: MediaUploadFactory;
  accounting: MediaAccounting;
  objectStores?: readonly MediaObjectStore[];
  derivatives?: MediaDerivativeProcessor;
  deferAssetDeletion?: MediaServiceDependencies['deferAssetDeletion'];
  deferAssetWriteDeletion?: MediaServiceDependencies['deferAssetWriteDeletion'];
  log(message: string, error?: Error): void;
  warn?(message: string, error?: Error): void;
  info?(message: string): void;
}

export interface MediaRuntime {
  closeActivity(): void;
  router: Router;
  contentRouter: Router;
  services: MediaServices;
  recovery?: MediaRecoveryServices;
  worker: MediaWorker;
  tools(request: Request, signal?: AbortSignal): ReturnType<typeof createMediaTools>;
  nativeFactory(
    request: Request,
    source: MediaChatSource,
    onUsage?: NativeMediaUsageSink,
  ): Promise<NativeMediaFactory | undefined>;
}

export function createMediaRuntime(input: MediaRuntimeDependencies): MediaRuntime {
  const now = input.now ?? Date.now;
  const { repository } = input;
  const baseConfig = getMediaConfig(input.appConfig);
  const activity =
    input.eventTransport && baseConfig.events.enabled
      ? new MediaActivityStream(input.eventTransport, baseConfig.events)
      : undefined;
  const imageDirectory = input.appConfig.paths?.imageOutput;
  const uploadDirectory = input.appConfig.paths?.uploads;
  if (!imageDirectory || !uploadDirectory) {
    throw new Error('Media storage paths are unavailable.');
  }
  const storage = createMediaStorage({
    repository,
    imageDirectory,
    uploadDirectory,
    now,
    stores: input.objectStores,
    derivatives: input.derivatives,
    imageOutputType: input.appConfig.imageOutputType,
    log: input.log,
  });
  const staging = createMediaStaging({
    directory: `${uploadDirectory}/temp`,
    legacyDirectory: `${uploadDirectory}/media-staging`,
    id: randomUUID,
  });
  const adapters = input.adapters ?? createRESTMediaAdapters();
  const resolveConnection = createMediaCredentialResolver({
    repository,
    environment: input.environment,
    decrypt: input.decrypt,
    now,
    vertexCredentials: input.vertexCredentials,
    adapters,
    resolveConfigSecret: input.resolveConfigSecret,
  });
  async function actorContext(
    actor: MediaActor,
    effectiveConfig?: AppConfig,
    request?: Request,
  ): Promise<MediaContext> {
    const [appConfig, role] = await Promise.all([
      effectiveConfig
        ? Promise.resolve(effectiveConfig)
        : input.getAppConfig({
            userId: actor.id,
            role: actor.role,
            tenantId: actor.tenantId,
            idOnTheSource: actor.idOnTheSource,
            failClosed: true,
          }),
      actor.role
        ? getRoleForAccess({
            req: request,
            roleName: actor.role,
            getRoleByName: input.getRoleByName,
          })
        : Promise.resolve(null),
    ]);
    const configured = getMediaConfig(appConfig);
    const config = {
      ...configured,
      assets: {
        ...configured.assets,
        source: resolveMediaStorageSource({ config: configured, appConfig }) as NonNullable<
          MediaConfig['assets']['source']
        >,
      },
    };
    const store = input.objectStores?.find((entry) => entry.source === config.assets.source);
    return {
      scope: { ownerId: actor.id, tenantId: actor.tenantId ?? null },
      user: actor,
      appConfig,
      config,
      storageSources: [
        FileSources.local,
        ...(input.objectStores ?? []).map((store) => store.source),
      ],
      storageReady: (await store?.isAvailable?.()) ?? true,
      ...resolveMediaPermissions(role),
    };
  }
  const loadContext = async (scope: MediaOwnerScope) => {
    const actor = await input.getUserById(
      scope.ownerId,
      `${ALLOWED_USER_FIELDS.join(' ')} tenantId idOnTheSource`,
    );
    if (!actor || (actor.tenantId ?? null) !== (scope.tenantId ?? null)) {
      throw new MediaServiceError('forbidden', 403, 'The media owner is unavailable.');
    }
    return actorContext({ ...actor, id: scope.ownerId });
  };
  const withScope = <T>(scope: MediaOwnerScope, operation: () => Promise<T>) =>
    input.tenantContext.run({ tenantId: scope.tenantId ?? undefined }, operation);
  const titles =
    input.titles && repository.claimMediaThreadTitle
      ? createMediaTitleGenerator({
          repository: {
            replaceMediaThreadTitle: repository.replaceMediaThreadTitle,
            claimMediaThreadTitle: repository.claimMediaThreadTitle,
          },
          resolveModel: createMediaTitleModelResolver({ db: input.titles.db }),
          modelTracer: input.modelTracer,
          usage: input.titles.usage,
          admission: input.titles.admission,
          withScope,
          log: input.log,
        })
      : undefined;
  const deps = {
    publishActivity: activity?.publish.bind(activity),
    catalogCache: input.catalogCache,
    isLeader: input.isLeader,
    warn: input.warn,
    info: input.info,
    observer: input.observer,
    modelTracer: input.modelTracer,
    repository,
    storage,
    resolveConnection,
    describeUserKey: resolveConnection.describe,
    loadContext,
    accounting: input.accounting,
    titles,
    temporaryRetentionMs: mediaTemporaryRetentionMs(input.appConfig.interfaceConfig),
    ensureReady: async () => {
      await Promise.all([
        repository.ensureMediaNativeIndexes(),
        repository.ensureMediaPresetIndexes(),
        input.derivatives?.prepare?.(baseConfig),
      ]);
    },
    sweepStaging: staging.sweep,
    deferAssetDeletion: input.deferAssetDeletion,
    deferAssetWriteDeletion: input.deferAssetWriteDeletion,
    async reconcileNativeConsumers(scope: MediaOwnerScope, config: MediaConfig, threadId?: string) {
      await repository.reconcileMediaNativeConsumers({
        scope,
        threadId,
        maxRetainers: config.limits.maxAssetRetainers,
        limit: config.limits.pageSize,
      });
    },
    reconcileNative: async (scope: MediaOwnerScope, config: typeof baseConfig) => {
      await repository.reconcileMediaNativeRecordings({
        scope,
        now: new Date().toISOString(),
        staleBefore: new Date(Date.now() - config.recovery.attentionAfterMs).toISOString(),
        limit: config.limits.pageSize,
      });
    },
    reconcileFileConsumers: async (scope: MediaOwnerScope, config: MediaConfig) => {
      await repository.reconcileMediaFileConsumers?.({
        scope,
        limit: config.limits.pageSize,
        retryMs: config.limits.consumerReconcileMs,
      });
    },
    adapters,
    transport: input.transport,
    moderate: input.moderate,
    asSystem: input.asSystem,
    withScope,
    now,
    id: randomUUID,
    log: input.log,
  };
  const services = createMediaServices(deps);
  const recovery =
    repository.listMediaRecoveryJobs && repository.resolveMediaRecovery
      ? createMediaRecoveryServices(
          deps,
          {
            listMediaRecoveryJobs: repository.listMediaRecoveryJobs,
            resolveMediaRecovery: repository.resolveMediaRecovery,
            failMediaNativeRecording: repository.failMediaNativeRecording,
          },
          baseConfig,
        )
      : undefined;
  const worker = createMediaWorker(deps, services, baseConfig);
  const requestUser = (request: Request): IUser => {
    const user = (request as Request & { user?: IUser }).user;
    if (!user?.id) {
      throw new MediaServiceError('forbidden', 403, 'Authentication is required.');
    }
    return user;
  };
  const resolveContext = async (request: Request): Promise<MediaContext> => {
    const user = requestUser(request);
    return {
      ...(await actorContext(user, (request as Request & { config?: AppConfig }).config, request)),
      user,
    };
  };
  const router = createMediaRouter({
    activity,
    admission: input.admission,
    services,
    storage,
    repository,
    upload: input.upload,
    staging,
    id: randomUUID,
    now,
    log: input.log,
    resolveContext,
    resolveScope: (request) => {
      const user = requestUser(request);
      return { ownerId: user.id, tenantId: user.tenantId ?? null };
    },
  });
  return {
    closeActivity: () => activity?.close(),
    router,
    contentRouter: createMediaContentRouter({
      repository,
      storage,
      resolveScope: (request) => {
        const user = requestUser(request);
        return { ownerId: user.id, tenantId: user.tenantId ?? null };
      },
      log: input.log,
    }),
    services,
    worker,
    recovery,
    tools: (request, signal) =>
      createMediaTools({
        services,
        repository,
        resolveContext: async () => mediaToolContext(request, await resolveContext(request), now()),
        admitGeneration: async () => {
          if (!input.admission?.admitToolGeneration) {
            throw new MediaServiceError('not_ready', 503, 'Media tool admission is unavailable.');
          }
          await input.admission.admitToolGeneration(request);
        },
        signal,
        now,
      }),
    async nativeFactory(
      request: Request,
      source: MediaChatSource,
      onUsage?: NativeMediaUsageSink,
    ): Promise<NativeMediaFactory | undefined> {
      if (!baseConfig.enabled && !worker.available) {
        return undefined;
      }
      const user = (request as Request & { user?: MediaActor }).user;
      if (!user?.id) {
        throw new MediaServiceError('forbidden', 403, 'Authentication is required.');
      }
      let currentContext: Promise<MediaContext> | undefined;
      const effectiveConfig =
        (request as Request & { config?: AppConfig }).config ?? input.appConfig;
      const references = getNativeContinuationRefs(source.previousContent).filter(
        (ref) => parseNativeMessageReference(ref)?.messageId === source.messageId,
      );
      if (references.length) {
        if (!repository.getNativeMessageParts)
          throw new MediaServiceError('not_ready', 503, 'Native message replay is unavailable.');
        const stored = await repository.getNativeMessageParts({
          scope: { ownerId: user.id, tenantId: user.tenantId ?? null },
          conversationId: source.conversationId,
          references: references.map((continuationRef) => ({ continuationRef })),
          limit: getMediaConfig(effectiveConfig).limits.maxNativeParts,
        });
        source.nativeSignatures ??= {};
        stored.forEach((part, index) => {
          if (!part)
            throw new MediaServiceError(
              'not_found',
              404,
              'Paused native message replay is unavailable.',
            );
          const parsed = parseNativeMessageReference(references[index])!;
          source.nativeSignatures![parsed.index] =
            part.kind === 'text'
              ? { text: part.text, thoughtSignature: part.thoughtSignature }
              : { mimeType: part.file.type, thoughtSignature: part.thoughtSignature };
        });
      }
      const nativeRequest: GeneratedImageRequest = Object.assign(Object.create(request), {
        config: effectiveConfig,
        user,
      });
      return createNativeMediaFactory({
        deps,
        repository,
        config: getMediaConfig(effectiveConfig),
        resolveContext: () => (currentContext ??= actorContext(user, effectiveConfig, request)),
        source,
        files:
          input.saveNativeImage && input.getNativeFileStrategy
            ? {
                save: (part) =>
                  input.saveNativeImage!(`data:${part.mimeType};base64,${part.data}`, {
                    req: nativeRequest,
                    filename: 'native-image',
                    endpoint: 'google',
                    context: FileContext.image_generation,
                    preserveOriginal: true,
                  }),
                read: (scope, file, maxBytes) =>
                  readNativeMessageImage(
                    input.getNativeFileStrategy!,
                    nativeRequest,
                    scope,
                    file,
                    maxBytes,
                  ),
              }
            : undefined,
        onUsage,
      });
    },
  };
}
