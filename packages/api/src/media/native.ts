import { createHash, timingSafeEqual } from 'node:crypto';
import { EModelEndpoint, parseNativeMessageReference } from 'librechat-data-provider';
import type {
  MediaNativeMethods,
  NativeMessageMethods,
  NativeMessageFile,
  MediaOwnerScope,
} from '@librechat/data-schemas';
import type { MediaConfig, MediaIntegration, NativeSignatures } from 'librechat-data-provider';
import type { NativeMediaPart, NativeMediaPort, NativeMediaContent } from '@librechat/agents';
import type { MediaContext, MediaServiceDependencies } from './service';
import type { GeneratedImageFile } from '~/files/generated';
import type { MediaConnection } from './provider';
import { assertMediaAccess } from './service';
import { MediaServiceError } from './errors';

export interface NativeMediaSelection {
  provider: string;
  model: string;
  agentId?: string;
  usageType?: 'subagent' | 'sequential';
  responseModalities?: string[];
  apiKey?: string;
  baseURL?: string;
}
export type NativeMediaFactory = (
  selection: NativeMediaSelection,
) => Promise<NativeMediaPort | undefined>;
export interface MediaChatSource {
  conversationId: string;
  messageId: string;
  prompt: string;
  temporary: boolean;
  expiresAt?: string;
  nativeSignatures?: NativeSignatures;
  previousContent?: unknown[];
  onSignatures?(signatures: NativeSignatures): Promise<void>;
}

export type NativeMediaUsageSink = (input: {
  modelRunId: string;
  model: string;
  provider: string;
  agentId?: string;
  usageType?: NativeMediaSelection['usageType'];
  usage: NonNullable<Parameters<NativeMediaPort['fail']>[0]['usage']>;
}) => void | Promise<void>;

function secretsMatch(candidate: string | undefined, expected: string | undefined): boolean {
  if (candidate == null || expected == null) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The SDK owns the model invocation and chat debit; this port records its ordered output. */
export function createNativeMediaFactory({
  deps,
  repository,
  config,
  resolveContext,
  source,
  files,
  onUsage,
}: {
  deps: MediaServiceDependencies;
  repository: Pick<MediaNativeMethods, 'getMediaNativeContinuations'> &
    Partial<NativeMessageMethods>;
  files?: {
    save(part: Extract<NativeMediaPart, { kind: 'image' }>): Promise<GeneratedImageFile>;
    read(scope: MediaOwnerScope, file: NativeMessageFile, maxBytes: number): Promise<Buffer>;
  };
  config: MediaConfig;
  resolveContext(): Promise<MediaContext>;
  source: MediaChatSource;
  onUsage?: NativeMediaUsageSink;
}): NativeMediaFactory {
  const signatures = source.nativeSignatures ?? {};
  const saved = new Map<string, NativeMediaPart>();
  const contentByPosition = new Map<string, NativeMediaContent>();
  const fingerprints = new Map<string, string>();
  const fileByReference = new Map<string, string>();
  let metadataBytes = Buffer.byteLength(JSON.stringify(signatures));
  let nextIndex = Object.keys(signatures).reduce((max, key) => Math.max(max, Number(key) + 1), 0);
  return async (selection) => {
    if (selection.provider.toLowerCase() !== 'google') {
      return undefined;
    }
    let contextPromise: Promise<MediaContext> | undefined;
    const getContext = () => (contextPromise ??= resolveContext());
    const integration = config.integrations.find(
      (entry) =>
        entry.enabled !== false &&
        entry.api === 'google.generateContent' &&
        entry.endpointRef.kind === 'builtin' &&
        entry.endpointRef.endpoint === 'google' &&
        (entry.catalog.kind === 'configured'
          ? entry.catalog.models
          : entry.catalog.allowModels
        ).includes(selection.model),
    );
    const requested = selection.responseModalities;
    let modalities = requested ?? (integration ? ['TEXT', 'IMAGE'] : ['TEXT']);
    let wantsImages = modalities.some((modality) => modality.toUpperCase() === 'IMAGE');
    const historyIntegration: MediaIntegration = integration ?? {
      id: 'native-google-history',
      api: 'google.generateContent',
      endpointRef: { kind: 'builtin', endpoint: EModelEndpoint.google },
      catalog: { kind: 'configured', models: [selection.model] },
      operations: ['image.generate'],
    };
    let connectionPromise: Promise<MediaConnection> | undefined;
    const getConnection = () =>
      (connectionPromise ??= (async () => {
        const context = await getContext();
        const connection = await deps.resolveConnection({
          scope: context.scope,
          integration: historyIntegration,
          appConfig: context.appConfig,
          minValidityMs: wantsImages ? context.config.credentials.minValidityAtDispatchMs : 0,
          user: context.user,
        });
        const base = (value: string) => value.replace(/\/$/, '').replace(/\/v1beta$/, '');
        const keyMatches = secretsMatch(selection.apiKey, connection.headers['x-goog-api-key']);
        const urlMatches =
          base(selection.baseURL ?? 'https://generativelanguage.googleapis.com') ===
          base(connection.baseURL);
        if (!keyMatches || !urlMatches) {
          throw new MediaServiceError(
            'credentials_required',
            403,
            'Native media must use the configured Google connection.',
          );
        }
        return connection;
      })());
    const getExecution = async () => {
      const connection = await getConnection();
      return {
        connectionId: historyIntegration.id,
        endpointRef: historyIntegration.endpointRef,
        modelId: selection.model,
        api: connection.api,
        catalogVersion: 'native-chat',
        bindingRevision: connection.binding,
        accountingMode: 'none' as const,
      };
    };
    const runs = new Map<string, { images: number }>();
    const assertOutput = async () => {
      const context = await getContext();
      assertMediaAccess(context, true);
      if (source.prompt.length > context.config.limits.maxPromptChars) {
        throw new MediaServiceError(
          'invalid_request',
          422,
          'Native media prompt exceeds the configured limit.',
        );
      }
      if (!integration || !context.config.surfaces.chat) {
        throw new MediaServiceError(
          'unsupported',
          422,
          'Enable this Google image model in media configuration.',
        );
      }
      if (!files)
        throw new MediaServiceError('not_ready', 503, 'Native image storage is unavailable.');
      if (source.expiresAt && Date.parse(source.expiresAt) <= deps.now())
        throw new MediaServiceError('not_found', 404, 'The native conversation has expired.');
      return context;
    };
    /** Images are only a default for configured models; a turn that cannot record them stays text. */
    const canOutputImages = () =>
      assertOutput()
        .then(getConnection)
        .then(
          () => true,
          (error: unknown) => {
            if (error instanceof MediaServiceError) return false;
            throw error;
          },
        );
    return {
      async start({ modelRunId, model, signal }) {
        if (wantsImages && requested == null && !(await canOutputImages())) {
          wantsImages = false;
          modalities = ['TEXT'];
        }
        if (!wantsImages) {
          return requested == null && !integration ? undefined : { responseModalities: modalities };
        }
        const context = await assertOutput();
        await getConnection();
        if (signal?.aborted || model !== selection.model) {
          throw new MediaServiceError(
            'invalid_request',
            400,
            'The native model invocation changed.',
          );
        }
        if (runs.size >= context.config.execution.maxActivePerUser) {
          throw new MediaServiceError(
            'quota_exceeded',
            429,
            'Too many native recordings are active.',
          );
        }
        runs.set(modelRunId, { images: 0 });
        return { responseModalities: modalities };
      },
      async part({ modelRunId, chunkIndex, partIndex, part }) {
        if (!wantsImages) {
          if (part.kind !== 'text') {
            await assertOutput();
            throw new MediaServiceError(
              'unsupported',
              422,
              'Image output was not enabled for this invocation.',
            );
          }
          return { type: 'text', text: part.text };
        }
        const run = runs.get(modelRunId);
        if (!run)
          throw new MediaServiceError('not_ready', 409, 'Native media recording has not started.');
        if (part.kind === 'text' && part.thoughtSignature == null)
          return { type: 'text', text: part.text };
        const position = `${modelRunId}:${chunkIndex}:${partIndex}`;
        const fingerprint = createHash('sha256').update(JSON.stringify(part)).digest('hex');
        const existing = contentByPosition.get(position);
        if (existing) {
          if (fingerprints.get(position) !== fingerprint)
            throw new MediaServiceError('invalid_request', 409, 'Native part bytes changed.');
          return existing;
        }
        const context = await getContext();
        const signature =
          part.kind === 'text'
            ? { thoughtSignature: part.thoughtSignature, text: part.text }
            : { thoughtSignature: part.thoughtSignature, mimeType: part.mimeType };
        const bytes = Buffer.byteLength(JSON.stringify(signature));
        if (
          nextIndex >= context.config.limits.maxNativeParts ||
          bytes > context.config.limits.maxNativePartBytes ||
          metadataBytes + bytes > context.config.limits.maxNativeRecordingBytes
        ) {
          throw new MediaServiceError(
            'quota_exceeded',
            413,
            'Native replay metadata exceeds the configured limit.',
          );
        }
        if (part.kind === 'image') {
          if (run.images >= context.config.limits.maxOutputs)
            throw new MediaServiceError(
              'quota_exceeded',
              429,
              'The native image output limit was reached.',
            );
          if (
            part.data.length > Math.ceil(context.config.transfers.maxImageBytes / 3) * 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)
          ) {
            throw new MediaServiceError(
              'invalid_request',
              413,
              'Native image exceeds the configured limit.',
            );
          }
        }
        const index = String(nextIndex++);
        const continuationRef = `${source.messageId}:${index}`;
        let content: NativeMediaContent;
        if (part.kind === 'text')
          content = { type: 'text', text: part.text, native_media: { continuationRef } };
        else {
          const file = await files!.save(part);
          content = {
            type: 'image_file',
            image_file: {
              file_id: file.file_id,
              filepath: file.filepath,
              filename: file.filename,
              bytes: file.bytes,
              type: file.type,
              width: file.width,
              height: file.height,
            },
            native_media: { continuationRef },
          };
          fileByReference.set(continuationRef, file.file_id);
          run.images++;
        }
        signatures[index] = signature;
        await source.onSignatures?.(signatures);
        saved.set(continuationRef, part);
        contentByPosition.set(position, content);
        fingerprints.set(position, fingerprint);
        metadataBytes += bytes;
        return content;
      },
      async complete({ modelRunId }) {
        runs.delete(modelRunId);
      },
      async fail({ modelRunId, usage }) {
        runs.delete(modelRunId);
        if (usage)
          await onUsage?.({
            modelRunId,
            usage,
            model: selection.model,
            provider: selection.provider,
            agentId: selection.agentId,
            usageType: selection.usageType,
          });
      },
      async restore(input) {
        return (await restoreBatch({ parts: [input] }))[0];
      },
      restoreBatch,
    };

    async function restoreBatch({
      parts,
      signal,
    }: Parameters<NonNullable<NativeMediaPort['restoreBatch']>>[0]): Promise<NativeMediaPart[]> {
      const context = await getContext();
      assertMediaAccess(context);
      signal?.throwIfAborted();
      const result: NativeMediaPart[] = [];
      const limit = context.config.limits.maxNativeParts;
      for (let offset = 0; offset < parts.length; offset += limit) {
        signal?.throwIfAborted();
        const batch = parts.slice(offset, offset + limit);
        const modern = batch.filter(
          ({ continuationRef }) =>
            continuationRef &&
            parseNativeMessageReference(continuationRef) &&
            !saved.has(continuationRef),
        );
        const modernParts =
          modern.length && repository.getNativeMessageParts
            ? await repository.getNativeMessageParts({
                scope: context.scope,
                conversationId: source.conversationId,
                references: modern.map(({ continuationRef, file_id }) => ({
                  continuationRef: continuationRef!,
                  fileId: file_id,
                })),
                limit,
              })
            : [];
        const byRef = new Map(
          modern.map((part, index) => [part.continuationRef, modernParts[index]]),
        );
        const legacy = batch.filter(
          ({ continuationRef }) =>
            !continuationRef || !parseNativeMessageReference(continuationRef),
        );
        const legacyParts = legacy.length
          ? await repository.getMediaNativeContinuations({
              scope: context.scope,
              execution: await getExecution(),
              conversationId: source.conversationId,
              references: legacy.map(({ file_id, continuationRef }) => ({
                fileId: file_id,
                continuationRef,
              })),
              limit,
            })
          : [];
        let legacyIndex = 0;
        for (const reference of batch) {
          signal?.throwIfAborted();
          const cached = reference.continuationRef && saved.get(reference.continuationRef);
          if (cached) {
            if (
              reference.file_id &&
              reference.file_id !== fileByReference.get(reference.continuationRef!)
            )
              throw new MediaServiceError('not_found', 404, 'Native file reference changed.');
            result.push(cached);
            continue;
          }
          if (reference.continuationRef && parseNativeMessageReference(reference.continuationRef)) {
            const part = byRef.get(reference.continuationRef);
            if (!part)
              throw new MediaServiceError(
                'not_found',
                404,
                'Native message continuation is unavailable.',
              );
            if (part.kind === 'text') result.push(part);
            else {
              if (!files)
                throw new MediaServiceError(
                  'not_ready',
                  503,
                  'Native image storage is unavailable.',
                );
              const data = await files.read(
                context.scope,
                part.file,
                context.config.transfers.maxImageBytes,
              );
              result.push({
                kind: 'image',
                mimeType: part.file.type,
                data: data.toString('base64'),
                thoughtSignature: part.thoughtSignature,
              });
            }
            continue;
          }
          const stored = legacyParts[legacyIndex++];
          if (!stored)
            throw new MediaServiceError(
              'not_found',
              404,
              'Native continuation is unavailable for this connection.',
            );
          if (stored.part.kind === 'text') result.push(stored.part);
          else {
            const { asset, data } = await deps.storage.read(
              context.scope,
              stored.part.fileId,
              context.config.transfers.maxImageBytes,
            );
            result.push({
              kind: 'image',
              mimeType: asset.type,
              data: data.toString('base64'),
              thoughtSignature: stored.part.thoughtSignature,
            });
          }
        }
      }
      return result;
    }
  };
}
