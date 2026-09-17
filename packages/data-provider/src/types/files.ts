import type { TDefaultLLMDeliveryPathConfig } from '../file-config';
import type { CodeEnvRef, CodeEnvRefMap } from '../codeEnvRef';
import { EToolResources } from './tools';

export enum FileSources {
  local = 'local',
  firebase = 'firebase',
  azure = 'azure',
  azure_blob = 'azure_blob',
  openai = 'openai',
  s3 = 's3',
  cloudfront = 'cloudfront',
  vectordb = 'vectordb',
  execute_code = 'execute_code',
  mistral_ocr = 'mistral_ocr',
  azure_mistral_ocr = 'azure_mistral_ocr',
  vertexai_mistral_ocr = 'vertexai_mistral_ocr',
  text = 'text',
  document_parser = 'document_parser',
}

/**
 * Which local engine produced a parsed record's text, recorded as provenance.
 *
 * Deliberately not `FileSources` members: no strategy resolves them, nothing streams
 * from them, and a caller that asked for one would receive a storage adapter that
 * cannot answer. Keeping them here means an engine can be swapped without touching the
 * enum every stored record is validated against.
 */
export enum DocumentParser {
  document_parser = 'document_parser',
  pdf_inspector = 'pdf_inspector',
  anydoc = 'anydoc',
}

/**
 * Local document parsers, whose extraction results keep the uploaded file's MIME
 * type. Remote OCR results must not: its supported types include images, and an
 * OCR'd image stored as `image/png` with a provider marker for a filepath renders
 * as a broken thumbnail.
 */
export const documentParserSources: ReadonlySet<string> = new Set<string>(
  Object.values(DocumentParser),
);

export const checkOpenAIStorage = (source: string) =>
  source === FileSources.openai || source === FileSources.azure;

export enum FileContext {
  avatar = 'avatar',
  unknown = 'unknown',
  agents = 'agents',
  assistants = 'assistants',
  execute_code = 'execute_code',
  image_generation = 'image_generation',
  assistants_output = 'assistants_output',
  message_attachment = 'message_attachment',
  run_artifact = 'run_artifact',
  skill_file = 'skill_file',
  filename = 'filename',
  updatedAt = 'updatedAt',
  source = 'source',
  filterSource = 'filterSource',
  context = 'context',
  bytes = 'bytes',
}

/** Structural type for a compiled matcher: a native `RegExp` or a linear-time engine both satisfy it. Only `test` is ever called on `supportedMimeTypes`. */
export type RegexLike = { test(input: string): boolean };

export type EndpointFileConfig = {
  disabled?: boolean;
  fileLimit?: number;
  fileSizeLimit?: number;
  totalSizeLimit?: number;
  supportedMimeTypes?: RegexLike[];
  defaultLLMDeliveryPath?: TDefaultLLMDeliveryPathConfig;
  legacyFileUploadUX?: boolean;
  /** Delivers the text extracted at upload for a file routed to tools (`none`) on a turn that
   *  runs no tool able to read it. Off by default, which leaves such a file out of the prompt. */
  textFallbackWithoutTools?: boolean;
};

export type FileConfig = {
  endpoints: {
    [key: string]: EndpointFileConfig;
  };
  skills?: {
    /** Maximum concurrent blob deletions during failed archive import cleanup. */
    importCleanupConcurrency?: number;
    fileSizeLimit?: number;
  };
  fileTokenLimit?: number;
  /** Maximum aggregate model-bound attachment bytes admitted into one agent turn. */
  fileContextSizeLimit?: number;
  /** Maximum aggregate extracted-text characters admitted into one agent turn. */
  fileContextCharLimit?: number;
  serverFileSizeLimit?: number;
  avatarSizeLimit?: number;
  clientImageResize?: {
    enabled?: boolean;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
    /** Set when `enabled` came from the admin config, in which case it wins over the user's setting */
    enforced?: boolean;
  };
  ocr?: {
    supportedMimeTypes?: RegexLike[];
    /** Server-derived signal that an OCR strategy is configured. */
    enabled?: boolean;
  };
  documentParser?: {
    supportedMimeTypes?: RegexLike[];
    /** Largest document the built-in parser accepts, in bytes. */
    fileSizeLimit?: number;
    /** Deadline for one extraction child, in milliseconds. */
    timeoutMs?: number;
    /** Compared directly with a PDF's page count, so it is not converted to bytes. */
    maxPageCount?: number;
    /** Maximum decompressed bytes allowed for one ZIP entry. */
    archiveEntrySizeLimit?: number;
    /** Maximum decompressed bytes allowed across one ZIP archive. */
    archiveTotalSizeLimit?: number;
    /** Maximum entries one ZIP archive may hold. */
    archiveEntryCountLimit?: number;
    /** Maximum whole-document parses allowed to run concurrently. */
    maxConcurrentParsers?: number;
    /** Maximum whole-document parses allowed to wait for a slot. */
    maxQueuedParsers?: number;
    /** Deadline for the optional PDF scan classifier, in milliseconds. */
    classifierTimeoutMs?: number;
    /** Maximum PDF pages the in-process recovery walk reads. */
    maxRecoveredPageCount?: number;
  };
  text?: {
    supportedMimeTypes?: RegexLike[];
    /** Server-derived signal that a RAG text service is configured. */
    enabled?: boolean;
  };
  stt?: {
    supportedMimeTypes?: RegexLike[];
  };
  checkType?: (fileType: string, supportedTypes: RegexLike[]) => boolean;
  defaultLLMDeliveryPath?: TDefaultLLMDeliveryPathConfig;
  legacyFileUploadUX?: boolean;
  /** Delivers the text extracted at upload for a file routed to tools (`none`) on a turn that
   *  runs no tool able to read it. Off by default, which leaves such a file out of the prompt. */
  textFallbackWithoutTools?: boolean;
};

export type FileConfigInput = {
  endpoints?: {
    [key: string]: EndpointFileConfig;
  };
  skills?: {
    /** Maximum concurrent blob deletions during failed archive import cleanup. */
    importCleanupConcurrency?: number;
    fileSizeLimit?: number;
  };
  serverFileSizeLimit?: number;
  avatarSizeLimit?: number;
  fileContextSizeLimit?: number;
  fileContextCharLimit?: number;
  clientImageResize?: {
    enabled?: boolean;
    maxWidth?: number;
    maxHeight?: number;
    quality?: number;
  };
  ocr?: {
    supportedMimeTypes?: string[];
    enabled?: boolean;
  };
  documentParser?: {
    supportedMimeTypes?: string[];
    /** Megabytes, converted on merge like every other size limit here. */
    fileSizeLimit?: number;
    /** Milliseconds, passed through unchanged by mergeFileConfig. */
    timeoutMs?: number;
    /** Maximum whole-document parses allowed to run concurrently. */
    maxConcurrentParsers?: number;
    /** Maximum whole-document parses allowed to wait for a slot. */
    maxQueuedParsers?: number;
    /** Milliseconds, passed through unchanged by mergeFileConfig. */
    classifierTimeoutMs?: number;
    /** Operators enter a page count here; mergeFileConfig preserves it without conversion. */
    maxPageCount?: number;
    /** Megabytes, converted to bytes in the merged configuration. */
    archiveEntrySizeLimit?: number;
    /** Megabytes, converted to bytes in the merged configuration. */
    archiveTotalSizeLimit?: number;
    /** Entry and page counts stay counts: mergeFileConfig passes them through. */
    archiveEntryCountLimit?: number;
    maxRecoveredPageCount?: number;
  };
  text?: {
    supportedMimeTypes?: string[];
    enabled?: boolean;
  };
  stt?: {
    supportedMimeTypes?: string[];
  };
  checkType?: (fileType: string, supportedTypes: RegexLike[]) => boolean;
  defaultLLMDeliveryPath?: TDefaultLLMDeliveryPathConfig;
  legacyFileUploadUX?: boolean;
  /** Delivers the text extracted at upload for a file routed to tools (`none`) on a turn that
   *  runs no tool able to read it. Off by default, which leaves such a file out of the prompt. */
  textFallbackWithoutTools?: boolean;
};

/** The immutable origin of a file explicitly published from an agent execution. */
export type RunFileProvenance = {
  runId: string;
  executionId: string;
  agentId: string;
  parentExecutionId?: string;
  parentAgentId?: string;
  recipientAgentIds?: string[];
  sourceFileId: string;
  publishedAt: string;
  inputFileIds: string[];
};

export type TFile = {
  _id?: string;
  __v?: number;
  user: string;
  tenantId?: string;
  storageRegion?: string;
  storageKey?: string;
  conversationId?: string;
  message?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  embedded: boolean;
  filename: string;
  filepath: string;
  object: 'file';
  type: string;
  usage: number;
  context?: FileContext;
  source?: FileSources;
  filterSource?: FileSources;
  width?: number;
  height?: number;
  expiresAt?: string | Date;
  expiredAt?: string | Date | null;
  preview?: string;
  /** Share-safe marker for a parsed document whose durable preview is extracted text. */
  hasTextPreview?: boolean;
  text?: string;
  /**
   * Format of the `text` field. `'html'` means the backend produced
   * a sanitized full-document HTML preview the client may inject as
   * `index.html` inside the office artifact iframe. `'text'` (or
   * `undefined` for legacy records) is plain text and MUST NOT be
   * injected as HTML — render through the markdown/escaping path.
   * See Codex P1 review on PR #12934.
   */
  textFormat?: 'html' | 'text' | null;
  /**
   * Lifecycle of the inline preview rendered from `text`. `'pending'`
   * while background HTML extraction is in flight (deferred-preview
   * code-execution flow), `'ready'` once `text`/`textFormat` are set,
   * `'failed'` if extraction errored or hit the 60s ceiling. `undefined`
   * for legacy records and for files that never expect a preview —
   * clients MUST treat that as `'ready'`.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Short machine-readable failure reason when `status === 'failed'`.
   * Suitable for tooltip text but not user-facing prose.
   */
  previewError?: string;
  metadata?: {
    runFile?: RunFileProvenance;
    fileIdentifier?: string;
    /**
     * Structured form of `fileIdentifier`. Persisted alongside the
     * legacy string during the dual-write transition; readers should
     * resolve via `resolveCodeEnvRef`.
     */
    codeEnvRef?: CodeEnvRef;
    codeEnvRefs?: CodeEnvRefMap;
    /** Dispatch-order stamp for the current source artifact generation. */
    sourceDispatchedAt?: number;
    /** Vector namespaces this file has been embedded into. */
    embeddedEntities?: string[];
    /** The user named this destination, so absent ones were declined. */
    destinationChosen?: boolean;
    /** The type the delivery route was resolved against, when conversion changed it. */
    routingMimeType?: string;
  };
  llmDeliveryPath?: 'provider' | 'text' | 'none';
  createdAt?: string | Date;
  updatedAt?: string | Date;
};

export type TFileUpload = TFile & {
  temp_file_id: string;
};

/**
 * Shape returned by `GET /api/files/:file_id/preview`. The deferred-
 * preview code-execution flow polls this until status is terminal:
 *   - `pending`: HTML extraction is still running. No `text`.
 *   - `ready`: extraction succeeded; `text` + `textFormat` populated
 *     iff the file produced inline preview content (binary/oversized
 *     files reach `ready` with no text — render download-only).
 *   - `failed`: extraction errored or hit the 60s ceiling;
 *     `previewError` carries the short reason (`timeout`,
 *     `parser-error`, `orphaned`, etc.).
 *
 * Legacy records pre-dating the field are surfaced as `'ready'` server-
 * side so existing attachments keep rendering normally.
 */
export type TFilePreview = {
  file_id: string;
  status: 'pending' | 'ready' | 'failed';
  text?: string;
  textFormat?: 'html' | 'text' | null;
  previewError?: string;
};

export type AvatarUploadResponse = {
  url: string;
};

export type FileDownloadURLResponse = {
  url: string;
  filename: string;
  type: string;
  metadata: Partial<TFile>;
};

export type SpeechToTextResponse = {
  text: string;
};

export type VoiceResponse = string[];

export type UploadMutationOptions = {
  onSuccess?: (data: TFileUpload, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type UploadAvatarOptions = {
  onSuccess?: (data: AvatarUploadResponse, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type SpeechToTextOptions = {
  onSuccess?: (data: SpeechToTextResponse, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type TextToSpeechOptions = {
  onSuccess?: (data: ArrayBuffer, variables: FormData, context?: unknown) => void;
  onMutate?: (variables: FormData) => void | Promise<unknown>;
  onError?: (error: unknown, variables: FormData, context?: unknown) => void;
};

export type VoiceOptions = {
  onSuccess?: (data: VoiceResponse, variables: unknown, context?: unknown) => void;
  onMutate?: () => void | Promise<unknown>;
  onError?: (error: unknown, variables: unknown, context?: unknown) => void;
};

export type TFilesUsageBody = {
  file_ids: string[];
};

export type TFilesUsageResponse = {
  /** Count of queued uploads whose TTL hold was extended. */
  held: number;
};

export type DeleteFilesResponse = {
  message: string;
  result?: Record<string, unknown>;
  deletedFileIds?: string[];
  failedFileIds?: string[];
};

export type BatchFile = {
  file_id: string;
  filepath: string;
  storageRegion?: string;
  storageKey?: string;
  embedded: boolean;
  source: FileSources;
  temp_file_id?: string;
};

export type DeleteFilesBody = {
  files: BatchFile[];
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: EToolResources;
};

export type DeleteMutationOptions = {
  onSuccess?: (data: DeleteFilesResponse, variables: DeleteFilesBody, context?: unknown) => void;
  onMutate?: (variables: DeleteFilesBody) => void | Promise<unknown>;
  onError?: (error: unknown, variables: DeleteFilesBody, context?: unknown) => void;
  /** Suppresses the result toasts. Background cleanup runs on a timer the user never asked for,
   * and a storage failure that keeps failing would otherwise announce itself on every retry. */
  silent?: boolean;
};
