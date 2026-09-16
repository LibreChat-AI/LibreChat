import {
  TextPaths,
  FilePaths,
  CodePaths,
  AudioPaths,
  VideoPaths,
  SheetPaths,
} from '@librechat/client';
import {
  Tools,
  megabyte,
  Providers,
  QueryKeys,
  inferMimeType,
  excelMimeTypes,
  EToolResources,
  EModelEndpoint,
  retrievalMimeTypes,
  isEphemeralAgentId,
  isBedrockDocumentType,
  isExplicitMimeConfig,
  codeInterpreterMimeTypes,
  isDocumentSupportedProvider,
  fileConfig as defaultFileConfig,
} from 'librechat-data-provider';
import type {
  TFile,
  TMessage,
  DeleteFilesResponse,
  EndpointFileConfig,
  FileConfig,
  FileSources,
  RegexLike,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { ExtendedFile } from '~/common';

export const partialTypes = ['text/x-'];

/** Text-routed images use the file action so their extracted preview is reachable. */
export function usesImagePreview(file: Partial<Pick<TFile, 'type' | 'llmDeliveryPath'>>): boolean {
  return file.type?.startsWith('image/') === true && file.llmDeliveryPath !== 'text';
}

export type FileDeliveryMetadataMap = Readonly<
  Record<string, Pick<TFile, 'llmDeliveryPath'> | undefined>
>;

/** Restores display-only delivery metadata that an older replica may have
 * omitted from a persisted attachment ref. The persisted ref wins, followed
 * by the matching process-local ref, then the owner-scoped stored file map. */
export function hydrateFileDeliveryMetadata(
  persistedFiles: TMessage['files'],
  localFiles?: TMessage['files'],
  storedFiles?: FileDeliveryMetadataMap,
): TMessage['files'] {
  if (persistedFiles == null || persistedFiles.length === 0) {
    return persistedFiles;
  }
  const localById = new Map(
    (localFiles ?? []).flatMap((file) =>
      file.file_id != null ? [[file.file_id, file] as const] : [],
    ),
  );
  let changed = false;
  const hydrated = persistedFiles.map((file) => {
    const local = file.file_id == null ? undefined : localById.get(file.file_id);
    const stored = file.file_id == null ? undefined : storedFiles?.[file.file_id];
    const llmDeliveryPath = local?.llmDeliveryPath ?? stored?.llmDeliveryPath;
    if (file.llmDeliveryPath != null || llmDeliveryPath == null) {
      return file;
    }
    changed = true;
    return { ...file, llmDeliveryPath };
  });
  return changed ? hydrated : persistedFiles;
}

export function hasIncompleteFiles(files: Map<string, ExtendedFile>): boolean {
  for (const file of files.values()) {
    if (file.progress < 1) {
      return true;
    }
  }
  return false;
}

const textDocument = {
  paths: TextPaths,
  fill: '#FF5588',
  title: 'Document',
};

const spreadsheet = {
  paths: SheetPaths,
  fill: '#10A37F',
  title: 'Spreadsheet',
};

const codeFile = {
  paths: CodePaths,
  fill: '#FF6E3C',
  // TODO: make this dynamic to the language
  title: 'Code',
};

const artifact = {
  paths: CodePaths,
  fill: '#2D305C',
  title: 'Code',
};

const audioFile = {
  paths: AudioPaths,
  fill: '#FF6B35',
  title: 'Audio',
};

const videoFile = {
  paths: VideoPaths,
  fill: '#8B5CF6',
  title: 'Video',
};

export const fileTypes = {
  /* Category matches */
  file: {
    paths: FilePaths,
    fill: '#0000FF',
    title: 'File',
  },
  text: textDocument,
  txt: textDocument,
  audio: audioFile,
  video: videoFile,
  // application:,

  /* Partial matches */
  csv: spreadsheet,
  'application/pdf': textDocument,
  pdf: textDocument,
  'text/x-': codeFile,
  artifact: artifact,

  /* Exact matches */
  // 'application/json':,
  // 'text/html':,
  // 'text/css':,
  // image,
};

// export const getFileType = (type = '') => {
//   let fileType = fileTypes.file;
//   const exactMatch = fileTypes[type];
//   const partialMatch = !exactMatch && partialTypes.find((type) => type.includes(type));
//   const category = (!partialMatch && (type.split('/')[0] ?? 'text') || 'text');

//   if (exactMatch) {
//     fileType = exactMatch;
//   } else if (partialMatch) {
//     fileType = fileTypes[partialMatch];
//   } else if (fileTypes[category]) {
//     fileType = fileTypes[category];
//   }

//   if (!fileType) {
//     fileType = fileTypes.file;
//   }

//   return fileType;
// };

export const getFileType = (
  type = '',
): {
  paths: React.FC;
  fill: string;
  title: string;
} => {
  // Direct match check
  if (fileTypes[type]) {
    return fileTypes[type];
  }

  if (excelMimeTypes.test(type)) {
    return spreadsheet;
  }

  // Partial match check
  const partialMatch = partialTypes.find((partial) => type.includes(partial));
  if (partialMatch && fileTypes[partialMatch]) {
    return fileTypes[partialMatch];
  }

  // Category check
  const category = type.split('/')[0] || 'text';
  if (fileTypes[category]) {
    return fileTypes[category];
  }

  // Default file type
  return fileTypes.file;
};

/**
 * Format a date string to a human readable format
 * @example
 * formatDate('2020-01-01T00:00:00.000Z') // '1 Jan 2020'
 */
export function formatDate(dateString: string, isSmallScreen = false) {
  if (!dateString) {
    return '';
  }

  const date = new Date(dateString);

  if (isSmallScreen) {
    return date.toLocaleDateString('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: '2-digit',
    });
  }

  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];

  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();

  return `${day} ${month} ${year}`;
}

/**
 * Matches every `[QueryKeys.files, 'recent', limit]` cache entry regardless of
 * the requested limit, so any writer that patches the plain `[QueryKeys.files]`
 * list can keep the composer palette's recent-files list in step with it.
 */
export const isRecentFilesQueryKey = (queryKey: readonly unknown[]): boolean =>
  queryKey[0] === QueryKeys.files && queryKey[1] === 'recent';

/**
 * The recent-files query is server-sorted and mounted with refetching off, so a
 * new file only reaches it when something invalidates it explicitly.
 */
export const invalidateRecentFiles = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({
    predicate: (query) => isRecentFilesQueryKey(query.queryKey),
  });
};

/**
 * Adds a file to the query cache
 */
export function addFileToCache(queryClient: QueryClient, newfile: TFile) {
  /* Ahead of the early returns below: the full list may not be cached at all
     while the palette's recent list is, and that list still has to learn about
     the new file. */
  invalidateRecentFiles(queryClient);
  const currentFiles = queryClient.getQueryData<TFile[]>([QueryKeys.files]);

  if (!currentFiles) {
    console.warn('No current files found in cache, skipped updating file query cache');
    return;
  }

  const fileIndex = currentFiles.findIndex((file) => file.file_id === newfile.file_id);

  if (fileIndex > -1) {
    console.warn('File already exists in cache, skipped updating file query cache');
    return;
  }

  queryClient.setQueryData<TFile[]>(
    [QueryKeys.files],
    [
      {
        ...newfile,
      },
      ...currentFiles,
    ],
  );
}

export function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) {
    return 0;
  }
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm));
}

const { checkType } = defaultFileConfig;

type FileSizeValidationParams = {
  fileList: File[];
  files: Map<string, ExtendedFile>;
  setError: (error: string) => void;
  endpointFileConfig: EndpointFileConfig;
};

/** Identity used to detect a file already selected or attached: name, byte size, and MIME group. */
const getFileSignature = (
  name: string | undefined,
  size: number | undefined,
  type: string | undefined,
): string => `${name}-${size}-${type?.split('/')[0] ?? 'file'}`;

/** Normalizes the configured per-file cap: absent, zero, and negative all mean "no limit". */
const getFileSizeLimit = ({ fileSizeLimit }: EndpointFileConfig): number | null =>
  fileSizeLimit != null && fileSizeLimit > 0 ? fileSizeLimit : null;

export const validateFileSizes = ({
  files,
  fileList,
  setError,
  endpointFileConfig,
}: FileSizeValidationParams): boolean => {
  const { totalSizeLimit } = endpointFileConfig;
  const fileSizeLimit = getFileSizeLimit(endpointFileConfig);

  if (fileSizeLimit != null) {
    for (const file of fileList) {
      if (file.size >= fileSizeLimit) {
        setError(`File size limit exceeded: ${fileSizeLimit / megabyte} MB`);
        return false;
      }
    }
  }

  if (totalSizeLimit) {
    const currentTotalSize = Array.from(files.values()).reduce(
      (total, file) => total + file.size,
      0,
    );
    const incomingTotalSize = fileList.reduce((total, file) => total + file.size, 0);
    if (currentTotalSize + incomingTotalSize > totalSizeLimit) {
      setError(`Total file size limit exceeded: ${totalSizeLimit / megabyte} MB`);
      return false;
    }
  }

  return true;
};

export const validateFileLimit = ({
  files,
  fileList,
  setError,
  endpointFileConfig,
}: FileSizeValidationParams): boolean => {
  const { fileLimit } = endpointFileConfig;
  if (fileLimit && fileList.length + files.size > fileLimit) {
    setError(`File limit reached: ${fileLimit} files`);
    return false;
  }
  return true;
};

export type UploadSkipReason = 'duplicate' | 'fileSize';

export type SkippedUpload = {
  /** Position in the `fileList` handed to `partitionUploads`, so callers can map back to their own parallel arrays */
  index: number;
  file: File;
  reason: UploadSkipReason;
};

export type UploadPartition = {
  keptIndices: number[];
  skipped: SkippedUpload[];
};

/**
 * Splits a selection into the files that may be uploaded and the ones that cannot, so a single
 * offender no longer rejects everything picked alongside it. Duplicates are matched against files
 * already attached and against earlier entries in the same selection. Only per-file rules belong
 * here: `totalSizeLimit` is a property of the batch as a whole, so callers still run
 * `validateFileSizes` over whatever survives.
 */
export const partitionUploads = ({
  files,
  fileList,
  endpointFileConfig,
  skipSizeValidation = false,
}: {
  fileList: File[];
  files: Map<string, ExtendedFile>;
  endpointFileConfig: EndpointFileConfig;
  skipSizeValidation?: boolean;
}): UploadPartition => {
  const fileSizeLimit = skipSizeValidation ? null : getFileSizeLimit(endpointFileConfig);
  const keptIndices: number[] = [];
  const skipped: SkippedUpload[] = [];

  const signatures = new Set<string>();
  for (const existingFile of files.values()) {
    signatures.add(
      getFileSignature(
        existingFile.file?.name ?? existingFile.filename,
        existingFile.size,
        existingFile.type,
      ),
    );
  }

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    const signature = getFileSignature(file.name, file.size, file.type);
    if (signatures.has(signature)) {
      skipped.push({ index: i, file, reason: 'duplicate' });
      continue;
    }
    signatures.add(signature);

    if (fileSizeLimit != null && file.size >= fileSizeLimit) {
      skipped.push({ index: i, file, reason: 'fileSize' });
      continue;
    }

    keptIndices.push(i);
  }

  return { keptIndices, skipped };
};

type FileDuplicateValidationParams = {
  fileList: File[];
  files: Map<string, ExtendedFile>;
  setError: (error: string) => void;
};

export const validateFileDuplicates = ({
  files,
  fileList,
  setError,
}: FileDuplicateValidationParams): boolean => {
  const combinedFilesInfo = [
    ...Array.from(files.values()).map((file) =>
      getFileSignature(file.file?.name ?? file.filename, file.size, file.type),
    ),
    ...fileList.map((file: File | undefined) =>
      getFileSignature(file?.name, file?.size, file?.type),
    ),
  ];

  const uniqueFilesSet = new Set(combinedFilesInfo);

  if (uniqueFilesSet.size !== combinedFilesInfo.length) {
    setError('com_error_files_dupe');
    return false;
  }

  return true;
};

export const validateFiles = ({
  files,
  fileList,
  setError,
  endpointFileConfig,
  toolResource,
  fileConfig,
  skipSizeValidation = false,
  skipBatchRules = false,
}: {
  fileList: File[];
  files: Map<string, ExtendedFile>;
  setError: (error: string) => void;
  endpointFileConfig: EndpointFileConfig;
  toolResource?: string;
  fileConfig: FileConfig | null;
  /** Defer size checks to `partitionUploads` once processing has settled each file's final bytes */
  skipSizeValidation?: boolean;
  /** The caller partitions the selection itself, so the rules that would reject the batch as a
   * whole — the file count and duplicates — wait until it has dropped what it can */
  skipBatchRules?: boolean;
}) => {
  const { supportedMimeTypes, disabled } = endpointFileConfig;
  /** Block all uploads if the endpoint is explicitly disabled */
  if (disabled === true) {
    setError('com_ui_attach_error_disabled');
    return false;
  }
  const incomingTotalSize = fileList.reduce((total, file) => total + file.size, 0);
  if (incomingTotalSize === 0) {
    setError('com_error_files_empty');
    return false;
  }

  if (!skipBatchRules && !validateFileLimit({ files, fileList, setError, endpointFileConfig })) {
    return false;
  }

  for (let i = 0; i < fileList.length; i++) {
    let originalFile = fileList[i];
    const fileType = inferMimeType(originalFile.name, originalFile.type);

    // Check if the file type is still empty after the extension check
    if (!fileType) {
      setError('Unable to determine file type for: ' + originalFile.name);
      return false;
    }

    // Replace empty type with inferred type
    if (originalFile.type !== fileType) {
      const newFile = new File([originalFile], originalFile.name, { type: fileType });
      originalFile = newFile;
      fileList[i] = newFile;
    }

    /* Unified mode routes by MIME type but does not widen what may be uploaded: the
     * endpoint allowlist is the same ceiling the server enforces in `filterFile`, so
     * accepting extraction-capable types beyond it only turns a preflight message into
     * a failed request. */
    let mimeTypesToCheck = supportedMimeTypes;
    if (toolResource === EToolResources.context) {
      mimeTypesToCheck = [
        ...(fileConfig?.text?.supportedMimeTypes || []),
        ...(fileConfig?.ocr?.supportedMimeTypes || []),
        ...(fileConfig?.stt?.supportedMimeTypes || []),
      ];
    }

    if (!checkType(originalFile.type, mimeTypesToCheck)) {
      setError(`Unsupported file type: ${originalFile.type}`);
      return false;
    }
  }

  if (
    !skipSizeValidation &&
    !validateFileSizes({ files, fileList, setError, endpointFileConfig })
  ) {
    return false;
  }

  if (skipBatchRules) {
    return true;
  }

  return validateFileDuplicates({ files, fileList, setError });
};

export type UploadOptionContext = {
  provider?: string | null;
  endpoint?: string | null;
  endpointType?: string | null;
  useResponsesApi?: boolean;
  fileSearchEnabled: boolean;
  codeEnabled: boolean;
  contextEnabled: boolean;
  fileSearchAllowedByAgent: boolean;
  codeAllowedByAgent: boolean;
  fileConfig: FileConfig | null;
  endpointSupportedMimeTypes?: RegexLike[];
};

const isProviderAttachType = (type: string, ctx: UploadOptionContext): boolean => {
  let currentProvider = (ctx.provider || ctx.endpoint) ?? '';
  if (currentProvider.toLowerCase() === Providers.OPENROUTER) {
    currentProvider = Providers.OPENROUTER;
  }
  const isAzureWithResponsesApi =
    (currentProvider === EModelEndpoint.azureOpenAI ||
      ctx.endpointType === EModelEndpoint.azureOpenAI) &&
    ctx.useResponsesApi === true;

  if (
    isDocumentSupportedProvider(ctx.endpointType) ||
    isDocumentSupportedProvider(currentProvider) ||
    isAzureWithResponsesApi
  ) {
    /** Custom endpoints with an admin-configured allowlist honor it for direct attach (this is
     * how video/audio get opted in for an OpenAI-compatible gateway), matching the file picker
     * and the server-side encoders; an inherited default config is not treated as opened up. */
    if (
      ctx.endpointType === EModelEndpoint.custom &&
      isExplicitMimeConfig(ctx.endpointSupportedMimeTypes)
    ) {
      return checkType(type, ctx.endpointSupportedMimeTypes);
    }
    if (currentProvider === EModelEndpoint.google || currentProvider === Providers.OPENROUTER) {
      return (
        type.startsWith('image/') ||
        type.startsWith('video/') ||
        type.startsWith('audio/') ||
        type === 'application/pdf'
      );
    }
    if (currentProvider === Providers.BEDROCK || ctx.endpointType === EModelEndpoint.bedrock) {
      return type.startsWith('image/') || isBedrockDocumentType(type);
    }
    return type.startsWith('image/') || type === 'application/pdf';
  }
  return type.startsWith('image/');
};

const isContextType = (type: string, fileConfig: FileConfig | null): boolean =>
  checkType(type, [
    ...(fileConfig?.text?.supportedMimeTypes || []),
    ...(fileConfig?.ocr?.supportedMimeTypes || []),
    ...(fileConfig?.stt?.supportedMimeTypes || []),
  ]);

/**
 * Which tool destinations an upload may be routed to, before the files
 * themselves are considered.
 *
 * A saved agent's tool list is the authority: it can only receive uploads for
 * the tools it was built with. Everywhere else the destination is offered
 * whether or not the tool is currently switched on, because choosing it is what
 * switches it on.
 *
 * Shared by the `+` menu and the drag-and-drop router so a file has the same
 * destinations however it arrives.
 */
export interface UploadToolAllowances {
  fileSearchAllowedByAgent: boolean;
  codeAllowedByAgent: boolean;
}

export const getUploadToolAllowances = (
  agentId: string | null | undefined,
  tools: string[] | undefined,
): UploadToolAllowances => {
  const isSavedAgent = agentId != null && agentId !== '' && !isEphemeralAgentId(agentId);
  return {
    fileSearchAllowedByAgent: !isSavedAgent || (tools?.includes(Tools.file_search) ?? false),
    codeAllowedByAgent: !isSavedAgent || (tools?.includes(Tools.execute_code) ?? false),
  };
};

/**
 * Upload destinations a file set can be routed to, given the active endpoint and agent
 * capabilities. `undefined` is direct provider attachment; the rest are tool resources.
 * Each option requires every file to be valid for it, so the caller can decide between
 * auto-routing (one option), prompting (multiple), or rejecting (none).
 */
/**
 * Whether uploads route from the file itself rather than through the destination chooser.
 * Answering it needs a config the server actually returned: without one the built-in
 * defaults apply, and their absent `legacyFileUploadUX` reads as unified, which is the
 * wrong uploader on a legacy deployment. A failed or paused query is as unresolved as a
 * pending one, so the caller passes whether the fetch succeeded rather than whether it
 * has stopped.
 */
export const isUnifiedUploadMode = (
  endpointFileConfig: EndpointFileConfig | undefined,
  isConfigResolved: boolean,
): boolean => isConfigResolved && endpointFileConfig?.legacyFileUploadUX !== true;

export const getViableUploadOptions = (
  fileList: File[],
  ctx: UploadOptionContext,
): (EToolResources | undefined)[] => {
  if (fileList.length === 0) {
    return [];
  }
  const types = fileList.map((file) => inferMimeType(file.name, file.type));
  if (types.some((type) => !type)) {
    return [];
  }
  const every = (predicate: (type: string) => boolean) =>
    types.every((type) => predicate(type as string));

  const options: (EToolResources | undefined)[] = [];
  if (every((type) => isProviderAttachType(type, ctx))) {
    options.push(undefined);
  }
  if (
    ctx.fileSearchEnabled &&
    ctx.fileSearchAllowedByAgent &&
    every((type) => !type.startsWith('image/') && checkType(type, retrievalMimeTypes))
  ) {
    options.push(EToolResources.file_search);
  }
  if (
    ctx.codeEnabled &&
    ctx.codeAllowedByAgent &&
    every((type) => checkType(type, codeInterpreterMimeTypes))
  ) {
    options.push(EToolResources.execute_code);
  }
  if (ctx.contextEnabled && every((type) => isContextType(type, ctx.fileConfig))) {
    options.push(EToolResources.context);
  }
  return options;
};

/**
 * Character count past which a plain-text paste is attached as a file rather than inserted
 * into the composer. Roughly a screenful of prose, so ordinary pastes are untouched.
 */
export const PASTE_AS_FILE_MIN_LENGTH = 2500;

export const PASTED_TEXT_FILENAME = 'pasted-text.txt';

/** Matches every name `nextPastedTextFilename` can produce, and nothing else: the counter
 * starts at the bare name and jumps to 2, so `-0`, `-1`, and zero-padded variants are never
 * generated and must not read as generated. The alternation is "any integer of 2 or more":
 * a single digit 2-9, or two or more digits. */
const PASTED_TEXT_FILENAME_PATTERN = /^pasted-text(-([2-9]|[1-9]\d+))?\.txt$/;

/**
 * Whether a filename is one `nextPastedTextFilename` can produce. Name alone cannot prove an
 * attachment is a paste, though: a user can deliberately upload a file with one of these names.
 * Provenance comes from the paste registry and the files draft, not the name.
 */
export const isPastedTextFilename = (filename?: string | null): boolean =>
  filename != null && PASTED_TEXT_FILENAME_PATTERN.test(filename);

/** Paste provenance is genuinely per-tab: it decides which chips offer the paste affordances, and
 * `sessionStorage` is exactly that scope, surviving this tab's reloads without reaching another.
 * It has to survive a reload or an already-sent paste would be reclassified as unsent, because the
 * files draft it gets restored from does survive. */
const PASTED_TEXT_STORAGE_KEY = 'librechat-pasted-text-file-ids';

const readStoredPasteIds = (key: string): string[] => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const persistPasteIds = (key: string, ids: Set<string>): void => {
  try {
    if (ids.size === 0) {
      sessionStorage.removeItem(key);
      return;
    }
    sessionStorage.setItem(key, JSON.stringify(Array.from(ids)));
  } catch {
    // The in-memory copy still drives this session.
  }
};

const pastedTextFileIds = new Set<string>(readStoredPasteIds(PASTED_TEXT_STORAGE_KEY));

/** Records that a file id belongs to a paste the composer generated, so its chip can offer the
 * paste affordances. Persisted per tab, so a reload does not strip those affordances off a chip
 * the autosaved draft restores. */
export const markPastedTextFile = (fileId: string): void => {
  pastedTextFileIds.add(fileId);
  persistPasteIds(PASTED_TEXT_STORAGE_KEY, pastedTextFileIds);
};

export const isPastedTextFileMarked = (fileId?: string | null): boolean =>
  fileId != null && pastedTextFileIds.has(fileId);

/** Submitted-use evidence, unlike paste provenance, has to be readable by every tab and outlive
 * any of them, so it lives in `localStorage` rather than this tab's session.
 *
 * The tab that deletes is rarely the tab that sent. A retained deletion is retried by whichever
 * tab is holding it, possibly long after being frozen and resumed, while the message referencing
 * the file was sent somewhere else entirely. Published tab presence used to be the only cross-tab
 * evidence and it ages out on a ten-minute window, so a retry resuming after that classified a
 * sent file as abandoned and deleted it out of its message.
 *
 * Deliberately not expired on a timer. The work this evidence has to outlast is a retained
 * deletion, and those carry no expiry of their own: any interval chosen here can be outlived by a
 * suspended tab still holding cleanup work, which is the same bug again with a longer fuse. The
 * ledger is bounded by count instead, evicting the oldest entries only when it would otherwise
 * grow without limit, since running out of origin quota would break draft writes for everyone. */
const SUBMITTED_PASTES_STORAGE_KEY = 'librechat-submitted-paste-file-ids';
const SUBMITTED_PASTE_LIMIT = 5000;

type SubmittedPastes = Record<string, number>;

let submittedPastesCache: { raw: string | null; ids: SubmittedPastes } | null = null;

/** Read through a raw-string cache: another tab's write changes the string, so this stays current
 * without re-parsing on every lookup, and lookups happen per file per cleanup pass. */
const readSubmittedPastes = (): SubmittedPastes => {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(SUBMITTED_PASTES_STORAGE_KEY);
  } catch {
    return submittedPastesCache?.ids ?? {};
  }
  if (submittedPastesCache != null && submittedPastesCache.raw === raw) {
    return submittedPastesCache.ids;
  }
  const ids: SubmittedPastes = {};
  try {
    const parsed = JSON.parse(raw ?? 'null') as unknown;
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, seenAt] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof seenAt === 'number') {
          ids[id] = seenAt;
        }
      }
    }
  } catch {
    // An unreadable record protects nothing, which is the same as having none.
  }
  submittedPastesCache = { raw, ids };
  return ids;
};

/** Records that a paste left the composer on a message. Submitting empties the file map but the
 * draft keeps its provenance, and the run ending (including by Stop or an error) is not evidence
 * the paste is unsent: only this is. Without it, discarding afterwards would delete a file the
 * sent turn already references. */
export const markPasteSubmitted = (fileId?: string | null): void => {
  if (fileId == null || fileId === '') {
    return;
  }
  const ids: SubmittedPastes = { ...readSubmittedPastes(), [fileId]: Date.now() };
  let entries = Object.entries(ids);
  if (entries.length > SUBMITTED_PASTE_LIMIT) {
    entries = entries.sort((a, b) => b[1] - a[1]).slice(0, SUBMITTED_PASTE_LIMIT);
  }
  const bounded = Object.fromEntries(entries);
  try {
    localStorage.setItem(SUBMITTED_PASTES_STORAGE_KEY, JSON.stringify(bounded));
    submittedPastesCache = null;
  } catch {
    /** The write is the protection, so a failure has to be remembered in memory at least: this
     * tab's own cleanup must not turn around and delete what it just sent. */
    submittedPastesCache = { raw: submittedPastesCache?.raw ?? null, ids: bounded };
  }
};

export const isPasteSubmitted = (fileId?: string | null): boolean =>
  fileId != null && fileId !== '' && readSubmittedPastes()[fileId] != null;

/** A file deletion whose request failed, kept with everything needed to retry it: the chip it
 * came from is already gone, so the payload cannot be rebuilt from the composer. */
export type PendingFileDeletion = {
  file_id: string;
  embedded: boolean;
  filepath: string;
  source: FileSources;
};

/** A resolved delete request is not proof the records are gone: the route answers 200 with
 * `failedFileIds` when a storage delete fails, so every caller that cleans up after itself has to
 * read the result rather than only catching a rejection. */
export const failedFileIdsFrom = (result: DeleteFilesResponse | void): string[] =>
  result != null && Array.isArray(result.failedFileIds) ? result.failedFileIds : [];

const RETAINED_DELETION_STORAGE_KEY = 'librechat-retained-file-deletions';
const RETAINED_RETRY_BASE_DELAY_MS = 5_000;
const RETAINED_RETRY_MAX_DELAY_MS = 60_000;

const readStoredRetainedDeletions = (): PendingFileDeletion[] => {
  try {
    const raw = sessionStorage.getItem(RETAINED_DELETION_STORAGE_KEY);
    if (raw == null || raw === '') {
      return [];
    }
    const parsed = JSON.parse(raw) as PendingFileDeletion[] | null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** Survives a reload: the chip these came from is gone, so once the tab forgets the payload the
 * upload on the server has no reference left at all. */
const retainedFileDeletions = new Map<string, PendingFileDeletion>(
  readStoredRetainedDeletions().map((record) => [record.file_id, record]),
);
const retainedFileDeletionListeners = new Set<() => void>();

const persistRetainedFileDeletions = (): void => {
  try {
    if (retainedFileDeletions.size === 0) {
      sessionStorage.removeItem(RETAINED_DELETION_STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(
      RETAINED_DELETION_STORAGE_KEY,
      JSON.stringify(Array.from(retainedFileDeletions.values())),
    );
  } catch {
    // The in-memory copy still drives this session's retries.
  }
};

const notifyRetainedFileDeletions = (): void => {
  retainedFileDeletionListeners.forEach((listener) => listener());
};

let retainedRetryTimer: ReturnType<typeof setTimeout> | null = null;
let retainedRetryDelayMs = RETAINED_RETRY_BASE_DELAY_MS;
let onlineRetryBound = false;

const bindOnlineRetainedRetry = (): void => {
  if (onlineRetryBound || typeof window === 'undefined') {
    return;
  }
  onlineRetryBound = true;
  window.addEventListener('online', () => {
    retainedRetryDelayMs = RETAINED_RETRY_BASE_DELAY_MS;
    notifyRetainedFileDeletions();
  });
};

/** A retry that fails again changes nothing the cleanup effect depends on, and the files query
 * does not refetch on reconnect, so without an explicit wake-up the payload would sit untouched
 * until some unrelated cache update happened to arrive. Backs off to a slow poll rather than
 * giving up, because giving up is what orphans the upload. */
export const scheduleRetainedFileDeletionRetry = (): void => {
  if (retainedRetryTimer != null) {
    return;
  }
  bindOnlineRetainedRetry();
  retainedRetryTimer = setTimeout(() => {
    retainedRetryTimer = null;
    retainedRetryDelayMs = Math.min(retainedRetryDelayMs * 2, RETAINED_RETRY_MAX_DELAY_MS);
    notifyRetainedFileDeletions();
  }, retainedRetryDelayMs);
};

let retainedPassInFlight = false;

/** The header, sidebar, mobile bar and shortcut hooks each mount the cleanup effect, and the
 * store they read is shared, so without a claim every one of them would issue the same DELETE and
 * toast about it. Only the instance that takes this runs the pass. */
export const beginRetainedDeletionPass = (): boolean => {
  if (retainedPassInFlight) {
    return false;
  }
  retainedPassInFlight = true;
  return true;
};

export const endRetainedDeletionPass = (): void => {
  retainedPassInFlight = false;
};

/** Whether this session may still record deletions. A DELETE that was already in flight when the
 * session ended settles after the queue was dropped, and its handler is the last reference to
 * that payload, so it writes the previous account's records straight back in. The latch is what
 * makes the clear stick: retention reopens only when a session is established again. */
let retentionOpen = true;

/** Drops the queue outright and refuses further records until the next sign-in. The payloads
 * belong to the account that uploaded them, so carrying them across a sign-out would retry
 * another user's credentials against files they do not own, failing the ownership check forever
 * instead of cleaning anything up. */
export const clearRetainedFileDeletions = (): void => {
  retentionOpen = false;
  retainedFileDeletions.clear();
  persistRetainedFileDeletions();
  retainedRetryDelayMs = RETAINED_RETRY_BASE_DELAY_MS;
  if (retainedRetryTimer != null) {
    clearTimeout(retainedRetryTimer);
    retainedRetryTimer = null;
  }
};

/** Reopens retention for a newly established session. Records already in the store are this
 * account's own, carried across a reload by `sessionStorage`, so the queue is left alone. */
export const openFileDeletionRetention = (): void => {
  retentionOpen = true;
};

export const retainFileDeletion = (record: PendingFileDeletion): void => {
  if (!retentionOpen) {
    return;
  }
  retainedFileDeletions.set(record.file_id, record);
  persistRetainedFileDeletions();
  retainedRetryDelayMs = RETAINED_RETRY_BASE_DELAY_MS;
  notifyRetainedFileDeletions();
};

export const clearRetainedFileDeletion = (fileId: string): void => {
  if (!retainedFileDeletions.delete(fileId)) {
    return;
  }
  persistRetainedFileDeletions();
  retainedRetryDelayMs = RETAINED_RETRY_BASE_DELAY_MS;
};

/** The deletions waiting for a retry; ownership stays with the store until one succeeds. */
export const takeRetainedFileDeletions = (): PendingFileDeletion[] =>
  Array.from(retainedFileDeletions.values());

/** Subscribe to a retained deletion being recorded so a retry effect can run without waiting
 * for an unrelated files-cache update. */
export const subscribeRetainedFileDeletions = (listener: () => void): (() => void) => {
  retainedFileDeletionListeners.add(listener);
  return () => {
    retainedFileDeletionListeners.delete(listener);
  };
};

const PENDING_DISCARD_STORAGE_KEY = 'librechat-pending-file-discards';

type PendingDiscardStore = Record<string, string[]>;

const readPendingDiscardStore = (): PendingDiscardStore => {
  try {
    const raw = sessionStorage.getItem(PENDING_DISCARD_STORAGE_KEY);
    if (raw == null || raw === '') {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as PendingDiscardStore)
      : {};
  } catch {
    return {};
  }
};

/** Draft uploads whose records were not yet resolvable when New Chat discarded them. Stored
 * per composer index so a reload or remount can still delete them once the files cache
 * exposes the record. */
export const loadPendingDiscardIds = (index = 0): string[] => {
  const stored = readPendingDiscardStore()[String(index)];
  return Array.isArray(stored) ? stored.filter((id) => typeof id === 'string') : [];
};

const pendingDiscardListeners = new Set<() => void>();

/** Several hooks mount this state against one session store, and an instance that unmounts takes
 * its snapshot with it. Without a notification the remaining ones keep stale lists and the work
 * it deferred is never picked up again. */
export const subscribePendingDiscardIds = (listener: () => void): (() => void) => {
  pendingDiscardListeners.add(listener);
  return () => {
    pendingDiscardListeners.delete(listener);
  };
};

export const storePendingDiscardIds = (index: number, ids: string[]): void => {
  try {
    const store = readPendingDiscardStore();
    if (ids.length === 0) {
      delete store[String(index)];
    } else {
      store[String(index)] = ids;
    }
    if (Object.keys(store).length === 0) {
      sessionStorage.removeItem(PENDING_DISCARD_STORAGE_KEY);
      pendingDiscardListeners.forEach((listener) => listener());
      return;
    }
    sessionStorage.setItem(PENDING_DISCARD_STORAGE_KEY, JSON.stringify(store));
    pendingDiscardListeners.forEach((listener) => listener());
  } catch {
    // Privacy-blocked storage cannot persist deferred discards across reloads.
  }
};

export type PasteAsFileContext = {
  /** The user's `pasteLongTextAsFile` preference. */
  enabled: boolean;
  uploadsDisabled: boolean;
  isAssistants: boolean;
  /** Names already attached to the composer, used to keep successive pastes distinct. */
  attachedFilenames: Set<string>;
  /** The file config the destination check reads has not arrived yet. */
  configPending: boolean;
  getOptions: (files: File[]) => (EToolResources | undefined)[];
};

/**
 * Uploads are deduped on name + size + type, so a fixed name would collapse that key to size
 * alone for pastes and reject a second, different paste that merely matched the first one's
 * length. Numbering keeps every paste attachable while staying readable in the UI.
 */
export const nextPastedTextFilename = (taken: Set<string>): string => {
  let candidate = PASTED_TEXT_FILENAME;
  let suffix = 1;
  while (taken.has(candidate)) {
    suffix += 1;
    candidate = `pasted-text-${suffix}.txt`;
  }
  return candidate;
};

export type PastedTextAttachment = {
  file: File;
  /** Context for non-assistant attachments; assistants resolve their destination on upload. */
  toolResource?: EToolResources;
};

/**
 * Turns a long plain-text paste into a text attachment, keeping the composer readable while
 * preserving the exact paste in the generated file. Context attachments follow the same
 * configured token limits as other uploaded text files. Returns `null` whenever the paste
 * should stay inline, so the caller can leave the browser's native paste untouched.
 */
export const resolvePastedTextFile = (
  text: string,
  ctx: PasteAsFileContext,
): PastedTextAttachment | null => {
  if (!ctx.enabled || ctx.uploadsDisabled || text.length <= PASTE_AS_FILE_MIN_LENGTH) {
    return null;
  }

  const name = nextPastedTextFilename(ctx.attachedFilenames);
  const file = new File([text], name, { type: 'text/plain' });
  if (ctx.isAssistants) {
    return { file };
  }

  /** `context` is the only automatic non-assistant destination because retrieval-based routes
   * can change what the model sees. Pasting text must never pop a destination picker.
   *
   * That check reads MIME lists that arrive with the file config, so declining while the config
   * is still in flight would quietly ignore the setting on a slow first load. Routing the paste
   * instead hands the decision to the upload, which waits for the same config and restores the
   * text inline if it turns out the destination is unavailable. */
  if (!ctx.configPending && !ctx.getOptions([file]).includes(EToolResources.context)) {
    return null;
  }

  return { file, toolResource: EToolResources.context };
};

export function sortPagesByRelevance(
  pages: number[],
  pageRelevance: Record<number, number>,
): number[] {
  if (!pageRelevance || Object.keys(pageRelevance).length === 0) {
    return pages;
  }
  return [...pages].sort((a, b) => (pageRelevance[b] || 0) - (pageRelevance[a] || 0));
}

/**
 * Collapses whitespace runs to underscores so export filenames come out
 * identical across all export formats: `export-from-json`'s default formatter
 * only replaces the first whitespace run, while direct downloads replace none.
 */
export function normalizeExportFilename(filename: string): string {
  return filename.replace(/\s+/g, '_');
}
