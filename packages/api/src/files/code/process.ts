import path from 'path';
import { v4 } from 'uuid';
import {
  megabyte,
  fileConfig,
  imageExtRegex,
  inferMimeType,
  mergeCodeEnvRef,
} from 'librechat-data-provider';
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
import type { sanitizeArtifactPath, flattenArtifactPath } from '~/utils/files';
import type { classifyCodeArtifact, CodeArtifactCategory } from './classify';
import type { hasOfficeHtmlPath, getExtractedTextFormat } from './extract';
import type { RetentionExpiry } from '~/files/retention';
import type { extractCodeArtifactText } from './extract';
import type { logAxiosError } from '~/utils/axios';
import type { ServerRequest } from '~/types';
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
    >
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
    commitCodeFile: commitOutput,
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

    /**
     * Ordinary outputs atomically reuse a file_id for this filename and conversation.
     * Explicit publications instead receive a fresh attempt ID from the gateway.
     *
     * Claim by `safeName` (not raw `name`) so the claim and the eventual
     * `createFile` agree on the filename column — otherwise weird inputs
     * (e.g. `"proj name/file@v1.txt"`) would claim under the raw name and
     * then write under the sanitized one, leaving the claim row orphaned.
     */
    /**
     * Dispatch-order stamp persisted with every write AND every claim insert
     * (foreground writes dispatch ≈ now): the out-of-order guard below
     * compares WRITER dispatch order, not wall-clock write time — an older
     * task writing late must not make a newer task's harvest look stale, and
     * a freshly claimed row must carry its claimant's stamp before the
     * content write lands.
     */
    const sourceDispatchedAt = freshClaimAfter ?? Date.now();

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
    });
    const file_id = claimed.file_id;
    const isUpdate = file_id !== newFileId;

    /**
     * Out-of-order guard for detached (background) harvests: when the claimed
     * row's last writer was dispatched AFTER this task (`freshClaimAfter` =
     * this task's dispatch time), a newer run owns this filename slot. The
     * `(filename, conversationId)` unique index means the stale bytes have
     * nowhere else to live, so skip this file rather than overwrite fresh
     * content — the harvest's stdout patch still lands, only the superseded
     * attachment is omitted. Falls back to `updatedAt` for rows written
     * before the stamp existed (the claim itself is timestamp-neutral).
     */
    const lastWriterDispatchedAt =
      claimed.metadata?.sourceDispatchedAt ??
      (claimed.updatedAt != null ? new Date(claimed.updatedAt).getTime() : null);
    if (isUpdate && freshClaimAfter != null && (lastWriterDispatchedAt ?? 0) > freshClaimAfter) {
      logger.warn(
        `[processCodeOutput] Skipping stale background output "${safeName}" (${file_id}): a newer run owns this filename`,
      );
      return null;
    }

    if (isUpdate) {
      logger.debug(
        `[processCodeOutput] Updating existing file "${safeName}" (${file_id}) instead of creating duplicate`,
      );
    }

    /**
     * The data-schema method checks background dispatch ownership atomically with
     * the write. A superseded commit misses and its attachment is skipped.
     * Bytes already uploaded to a reused storage key retain the existing race;
     * a per-file lock would be needed to cover that storage write as well.
     * Foreground outputs retain their unconditional commit behavior.
     */
    async function commitCodeFile(fileData: CodeOutputStoredFile): Promise<boolean> {
      const committed = await commitOutput(
        fileData,
        freshClaimAfter == null ? undefined : sourceDispatchedAt,
      );
      if (!committed) {
        logger.warn(
          `[processCodeOutput] Skipping stale background output "${safeName}" (${file_id}): a newer run owns this filename`,
        );
      }
      return committed;
    }

    /**
     * Preserve the original `messageId` on update. Each `processCodeOutput`
     * call would otherwise overwrite it with the current run's run id, which
     * decouples the file from the assistant message that originally created
     * it. `getCodeGeneratedFiles` filters by `messageId IN <thread>`, so a
     * stale id (e.g. from a later regeneration / failed re-read attempt)
     * silently excludes the file from priming on subsequent turns.
     */
    const persistedMessageId = isUpdate ? (claimed.messageId ?? messageId) : messageId;
    /* A generated-output write replaces the file's bytes, so pointers to
     * earlier content in another profile must not survive as reusable refs. */
    const codeEnvReferenceSet = mergeCodeEnvRef(undefined, codeEnvRef);
    const codeEnvMetadata = {
      ...claimed.metadata,
      ...codeEnvReferenceSet,
      sourceDispatchedAt,
    };

    if (isImage) {
      const usage = isUpdate ? (claimed.usage ?? 0) + 1 : 1;
      const _file = await convertImage(req, buffer, 'high', `${file_id}${fileExt}`);
      const filepath = usage > 1 ? `${_file.filepath}?v=${Date.now()}` : _file.filepath;
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
        messageId: persistedMessageId,
        usage,
        filename: safeName,
        conversationId,
        executionProfile,
        user: req.user.id,
        tenantId: req.user.tenantId,
        type: `image/${appConfig.imageOutputType}`,
        createdAt: isUpdate ? claimed.createdAt : formattedDate,
        updatedAt: formattedDate,
        source: appConfig.fileStrategy,
        context: outputPersistence.context,
        metadata: codeEnvMetadata,
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
      messageId: persistedMessageId,
      object: 'file',
      filename: safeName,
      type: mimeType,
      conversationId,
      user: req.user.id,
      tenantId: req.user.tenantId,
      bytes: buffer.length,
      updatedAt: formattedDate,
      metadata: codeEnvMetadata,
      source: appConfig.fileStrategy,
      context: outputPersistence.context,
      usage: isUpdate ? (claimed.usage ?? 0) + 1 : 1,
      createdAt: isUpdate ? claimed.createdAt : formattedDate,
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
  } catch (error) {
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
