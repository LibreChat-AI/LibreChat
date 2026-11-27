import path from 'path';
import { v4 } from 'uuid';
import { createHash } from 'node:crypto';
import { megabyte, fileConfig, imageExtRegex, inferMimeType } from 'librechat-data-provider';
import type { CodeEnvRef, FileSources, getEndpointFileConfig } from 'librechat-data-provider';
import type { CodeFileCommitData } from '@librechat/data-schemas';
import type {
  CodeOutputResult,
  CodeOutputStoredFile,
  CodeOutputPersistence,
  CodeOutputPublication,
  CodeOutputDownloadFallback,
  ProcessPublishedCodeOutputInput,
} from './publication';
import type { FileProvisionStorage, FileStorageUploadObserver } from '../operations';
import type { sanitizeArtifactPath, flattenArtifactPath } from '~/utils/files';
import type { classifyCodeArtifact, CodeArtifactCategory } from './classify';
import type { hasOfficeHtmlPath, getExtractedTextFormat } from './extract';
import type { RetentionExpiry } from '~/files/retention';
import type { extractCodeArtifactText } from './extract';
import type { logAxiosError } from '~/utils/axios';
import type { ServerRequest } from '~/types';
import { withFileProvisioning, FileProvisionPersistenceError } from '../operations';
import { createCodeOutputPersistence } from './publication';

export type CodeOutputProcessorInput = Omit<
  ProcessPublishedCodeOutputInput,
  'publication' | 'agentId'
> & {
  req: ServerRequest & Required<Pick<ServerRequest, 'user' | 'config'>>;
  agentId?: string;
  toolCallId?: string;
  freshClaimAfter?: number;
  downloadFallback?: boolean;
  publication?: CodeOutputPublication;
};

type DownloadInput = Pick<
  CodeOutputProcessorInput,
  'req' | 'id' | 'session_id' | 'codeApiBaseUrl' | 'executionProfile' | 'bridgeWorkerId'
> & { maxBytes: number };

type DownloadFallbackInput = Pick<
  CodeOutputProcessorInput,
  | 'id'
  | 'name'
  | 'agentId'
  | 'messageId'
  | 'toolCallId'
  | 'session_id'
  | 'conversationId'
  | 'executionProfile'
  | 'executionRouteKey'
> & { expiresAt: number };

export interface CodeOutputProcessorDeps {
  fileStorage: FileProvisionStorage;
  getCodeOutputFileSettings: (req: ServerRequest) => {
    endpointFileConfig: ReturnType<typeof getEndpointFileConfig>;
    fileSizeLimit: number;
  };
  downloadCodeOutputBuffer: (input: DownloadInput) => Promise<Buffer>;
  createDownloadFallback: (input: DownloadFallbackInput) => CodeOutputDownloadFallback;
  getRetentionExpiry: (req: ServerRequest) => Promise<RetentionExpiry>;
  convertImage: (
    req: ServerRequest,
    buffer: Buffer,
    detail: 'high',
    filename: string,
  ) => Promise<
    Pick<
      CodeOutputStoredFile,
      'filepath' | 'bytes' | 'width' | 'height' | 'storageKey' | 'storageRegion'
    > & { sha256: string }
  >;
  getStrategyFunctions: (source: FileSources) => {
    saveBuffer?: (input: {
      userId: string;
      buffer: Buffer;
      fileName: string;
      basePath: string;
      tenantId?: string;
    }) => Promise<string>;
  };
  determineFileType: (
    buffer: Buffer,
    reportErrors: boolean,
  ) => Promise<{ mime: string } | undefined>;
  claimCodeFile: CodeOutputPersistence['claim'];
  commitCodeFile: (data: CodeFileCommitData, sourceDispatchedAt?: number) => Promise<boolean>;
  finalizePreview: (input: {
    buffer: Buffer;
    leafName: string;
    mimeType: string;
    category: CodeArtifactCategory;
    file_id: string;
    previewRevision?: string | null;
  }) => Promise<CodeOutputStoredFile | null>;
  hasOfficeHtmlPath: typeof hasOfficeHtmlPath;
  sanitizeArtifactPath: typeof sanitizeArtifactPath;
  flattenArtifactPath: typeof flattenArtifactPath;
  classifyCodeArtifact: typeof classifyCodeArtifact;
  extractCodeArtifactText: typeof extractCodeArtifactText;
  getExtractedTextFormat: typeof getExtractedTextFormat;
  getStorageMetadata: (
    file: Pick<CodeOutputStoredFile, 'filepath' | 'source' | 'storageKey' | 'storageRegion'>,
  ) => Pick<CodeOutputStoredFile, 'storageKey' | 'storageRegion'>;
  logAxiosError: typeof logAxiosError;
  logger: { warn: (message: string) => void; debug: (message: string) => void };
}

/** Persists ordinary outputs or explicit publications, returning owned preview work separately. */
export async function processCodeOutput(
  {
    req,
    id,
    name,
    toolCallId,
    conversationId,
    messageId,
    session_id,
    agentId,
    freshClaimAfter,
    codeApiBaseUrl,
    executionProfile = 'default',
    executionRouteKey = executionProfile,
    bridgeWorkerId,
    preparedBuffer,
    downloadFallback,
    publication,
  }: CodeOutputProcessorInput,
  {
    getCodeOutputFileSettings,
    downloadCodeOutputBuffer,
    createDownloadFallback,
    getRetentionExpiry,
    convertImage,
    getStrategyFunctions,
    determineFileType,
    claimCodeFile,
    fileStorage,
    finalizePreview,
    hasOfficeHtmlPath,
    sanitizeArtifactPath,
    flattenArtifactPath,
    classifyCodeArtifact,
    extractCodeArtifactText,
    getExtractedTextFormat,
    getStorageMetadata,
    logAxiosError,
    logger,
  }: CodeOutputProcessorDeps,
): Promise<CodeOutputResult | null> {
  const appConfig = req.config;
  const currentDate = new Date();
  const fileExt = path.extname(name).toLowerCase();
  const isImage = fileExt && imageExtRegex.test(name);

  const { endpointFileConfig, fileSizeLimit } = getCodeOutputFileSettings(req);

  try {
    const formattedDate = currentDate.toISOString();
    if (downloadFallback === true) {
      return {
        file: createDownloadFallback({
          id,
          name,
          agentId,
          messageId,
          toolCallId,
          session_id,
          conversationId,
          executionProfile,
          executionRouteKey,
          expiresAt: currentDate.getTime() + 86400000,
        }),
      };
    }
    const retentionExpiryPromise = getRetentionExpiry(req);
    const buffer =
      preparedBuffer ??
      (await downloadCodeOutputBuffer({
        req,
        id,
        session_id,
        maxBytes: fileSizeLimit,
        codeApiBaseUrl,
        executionProfile,
        bridgeWorkerId,
      }));

    // Enforce file size limit
    if (buffer.length > fileSizeLimit) {
      logger.warn(
        `[processCodeOutput] File "${name}" (${(buffer.length / megabyte).toFixed(2)} MB) exceeds size limit of ${(fileSizeLimit / megabyte).toFixed(2)} MB, falling back to download URL`,
      );
      return {
        file: createDownloadFallback({
          id,
          name,
          agentId,
          messageId,
          toolCallId,
          session_id,
          conversationId,
          executionProfile,
          executionRouteKey,
          expiresAt: currentDate.getTime() + 86400000,
        }),
      };
    }

    /* Code-output files belong to the user who ran the execution.
     * SessionKey on codeapi will be `<tenant>:user:<userId>` for these,
     * so cache and access stay user-private. */
    const codeEnvRef: CodeEnvRef = {
      kind: 'user',
      id: req.user.id,
      storage_session_id: session_id,
      file_id: id,
      executionProfile,
      ...(executionRouteKey !== executionProfile ? { executionRouteKey } : {}),
    };

    /* `safeName` keeps the directory structure (`a/b/file.txt` -> `a/b/file.txt`)
     * so the next prime() can place the file at the same nested path in the
     * sandbox; flattening would re-create the bug where every nested artifact
     * collapsed into the root and read_file calls 404'd. The flat-form
     * storage key is composed below once `file_id` is known so we can cap
     * the total length at filesystem NAME_MAX. */
    const safeName = sanitizeArtifactPath(name);
    if (safeName !== name) {
      logger.warn(
        `[processCodeOutput] Filename sanitized: "${name}" -> "${safeName}" | conv=${conversationId}`,
      );
    }

    // Separate captures never share primary storage, even at the same sandbox path.
    const sourceDispatchedAt = freshClaimAfter ?? currentDate.getTime();

    const outputPersistence = createCodeOutputPersistence({
      publication,
      claim: claimCodeFile,
      commit: commitCodeFile,
    });
    const newFileId = v4();
    const claimed = await outputPersistence.claim({
      filename: safeName,
      conversationId,
      file_id: newFileId,
      user: req.user.id,
      tenantId: req.user.tenantId,
      sourceDispatchedAt,
      snapshot: publication == null,
    });
    const file_id = claimed.file_id;
    /** Retain the completed output for token-qualified persistence after storage settles. */
    let pendingOutput: CodeOutputStoredFile | undefined;
    async function commitCodeFile(fileData: CodeOutputStoredFile): Promise<boolean> {
      pendingOutput = structuredClone(fileData);
      return true;
    }

    const writeOutput = async (
      onUploadStart: FileStorageUploadObserver,
    ): Promise<CodeOutputResult | null> => {
      // The sandbox object is a live path, not an owned immutable copy.
      const codeEnvMetadata = {
        codeEnvSource: codeEnvRef,
        codeDestination: true,
        sourceDispatchedAt,
      };
      const outputMetadata = (sha256: string) => ({
        ...codeEnvMetadata,
        codeOutput: { messageId, sha256 },
      });

      if (isImage) {
        const usage = 1;
        onUploadStart();
        const _file = await convertImage(req, buffer, 'high', `${file_id}${fileExt}`);
        const filepath = _file.filepath;
        const storageMetadata = getStorageMetadata({
          filepath: _file.filepath,
          source: appConfig.fileStrategy,
          storageKey: _file.storageKey,
          storageRegion: _file.storageRegion,
        });
        outputPersistence.trackStored({
          ..._file,
          ...storageMetadata,
          file_id,
          filepath: _file.filepath,
          filename: safeName,
          type: `image/${appConfig.imageOutputType}`,
          user: req.user.id,
          tenantId: req.user.tenantId,
          conversationId,
          source: appConfig.fileStrategy,
        });
        const file: CodeOutputStoredFile & Pick<CodeEnvRef, 'executionProfile'> = {
          ..._file,
          filepath,
          ...storageMetadata,
          file_id,
          messageId,
          usage,
          filename: safeName,
          conversationId,
          executionProfile,
          user: req.user.id,
          tenantId: req.user.tenantId,
          type: `image/${appConfig.imageOutputType}`,
          createdAt: formattedDate,
          updatedAt: formattedDate,
          source: appConfig.fileStrategy,
          context: outputPersistence.context,
          metadata: outputMetadata(_file.sha256),
          ...(await retentionExpiryPromise),
        };
        if (!(await outputPersistence.commit(file))) {
          return null;
        }
        return { file: Object.assign(file, { messageId, toolCallId, agentId }) };
      }

      const { saveBuffer } = getStrategyFunctions(appConfig.fileStrategy);
      if (!saveBuffer) {
        logger.warn(
          `[processCodeOutput] saveBuffer not available for strategy ${appConfig.fileStrategy}, falling back to download URL`,
        );
        return {
          file: createDownloadFallback({
            id,
            name,
            agentId,
            messageId,
            toolCallId,
            session_id,
            conversationId,
            executionProfile,
            executionRouteKey,
            expiresAt: currentDate.getTime() + 86400000,
          }),
        };
      }

      const detectedType = await determineFileType(buffer, true);
      const mimeType = detectedType?.mime || inferMimeType(name, '') || 'application/octet-stream';

      /** Check MIME type support - for code-generated files, we're lenient but log unsupported types */
      const isSupportedMimeType = fileConfig.checkType(
        mimeType,
        endpointFileConfig.supportedMimeTypes,
      );
      if (!isSupportedMimeType) {
        logger.warn(
          `[processCodeOutput] File "${name}" has unsupported MIME type "${mimeType}", proceeding with storage but may not be usable as tool resource`,
        );
      }

      /* Compose the storage key here, after `file_id` is known, so the
       * `flattenArtifactPath` cap budget can be calculated against the
       * actual prefix length. The full key has to fit in one filesystem
       * path component (NAME_MAX = 255 on most filesystems); without this
       * cap, deeply-nested artifact paths whose individual segments were
       * within bounds can still produce a flat form that overflows once
       * `${file_id}__` is prepended, causing `ENAMETOOLONG` inside
       * saveBuffer and falling back to a download URL. The 255 figure is
       * the conservative cross-platform NAME_MAX (Linux ext4, NTFS, APFS).
       */
      const NAME_MAX = 255;
      const flatName = flattenArtifactPath(safeName, NAME_MAX - file_id.length - 2);
      const fileName = `${file_id}__${flatName}`;
      onUploadStart();
      const filepath = await saveBuffer({
        userId: req.user.id,
        buffer,
        fileName,
        basePath: 'uploads',
        tenantId: req.user.tenantId,
      });
      const storageMetadata = getStorageMetadata({
        filepath,
        source: appConfig.fileStrategy,
      });
      outputPersistence.trackStored({
        file_id,
        filepath,
        ...storageMetadata,
        filename: safeName,
        type: mimeType,
        bytes: buffer.length,
        user: req.user.id,
        tenantId: req.user.tenantId,
        conversationId,
        source: appConfig.fileStrategy,
      });

      /* `classifyCodeArtifact` and `extractCodeArtifactText` make
       * extension/bare-name decisions on the input string. With the
       * path-preserving sanitizer they can now receive a nested path like
       * `reports.v1/Makefile`, which the classifier's `extensionOf` reads
       * as `v1/Makefile` (the slice after the dot in the directory name)
       * and the bare-name branch rejects because it sees a `.` anywhere in
       * the string. Result: extensionless artifacts under dotted folders
       * (Makefile, Dockerfile, etc.) get misclassified as `other` and
       * skip text extraction. Pass the basename so classification matches
       * what it would have gotten with the old flat-name flow. */
      const leafName = path.basename(safeName);
      const category = classifyCodeArtifact(leafName, mimeType);

      /* Office-bucket files (DOCX/XLSX/XLS/ODS/CSV/PPTX) route through
       * `bufferToOfficeHtml` which is CPU-heavy. Persist the record now
       * with `status: 'pending'` and `text: null` so the agent's response
       * isn't blocked, then return a `finalize` thunk the caller can run
       * in the background. Non-office files have cheap or no extraction
       * — run it inline so the caller gets a fully-resolved record
       * without juggling a finalize step. */
      const expectsPreview = hasOfficeHtmlPath(leafName, mimeType);

      const baseFile: CodeOutputStoredFile = {
        file_id,
        filepath,
        ...storageMetadata,
        messageId,
        object: 'file',
        filename: safeName,
        type: mimeType,
        conversationId,
        user: req.user.id,
        tenantId: req.user.tenantId,
        bytes: buffer.length,
        updatedAt: formattedDate,
        metadata: outputMetadata(createHash('sha256').update(buffer).digest('hex')),
        source: appConfig.fileStrategy,
        context: outputPersistence.context,
        usage: 1,
        createdAt: formattedDate,
        ...(await retentionExpiryPromise),
      };

      if (expectsPreview) {
        /* Persist with `status: 'pending'` and explicit
         * `text: null` / `textFormat: null` so an update that previously
         * had cached text gets cleared. The deferred finalize transitions
         * to 'ready' (with text/textFormat) or 'failed' (with
         * previewError).
         *
         * `previewRevision` is a fresh UUID stamped on every emit. The
         * deferred finalize's `updateFile` is conditional on this — if
         * a newer turn (cross-turn filename reuse) has rotated the
         * revision before this render finishes, the stale render is
         * silently discarded rather than overwriting the newer record.
         * (Codex P1 review on PR #12957.) */
        const previewRevision = v4();
        const file = {
          ...baseFile,
          text: null,
          textFormat: null,
          status: 'pending',
          previewError: null,
          previewRevision,
        } satisfies CodeOutputStoredFile;
        if (!(await outputPersistence.commit(file))) {
          return null;
        }
        return {
          file: Object.assign(file, { messageId, toolCallId, agentId }),
          finalize: outputPersistence.finalize(file, () =>
            finalizePreview({
              buffer,
              leafName,
              mimeType,
              category,
              file_id: file.file_id,
              previewRevision: file.previewRevision,
            }),
          ),
          previewRevision: file.previewRevision,
        };
      }

      /* Non-office path: extraction is cheap (utf8 decode, parseDocument
       * for PDF/ODT, or null for binaries). Run inline and return a
       * fully-resolved record — no `finalize` needed. */
      const text = await extractCodeArtifactText(buffer, leafName, mimeType, category);
      /* `textFormat` accompanies `text` so the client can gate
       * office-HTML-bucket routing on a trusted signal — clients MUST
       * NOT inject `text` into the iframe as HTML unless `textFormat ===
       * 'html'`. RAG-uploaded `.docx` etc. arrive with plain text from
       * mammoth.extractRawText and would otherwise be hijacked by the
       * extension-based office routing into the HTML-injection path
       * (Codex P1 review on PR #12934). null on extract failure — the
       * client treats absence as 'text' for safety. */
      const textFormat = getExtractedTextFormat(leafName, mimeType, text);
      const file: CodeOutputStoredFile = {
        ...baseFile,
        // Always set explicitly so an update which produces a binary or
        // oversized artifact clears any previously cached text — createFile
        // uses findOneAndUpdate with $set semantics.
        text: text ?? null,
        textFormat: textFormat ?? null,
        // Clear deferred-preview lifecycle fields in case the prior emit
        // at this (filename, conversationId) was an office file —
        // otherwise stale `pending`/`failed` would persist and the client
        // would render the wrong state for the now non-office artifact.
        status: null,
        previewError: null,
        previewRevision: null,
      };

      if (!(await outputPersistence.commit(file))) {
        return null;
      }
      return { file: Object.assign(file, { messageId, toolCallId, agentId }) };
    };
    if (publication) return await writeOutput(() => undefined);
    return await withFileProvisioning({
      file: { file_id, user: req.user.id, tenantId: req.user.tenantId },
      userId: req.user.id,
      storage: fileStorage,
      destination: JSON.stringify(['generated-output', sourceDispatchedAt, id]),
      operation: async (_claim, onUploadStart) => {
        const value = await writeOutput(onUploadStart);
        return {
          value,
          commit: pendingOutput
            ? {
                output: {
                  file: pendingOutput,
                  sourceDispatchedAt: freshClaimAfter == null ? undefined : sourceDispatchedAt,
                },
              }
            : { releaseOnly: true },
        };
      },
    });
  } catch (error) {
    if (freshClaimAfter != null && error instanceof FileProvisionPersistenceError) return null;
    if (
      error != null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'CODE_OUTPUT_DOWNLOAD_LIMIT'
    ) {
      logger.warn(
        `[processCodeOutput] Generated file exceeds size limit of ${(fileSizeLimit / megabyte).toFixed(2)} MB, falling back to download URL`,
      );
    }
    if (
      error != null &&
      typeof error === 'object' &&
      'message' in error &&
      error.message === 'Path traversal detected in filename'
    ) {
      logger.warn(
        `[processCodeOutput] Path traversal blocked for file "${name}" | conv=${conversationId}`,
      );
    }
    logAxiosError({
      message: 'Error downloading/processing code environment file',
      error,
    });
    logger.warn(
      `[processCodeOutput] Falling back to Code API download URL for strategy ${appConfig.fileStrategy}`,
    );

    // Fallback for download errors - return download URL so user can still manually download
    return {
      file: createDownloadFallback({
        id,
        name,
        agentId,
        messageId,
        toolCallId,
        session_id,
        conversationId,
        executionProfile,
        executionRouteKey,
        expiresAt: currentDate.getTime() + 86400000,
      }),
    };
  }
}
