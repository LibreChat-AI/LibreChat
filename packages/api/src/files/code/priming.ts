import { once } from 'node:events';
import { Readable } from 'node:stream';
import {
  Tools,
  FileContext,
  getCodeEnvRefs,
  getCodeEnvRefForProfile,
  resolveSandboxFilename,
} from 'librechat-data-provider';
import type { CodeEnvRef, TFile } from 'librechat-data-provider';
import type { AxiosInstance } from 'axios';
import type { CodeExecutionRoute } from '../provision/service';
import type { CodeExecutionContext } from '~/agents/execution';
import type { ServerRequest } from '~/types';
import {
  claimCodeDestination,
  createCodeDestinationSet,
  reserveCodeDestination,
  sortCodeFilesByDestinationPriority,
} from './destinations';
import {
  codeServerHttpAgent,
  codeServerHttpsAgent,
  createCodeApiUploadRegistry,
  withCodeApiUploadSlot,
} from '~/utils/code';
import { isStorageNotFoundError } from '~/files/encode/utils';
import { codeExecutionHeaders } from '~/agents/execution';
import { buildCodeEnvDownloadQuery } from './identity';
import { getCodeEnvUploadFilename } from './form';
import { isAbortError } from '~/utils/errors';

export interface CodeFileInfo {
  lastModified?: string;
  originalFilename?: string;
}

/** The object metadata endpoint reports the same original filename as the download header. */
export async function getCodeFileInfo({
  ref,
  req,
  route,
  signal,
  request,
  getBaseURL,
  getAuthHeaders,
}: {
  ref: CodeEnvRef;
  req: ServerRequest;
  route: CodeExecutionRoute & { bridgeWorkerId?: string };
  signal?: AbortSignal;
  request: AxiosInstance;
  getBaseURL: () => string;
  getAuthHeaders: (req: ServerRequest, bridgeWorkerId?: string) => Promise<Record<string, string>>;
}): Promise<CodeFileInfo | null> {
  try {
    signal?.throwIfAborted();
    const headers = await getAuthHeaders(req, route.bridgeWorkerId);
    signal?.throwIfAborted();
    const query = buildCodeEnvDownloadQuery(ref);
    const response = await request<CodeFileInfo>({
      method: 'get',
      url: `${route.baseUrl ?? getBaseURL()}/sessions/${ref.storage_session_id}/objects/${ref.file_id}${query}`,
      headers: {
        'User-Agent': 'LibreChat/1.0',
        ...headers,
        ...(route.executionProfile
          ? codeExecutionHeaders({
              executionProfile: route.executionProfile,
              bridgeWorkerId: route.bridgeWorkerId,
            })
          : {}),
      },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: 5000,
      signal,
    });
    signal?.throwIfAborted();
    return response.data;
  } catch (error) {
    if (signal?.aborted && isAbortError(error)) {
      throw error;
    }
    signal?.throwIfAborted();
    return null;
  }
}

/** Matches the existing 23-hour code-storage freshness window. */
export function checkCodeFileActive(dateString: string | undefined): boolean {
  return dateString != null && (Date.now() - new Date(dateString).getTime()) / 3_600_000 < 23;
}

interface PrimedCodeFile {
  file: TFile;
  ref: CodeEnvRef | undefined;
  sourceRef: CodeEnvRef;
  sandboxName: string;
  isActive: boolean;
  getUploadTime: () => Promise<string | undefined>;
}

/** Reserve actual storage destinations before recovery so a failed winner never revives stale content. */
export async function selectCodeFiles({
  files,
  privateFileIds,
  routeKey,
  getFileInfo,
  concurrency,
  signal,
}: {
  files: Array<TFile | null | undefined>;
  privateFileIds?: ReadonlySet<string>;
  routeKey: string;
  getFileInfo: (ref: CodeEnvRef) => Promise<CodeFileInfo | null>;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<{ selected: PrimedCodeFile[]; skippedNoRef: number; skippedSuperseded: number }> {
  let skippedNoRef = 0;
  let skippedSuperseded = 0;
  const candidates = [];
  const registry = createCodeApiUploadRegistry();
  for (const file of sortCodeFilesByDestinationPriority(files, privateFileIds)) {
    if (!file) {
      continue;
    }
    const ref = getCodeEnvRefForProfile(file.metadata, routeKey);
    const sourceRef = ref ?? getCodeEnvRefs(file.metadata)[0]?.[1];
    if (!sourceRef) {
      skippedNoRef++;
      continue;
    }
    let probe: Promise<CodeFileInfo | null> | undefined;
    const getInfo = () =>
      (probe ??= withCodeApiUploadSlot({
        registry,
        scope: routeKey,
        concurrency,
        signal,
        task: () => getFileInfo(sourceRef),
      }));
    candidates.push({ file, ref, sourceRef, getInfo });
  }
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      const { file, ref, sourceRef, getInfo } = candidate;
      const info = ref ? await getInfo() : null;
      signal?.throwIfAborted();
      const recovering = !ref || !checkCodeFileActive(info?.lastModified);
      const storedName = sourceRef.sandboxFilename ?? info?.originalFilename;
      const sandboxName = storedName ?? resolveSandboxFilename(file.filename, file.type);
      const destination = recovering
        ? getCodeEnvUploadFilename(resolveSandboxFilename(sandboxName, file.type))
        : sandboxName;
      const assignRecoveryName = !ref || recovering;
      return {
        file,
        ref,
        sourceRef,
        isActive: !recovering,
        sandboxName: destination,
        storedName: ref ? storedName : undefined,
        assignRecoveryName,
        selectionPriority:
          (privateFileIds?.has(file.file_id) ? 2 : 0) +
          Number(!ref || (recovering && (!storedName || destination !== storedName))),
        getUploadTime: async () => info?.lastModified,
      };
    }),
  );
  /** Collapse confirmed source-path collisions before renaming recovery files.
   * Distinct old paths that normalize alike are independent inputs, not superseded copies. */
  const storedDestinations = new Set<string>();
  const surviving = resolved.filter((candidate) => {
    if (candidate.storedName && storedDestinations.has(candidate.storedName)) {
      skippedSuperseded++;
      return false;
    }
    if (candidate.storedName) storedDestinations.add(candidate.storedName);
    return true;
  });
  /** Keep shared files independent of each agent's private set. Within each
   * scope, guessed recovery names cannot displace a confirmed stored path. */
  surviving.sort((a, b) => a.selectionPriority - b.selectionPriority);
  const destinations = createCodeDestinationSet();
  const selected: PrimedCodeFile[] = [];
  for (const candidate of surviving) {
    if (candidate.assignRecoveryName) {
      selected.push({
        ...candidate,
        sandboxName: claimCodeDestination(
          destinations,
          candidate.sandboxName,
          candidate.file.file_id,
        ),
      });
      continue;
    }
    if (!reserveCodeDestination(destinations, candidate.sandboxName)) {
      skippedSuperseded++;
      continue;
    }
    selected.push(candidate);
  }
  return { selected, skippedNoRef, skippedSuperseded };
}

/** Where the model can open primed code files on the selected execution route. */
export type CodeFileLocation = 'sandbox' | 'programmatic';

type CodeContextFile = Pick<TFile, 'file_id' | 'filename' | 'context' | 'status' | 'previewError'>;

/**
 * A file the code-file note describes, kept structured on routes where the note is rebuilt
 * after priming: an attached workspace replaces it once attachments are copied in.
 */
export interface CodeContextEntry {
  file: TFile;
  /** Name under the code data directory. */
  destination: string;
  /** One of the agent's own files rather than something attached in this chat. */
  agentScoped: boolean;
  /** The code-environment object holding the bytes, when one is stored. */
  source?: { storage_session_id: string; file_id: string };
}

const CODE_FILE_CONTEXT_ROOTS: Record<CodeFileLocation, string> = {
  sandbox: '/mnt/data',
  programmatic: '$LIBRECHAT_CODE_DATA_DIR',
};

const CODE_FILE_CONTEXT_HEADERS: Record<CodeFileLocation, string> = {
  sandbox: `- Note: The following files are available in the "${Tools.execute_code}" tool environment:`,
  programmatic:
    '- Note: The following files are not in the attached workspace, so workspace tools cannot open them. Scripts run by the programmatic Bash tool, when it is available, can read them at these paths during that run:',
};

/**
 * An attached workspace runs every workspace tool against the user's own directory, and
 * primed files never land there: only programmatic Bash stages them, per run, in the
 * worker's private data directory. An attached environment without a selected workspace
 * runs a sandbox that mounts them at `/mnt/data` like the managed route.
 */
export function getCodeFileLocation(
  context?: Pick<CodeExecutionContext, 'environmentType' | 'codeWorkspace'> | null,
): CodeFileLocation {
  return context?.environmentType === 'attached' && context.codeWorkspace != null
    ? 'programmatic'
    : 'sandbox';
}

function getPreviewContextSuffix(file: CodeContextFile): string {
  if (file.status === 'pending') {
    return ' (preview not yet generated)';
  }
  if (file.status !== 'failed') {
    return '';
  }
  return file.previewError
    ? ` (preview unavailable: ${file.previewError})`
    : ' (preview unavailable)';
}

/**
 * A generated output is normally left out — the model already knows what it
 * wrote. That only holds while the file is still where it wrote it: once a
 * newer same-named file takes the bare path, the output mounts under a
 * suffixed name the model has never seen, and silence would leave it reading
 * the newcomer or failing to find its own artifact.
 */
export function getCodeFileContextLine(
  file: CodeContextFile,
  agentResourceIds: ReadonlySet<string>,
  destination: string,
  location: CodeFileLocation = 'sandbox',
): string {
  if (!isDescribedCodeFile(file, destination)) {
    return '';
  }
  return `\n\t- ${CODE_FILE_CONTEXT_ROOTS[location]}/${destination}${getCodeFileContextSuffix(
    file,
    agentResourceIds.has(file.file_id),
    destination,
  )}`;
}

/** Whether the code-file note mentions this file at `destination` at all. */
export function isDescribedCodeFile(file: CodeContextFile, destination: string): boolean {
  return file.context !== FileContext.execute_code || destination !== file.filename;
}

/** Provenance and preview state appended to a file shown under `shownName`. */
export function getCodeFileContextSuffix(
  file: CodeContextFile,
  agentScoped: boolean,
  shownName: string,
): string {
  const origin =
    file.context === FileContext.execute_code
      ? ` (written earlier as ${file.filename})`
      : `${agentScoped ? '' : ' (attached by user)'}${
          shownName !== file.filename ? ` (uploaded as ${file.filename})` : ''
        }`;
  return `${origin}${getPreviewContextSuffix(file)}`;
}

export function appendCodeFileContextLine(
  toolContext: string,
  contextLine: string,
  location: CodeFileLocation = 'sandbox',
): string {
  if (!contextLine) {
    return toolContext;
  }
  if (toolContext) {
    return `${toolContext}${contextLine}`;
  }
  return `${CODE_FILE_CONTEXT_HEADERS[location]}${contextLine}`;
}

/** Dynamic tool context key for code files whose stored copy was deleted. */
const MISSING_CODE_FILES_CONTEXT_KEY = 'missing_code_files';

/**
 * Names the conversation files that could not be restored into the code environment because
 * storage no longer has them, so the model does not look for them there.
 */
export function formatMissingCodeFilesNote(filenames: string[]): string {
  if (!filenames.length) {
    return '';
  }
  const names = filenames.map((name) => `"${name}"`).join(', ');
  return (
    `The following conversation files were deleted from storage and are not available in the code environment: ${names}. ` +
    'If they are needed, ask the user to upload them again.'
  );
}

/**
 * Raised when storage no longer has a code file's source object. Only the storage read throws
 * it, so a 404 from the Code API upload is never mistaken for a deleted file. `code` keeps the
 * operator-facing failure category `missing_backing_object`.
 */
export class CodeSourceMissingError extends Error {
  readonly code = 'NotFound';

  constructor() {
    super('The source object of a code file is missing from storage.');
    this.name = 'CodeSourceMissingError';
  }
}

function isReadableStream(value: unknown): value is Readable {
  return value instanceof Readable;
}

/**
 * Opens a code file's source from storage, naming a storage miss as `CodeSourceMissingError`.
 * Local storage hands back a stream that only reports a missing file once read, so a stream is
 * held until its first chunk or error; the chunk stays buffered for the upload.
 */
export async function openCodeFileSource<T>(
  open: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const source = await open();
    if (isReadableStream(source) && !source.readableEnded) {
      try {
        await once(source, 'readable', signal ? { signal } : undefined);
      } catch (error) {
        /* The caller never receives this stream, so nothing else can close it. */
        source.destroy();
        throw error;
      }
    }
    return source;
  } catch (error) {
    if (isStorageNotFoundError(error)) {
      throw new CodeSourceMissingError();
    }
    throw error;
  }
}

/** Puts the missing-files note under its own context key, which no workspace rebuild replaces. */
export function setMissingCodeFilesContext(
  dynamicToolContextMap: Record<string, unknown>,
  missingFilesContext: string | undefined,
): void {
  if (missingFilesContext) {
    dynamicToolContextMap[MISSING_CODE_FILES_CONTEXT_KEY] = missingFilesContext;
  }
}

/**
 * Tallies the reupload failures of one priming pass. A file whose source storage deleted is
 * named to the model instead of failing the turn; every other failure, including a Code API
 * 404, can still require resource recovery.
 */
export function createCodeReuploadFailures(): {
  add: (
    error: unknown,
    category: string,
    file: Pick<CodeContextFile, 'file_id' | 'filename'>,
  ) => void;
  readonly count: number;
  readonly missingCount: number;
  requiresRecovery: (required: number, primed: number) => boolean;
  recoveryCategory: () => string;
  missingFilesContext: () => string;
} {
  let count = 0;
  const categories = new Set<string>();
  const missingFilenames: string[] = [];
  return {
    add: (error, category, file) => {
      count += 1;
      if (error instanceof CodeSourceMissingError) {
        missingFilenames.push(file.filename || file.file_id);
        return;
      }
      categories.add(category);
    },
    get count() {
      return count;
    },
    get missingCount() {
      return missingFilenames.length;
    },
    requiresRecovery: (required, primed) =>
      required > 0 && primed === 0 && count === required && categories.size > 0,
    recoveryCategory: () =>
      categories.size === 1 ? Array.from(categories)[0] : 'mixed_reupload_failure',
    missingFilesContext: () => formatMissingCodeFilesNote(missingFilenames),
  };
}
