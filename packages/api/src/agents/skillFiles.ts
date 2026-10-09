import { Readable } from 'stream';
import { Constants } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import {
  getCodeEnvRefForProfile,
  hasActivePiiFields,
  type CodeEnvRef,
  type CodeEnvRefMap,
} from 'librechat-data-provider';
import type { CodeEnvFile, ToolSessionMap, CodeSessionContext } from '@librechat/agents';
import type { Types } from 'mongoose';
import type { ServerRequest } from '~/types';
import {
  extractFileContent,
  extractSkillContent,
  hasActiveFileFieldPolicy,
  getBlockedUninspectableSkillFileField,
  inspectContent,
  UninspectableFileError,
} from '~/protection';
import {
  createCodeApiRateLimitBudget,
  getCodeApiUploadOptions,
  getSafeErrorMetadata,
  isAbortError,
  type CodeApiRateLimitBudget,
  withCodeApiUploadRecovery,
} from '~/utils';
import { seedCodeFilesIntoSessions, type CodeExecutionProfileRoute } from './codeFilesSession';
import { ContentFilterError, isContentFilterError } from '~/middleware/contentFilter';
import { getCodeExecutionRouteKey, type CodeExecutionContext } from './execution';
import { assertSkillFileContentAllowed } from '~/skills/protection';
import { createSkillContentDigest } from './compatibility';
import { extractInvokedSkillsFromPayload } from './run';
import { resolveDownloadPath } from '~/storage/path';
import { SKILL_FILE_PREFIX } from './skills';

const MAX_INSPECTABLE_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const SKILL_FILE_CONTENT_FIELDS = ['file_text'] as const;
const FILE_CONTENT_FIELDS = ['content', 'extracted_text'] as const;

export interface SkillFileRecord {
  relativePath: string;
  filename: string;
  filepath: string;
  source: string;
  bytes: number;
  codeEnvRef?: CodeEnvRef;
  codeEnvRefs?: CodeEnvRefMap;
}

export interface PrimeSkillFilesParams {
  skill: {
    body: string;
    name: string;
    frontmatter?: Record<string, unknown>;
    _id: Types.ObjectId | string;
    /** Monotonic counter on the skill record. Bumped on every edit
     *  (frontmatter / body / file upsert). Threaded into `codeEnvRef.version`
     *  so codeapi's sessionKey scopes the cache per-revision. */
    version: number;
  };
  skillFiles: SkillFileRecord[];
  req: ServerRequest;
  /** Optional operation-wide wait allowance shared by sibling skill primes. */
  rateLimitBudget?: CodeApiRateLimitBudget;
  /** Effective foreground cancellation signal for acquisition, waits, and transport. */
  signal?: AbortSignal;
  getStrategyFunctions: (source: string) => {
    getDownloadStream?: (
      req: ServerRequest,
      filepath: string,
      options?: { signal?: AbortSignal },
    ) => Promise<NodeJS.ReadableStream>;
    [key: string]: unknown;
  };
  batchUploadCodeEnvFiles: (params: {
    req: ServerRequest;
    files: Array<{ stream: NodeJS.ReadableStream; filename: string }>;
    /** Resource kind that owns the batch's storage session. Drives codeapi's
     *  sessionKey derivation (`<tenant>:<kind>:<id>[:v:<version>]`). */
    kind: 'skill' | 'agent' | 'user';
    /** Resource id (skillId / agentId / userId). */
    id: string;
    /** Required when `kind === 'skill'`; forbidden otherwise. */
    version?: number;
    /** When true, codeapi tags every file in the batch as infrastructure
     *  (read-only inputs that must never surface as generated artifacts,
     *  even if sandboxed code mutates the bytes on disk). */
    read_only?: boolean;
    codeApiBaseUrl?: string;
    executionProfile?: CodeExecutionContext['executionProfile'];
    bridgeWorkerId?: string;
    signal?: AbortSignal;
  }) => Promise<{
    storage_session_id: string;
    files: Array<{ fileId: string; filename: string }>;
  }>;
  /** Checks if a code env file is still active. Returns lastModified timestamp or null. */
  getSessionInfo?: (
    ref: CodeEnvRef,
    req?: ServerRequest,
    route?: {
      baseUrl?: string;
      executionProfile?: CodeExecutionContext['executionProfile'];
      bridgeWorkerId?: string;
    },
    signal?: AbortSignal,
  ) => Promise<string | null>;
  /** Trusted Code API route selected for the executing agent. */
  codeExecutionContext?: Pick<
    CodeExecutionContext,
    'baseUrl' | 'executionProfile' | 'executionRouteKey' | 'bridgeWorkerId'
  >;
  /** 23-hour freshness check */
  checkIfActive?: (dateString: string) => boolean;
  /** Persists `codeEnvRef` on skill files after upload. Implementations
   *  warn-log on partial writes (matchedCount/modifiedCount mismatch)
   *  internally — caller can fire-and-forget without losing visibility. */
  updateSkillFileCodeEnvIds?: (
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ) => Promise<{ matchedCount: number; modifiedCount: number } | void>;
}

export interface PrimeSkillFilesResult {
  /** Representative storage session id (first file's). */
  storage_session_id: string;
  files: Array<{
    /** Storage file id (the per-file uuid file_server returned at upload). */
    id: string;
    /** Resource id — the entity that owns the storage session. For skill
     *  files this is `skill._id.toString()`. Distinct from `id`; codeapi
     *  derives the sessionKey from `resource_id` (shared cache scope) but
     *  validates upload presence under `id` (per-file storage key). */
    resource_id: string;
    storage_session_id: string;
    name: string;
    kind: 'skill' | 'agent' | 'user';
    version?: number;
  }>;
}

const inflightPrimes = new Map<string, Promise<PrimeSkillFilesResult | null>>();
const signalIds = new WeakMap<AbortSignal, number>();
let nextSignalId = 1;

function getSignalScope(signal?: AbortSignal): string {
  if (!signal) {
    return 'unscoped';
  }
  let id = signalIds.get(signal);
  if (id == null) {
    id = nextSignalId++;
    signalIds.set(signal, id);
  }
  return String(id);
}

type SkillUploadFiles = Array<{ stream: NodeJS.ReadableStream; filename: string }>;
type SkillCodeEnvRef = Extract<CodeEnvRef, { kind: 'skill' }>;

function isCurrentSkillRef(
  ref: CodeEnvRef | undefined,
  skillVersion: number,
): ref is SkillCodeEnvRef {
  return ref?.kind === 'skill' && ref.version === skillVersion;
}

function destroySkillUploadStream(stream: NodeJS.ReadableStream): void {
  try {
    if (
      'destroy' in stream &&
      typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function'
    ) {
      (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
    }
  } catch {
    /* Preserve the run cancellation even if a provider stream rejects cleanup. */
  }
}

/** Opens SKILL.md and bundled-file streams for one upload attempt. Called
 *  per attempt — a failed upload consumes the streams, so a retry must
 *  re-acquire them. */
async function collectSkillUploadFiles(
  params: PrimeSkillFilesParams,
  inspectedBuffers: ReadonlyMap<SkillFileRecord, Buffer>,
): Promise<SkillUploadFiles> {
  const { skill, skillFiles, req, getStrategyFunctions, signal } = params;
  signal?.throwIfAborted();
  const filesToUpload: SkillUploadFiles = [];

  // SKILL.md from the skill body
  const bodyBuffer = Buffer.from(skill.body, 'utf-8');
  filesToUpload.push({
    stream: Readable.from(bodyBuffer),
    filename: `${SKILL_FILE_PREFIX}${skill.name}/SKILL.md`,
  });

  // Bundled files from storage (parallel stream acquisition)
  const streamResults = await Promise.allSettled(
    skillFiles.map(async (file) => {
      signal?.throwIfAborted();
      const inspected = inspectedBuffers.get(file);
      if (inspected != null) {
        return {
          stream: Readable.from(inspected),
          filename: `${SKILL_FILE_PREFIX}${skill.name}/${file.relativePath}`,
        };
      }
      const strategy = getStrategyFunctions(file.source);
      if (!strategy.getDownloadStream) {
        logger.warn(
          `[primeSkillFiles] No download stream for "${file.relativePath}" (source: ${file.source})`,
        );
        return null;
      }
      const stream = await strategy.getDownloadStream(req, resolveDownloadPath(file), { signal });
      if (signal?.aborted) {
        destroySkillUploadStream(stream);
        signal.throwIfAborted();
      }
      return { stream, filename: `${SKILL_FILE_PREFIX}${skill.name}/${file.relativePath}` };
    }),
  );
  /* Do not let allSettled turn foreground cancellation into a skipped bundle
   * member. A partial skill upload can look successful while leaving required
   * files unavailable to the sandbox. */
  if (signal?.aborted) {
    for (const file of filesToUpload) {
      destroySkillUploadStream(file.stream);
    }
    for (const result of streamResults) {
      if (result.status === 'fulfilled' && result.value) {
        destroySkillUploadStream(result.value.stream);
      }
    }
    signal.throwIfAborted();
  }
  for (const result of streamResults) {
    if (result.status === 'fulfilled' && result.value) {
      filesToUpload.push(result.value);
    } else if (result.status === 'rejected') {
      logger.error('[primeSkillFiles] Failed to get stream:', getSafeErrorMetadata(result.reason));
    }
  }

  return filesToUpload;
}

function assertStoredSkillBodyAllowed(
  skill: PrimeSkillFilesParams['skill'],
  req: ServerRequest,
): void {
  const filters = req.config?.filters;
  const skillPii = filters?.skills?.pii;
  const inspectSkill = hasActivePiiFields(skillPii, ['name', 'instructions', 'frontmatter']);
  const inspectFile = hasActiveFileFieldPolicy(filters, ['name', 'content', 'extracted_text']);
  if (!inspectSkill && !inspectFile) {
    return;
  }
  const finding = inspectContent(
    [
      ...(inspectSkill
        ? extractSkillContent({
            ...(hasActivePiiFields(skillPii, ['name']) && { name: skill.name }),
            ...(hasActivePiiFields(skillPii, ['instructions']) && { body: skill.body }),
            ...(hasActivePiiFields(skillPii, ['frontmatter']) && {
              frontmatter: skill.frontmatter,
            }),
          })
        : []),
      ...(inspectFile
        ? extractFileContent({
            filename: `${SKILL_FILE_PREFIX}${skill.name}/SKILL.md`,
            content: skill.body,
            extractedText: skill.body,
          })
        : []),
    ],
    { filters },
  );
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}

function assertStoredSkillFileAllowed(
  file: SkillFileRecord,
  buffer: Buffer,
  req: ServerRequest,
): void {
  assertSkillFileContentAllowed(req.config?.filters, {
    buffer,
    originalName: file.filename,
    relativePath: file.relativePath,
  });
}

function assertStoredSkillFileNameAllowed(file: SkillFileRecord, req: ServerRequest): void {
  const filters = req.config?.filters;
  const finding = inspectContent(
    [
      ...extractSkillContent({
        files: [{ name: file.filename, filename: file.relativePath }],
      }),
      ...extractFileContent({
        name: file.filename,
        filename: file.relativePath,
      }),
    ],
    { filters },
  );
  if (finding != null) {
    throw new ContentFilterError(finding);
  }
}

function shouldInspectStoredSkillFileContent(req: ServerRequest): boolean {
  const filters = req.config?.filters;
  const skillPii = filters?.skills?.pii;
  return (
    hasActivePiiFields(skillPii, SKILL_FILE_CONTENT_FIELDS) ||
    hasActiveFileFieldPolicy(filters, FILE_CONTENT_FIELDS)
  );
}

function shouldInspectStoredSkillFileMetadata(req: ServerRequest): boolean {
  const filters = req.config?.filters;
  return (
    hasActivePiiFields(filters?.skills?.pii, ['file_name']) ||
    hasActiveFileFieldPolicy(filters, ['name'])
  );
}

function throwIfStoredSkillFileMustBeInspectable(req: ServerRequest): void {
  const blockedField = getBlockedUninspectableSkillFileField(
    req.config?.filters,
    FILE_CONTENT_FIELDS,
  );
  if (blockedField != null) {
    throw new UninspectableFileError(blockedField);
  }
}

async function bufferSkillFileStream(
  stream: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
    signal?.throwIfAborted();
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_INSPECTABLE_SKILL_FILE_BYTES) {
      return null;
    }
    chunks.push(buffer);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks);
}

/**
 * Uploads skill files to the code execution environment.
 *
 * Smart re-upload: if skill files have existing codeEnvIdentifiers,
 * checks session freshness first. If the session is still active,
 * returns cached references. Otherwise batch-uploads everything.
 *
 * After upload, persists new codeEnvIdentifiers on the SkillFile
 * documents for future freshness checks.
 *
 * Rate-limit resilience: concurrent primes of the same (skill, version)
 * share one flight, uploads are bounded per Code API route and principal,
 * and 429 responses retry within a capped wait budget.
 */
export async function primeSkillFiles(
  params: PrimeSkillFilesParams,
): Promise<PrimeSkillFilesResult | null> {
  /* Single-flight per (skill, version): concurrent primes of the same cold
   * skill join the in-flight upload instead of double-spending the upload
   * rate budget. Skill _ids are tenant-scoped and the resulting session is
   * resource-scoped (`<tenant>:skill:<id>:v:<version>`), so sharing the
   * result across requests is sound. Per-process best-effort; the awaited
   * codeEnvRef persist covers cross-turn and cross-node dedupe. */
  const executionRouteKey = params.codeExecutionContext
    ? getCodeExecutionRouteKey(params.codeExecutionContext)
    : 'default';
  /* A flight may share cancellation only with callers from the same run.
   * Cross-run sharing would let one user's Stop abort another live request. */
  const flightKey = `${executionRouteKey}:${params.skill._id}:v:${params.skill.version}:run:${getSignalScope(params.signal)}`;
  const inflight = inflightPrimes.get(flightKey);
  if (inflight) {
    return inflight;
  }
  const flight = executePrimeSkillFiles(params).finally(() => {
    inflightPrimes.delete(flightKey);
  });
  inflightPrimes.set(flightKey, flight);
  return flight;
}

async function executePrimeSkillFiles(
  params: PrimeSkillFilesParams,
): Promise<PrimeSkillFilesResult | null> {
  const {
    skill,
    skillFiles,
    req,
    getStrategyFunctions,
    batchUploadCodeEnvFiles,
    getSessionInfo,
    checkIfActive,
    updateSkillFileCodeEnvIds,
    codeExecutionContext,
    rateLimitBudget,
    signal,
  } = params;
  signal?.throwIfAborted();
  const executionProfile = codeExecutionContext?.executionProfile ?? 'default';
  const executionRouteKey = codeExecutionContext
    ? getCodeExecutionRouteKey(codeExecutionContext)
    : executionProfile;
  const inspectStoredMetadata = shouldInspectStoredSkillFileMetadata(req);
  const inspectBundledFileContent = shouldInspectStoredSkillFileContent(req);
  const inspectedBuffers = new Map<SkillFileRecord, Buffer>();

  assertStoredSkillBodyAllowed(skill, req);

  if (inspectStoredMetadata) {
    for (const file of skillFiles) {
      signal?.throwIfAborted();
      assertStoredSkillFileNameAllowed(file, req);
    }
  }

  if (inspectBundledFileContent) {
    for (const file of skillFiles) {
      signal?.throwIfAborted();
      if (file.bytes > MAX_INSPECTABLE_SKILL_FILE_BYTES) {
        throwIfStoredSkillFileMustBeInspectable(req);
        continue;
      }
      try {
        const strategy = getStrategyFunctions(file.source);
        if (!strategy.getDownloadStream) {
          throwIfStoredSkillFileMustBeInspectable(req);
          logger.warn('[primeSkillFiles] No download stream for stored skill file');
          continue;
        }
        const sourceStream = await strategy.getDownloadStream(req, resolveDownloadPath(file), {
          signal,
        });
        const buffer = await bufferSkillFileStream(sourceStream, signal);
        if (buffer == null) {
          throwIfStoredSkillFileMustBeInspectable(req);
          continue;
        }
        assertStoredSkillFileAllowed(file, buffer, req);
        inspectedBuffers.set(file, buffer);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        if (isContentFilterError(error)) {
          throw error;
        }
        throwIfStoredSkillFileMustBeInspectable(req);
        logger.error('[primeSkillFiles] Failed to inspect bundled file before use');
      }
    }
  }

  /* Cache-hit path: every skillFile carries a `codeEnvRef` from the
   * previous prime. Check freshness against codeapi for every distinct
   * storage session; if all are still active, reuse without
   * re-uploading. The skill version is part of the ref — when the
   * skill version has been bumped (e.g. by a SKILL.md edit), stale
   * refs are treated as cache misses and the files are re-uploaded
   * under the new version's session key. */
  if (getSessionInfo && checkIfActive && skillFiles.length > 0) {
    const allHaveRefs = skillFiles.every((sf) => {
      const ref = getCodeEnvRefForProfile(sf, executionRouteKey);
      return isCurrentSkillRef(ref, skill.version);
    });
    if (allHaveRefs) {
      const refsBySession = new Map<string, CodeEnvRef>();
      for (const sf of skillFiles) {
        const ref = getCodeEnvRefForProfile(sf, executionRouteKey);
        if (ref && !refsBySession.has(ref.storage_session_id)) {
          refsBySession.set(ref.storage_session_id, ref);
        }
      }

      try {
        const checkResults = await Promise.all(
          Array.from(refsBySession.values()).map(async (ref) => {
            const lastModified = await getSessionInfo(ref, req, codeExecutionContext, signal);
            return !!(lastModified && checkIfActive(lastModified));
          }),
        );
        signal?.throwIfAborted();
        const allActive = checkResults.every(Boolean);

        if (allActive) {
          const files: PrimeSkillFilesResult['files'] = [];
          for (const sf of skillFiles) {
            const ref = getCodeEnvRefForProfile(sf, executionRouteKey);
            if (!ref) continue;
            /* Cache-hit refs already carry resource identity (kind / id /
             * version) — pull them through so the artifact emitted by
             * `handle_skill` and forwarded to `_injected_files` includes
             * `resource_id`. Without this the next /exec sends
             * `resource_id: undefined` and codeapi 400s. The discriminated
             * union pins `version` to the skill branch only — destructure
             * before the spread so TS accepts the conditional pull. */
            files.push({
              id: ref.file_id,
              resource_id: ref.id,
              storage_session_id: ref.storage_session_id,
              name: `${SKILL_FILE_PREFIX}${skill.name}/${sf.relativePath}`,
              kind: ref.kind,
              ...(ref.kind === 'skill' ? { version: ref.version } : {}),
            });
          }

          if (files.length > 0) {
            logger.debug(
              `[primeSkillFiles] All ${refsBySession.size} session(s) active for skill "${skill.name}", reusing ${files.length} files`,
            );
            return { storage_session_id: files[0].storage_session_id, files };
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        // Session check failed — fall through to re-upload
      }
    }
  }

  const entityId = skill._id.toString();
  try {
    const uploadOptions = getCodeApiUploadOptions(req, executionRouteKey);
    const uploaded = await withCodeApiUploadRecovery({
      registry: req.app.locals.codeApiUploadRegistry,
      scope: uploadOptions.scope,
      concurrency: uploadOptions.concurrency,
      label: `priming skill "${skill.name}"`,
      budget: rateLimitBudget ?? createCodeApiRateLimitBudget(uploadOptions.retryWaitMs),
      signal,
      onWait: (waitMs) =>
        logger.warn(
          `[primeSkillFiles] Rate-limited priming skill "${skill.name}"; retrying in ${waitMs}ms`,
        ),
      openSource: () => collectSkillUploadFiles(params, inspectedBuffers),
      upload: async (filesToUpload) => {
        if (filesToUpload.length === 0) {
          return null;
        }
        const result = await batchUploadCodeEnvFiles({
          req,
          files: filesToUpload,
          /* Resource identity for codeapi's sessionKey: skill files share
           * cross-user-within-tenant under `<tenant>:skill:<id>:v:<version>`.
           * Bumping `skill.version` on edit naturally invalidates the prior
           * cache entry under the new version's sessionKey. */
          kind: 'skill',
          id: entityId,
          version: skill.version,
          /* Skill files are infrastructure: SKILL.md + bundled scripts/schemas/
           * docs that the agent reads but should never edit. Tag the upload as
           * read-only so codeapi seals the inputs (chmod 444 in-sandbox) and
           * walker echoes the original refs as `inherited: true` even if some
           * sandboxed code path mutates bytes on disk. Without this, modified
           * skill files surface as ghost generated artifacts the user has no
           * authority to download. */
          read_only: true,
          codeApiBaseUrl: codeExecutionContext?.baseUrl,
          executionProfile: codeExecutionContext?.executionProfile,
          bridgeWorkerId: codeExecutionContext?.bridgeWorkerId,
          signal,
        });
        return { filesToUpload, result };
      },
    });
    if (uploaded == null) {
      return null;
    }
    const { filesToUpload, result } = uploaded;
    // Exclude SKILL.md from the returned files array — it is uploaded to disk
    // for bash access but has no codeEnvRef (cannot be cached). Omitting it
    // here keeps the fresh-upload and cache-hit code paths consistent.
    const files: PrimeSkillFilesResult['files'] = result.files
      .filter((f) => !f.filename.endsWith('/SKILL.md'))
      .map((f) => ({
        id: f.fileId,
        /* `resource_id` is the skill `_id` (the entity codeapi scopes
         * the sessionKey on). Distinct from `id` (the per-file storage
         * uuid) — both are required on the request. */
        resource_id: entityId,
        storage_session_id: result.storage_session_id,
        name: f.filename,
        kind: 'skill',
        version: skill.version,
      }));

    // Treat partial upload failures as a priming failure — missing bundled
    // files cause follow-up bash/read calls to fail at runtime with missing paths.
    const expectedCount = filesToUpload.filter((f) => !f.filename.endsWith('/SKILL.md')).length;
    if (files.length < expectedCount) {
      logger.error('[primeSkillFiles] Partial upload failure', {
        expectedCount,
        uploadedCount: files.length,
      });
      return null;
    }

    /**
     * Persist codeEnvRefs on skill files. Awaited (not fire-and-forget)
     * so the next prime — which can start within milliseconds when
     * many users hit the same skill concurrently — sees the cache
     * pointer instead of racing the read against an in-flight write.
     * Without the await, a fire-and-forget under concurrency stays in
     * cache-miss steady-state for the duration of the burst (each
     * user's prime reads stale, re-uploads, then fires its own forget
     * that the next user also misses). Latency cost is ~10–50ms on
     * the prime that does the upload; subsequent primes save an entire
     * batch upload. Failures don't fail the prime — the file refs
     * returned to the caller are still valid.
     */
    if (updateSkillFileCodeEnvIds) {
      /* Uploaded filenames are namespaced `skills/{skillName}/{relativePath}`
       * so the sandbox mount mirrors the model-facing skill namespace. The
       * persisted `relativePath` is the bare path (e.g. `references/style.md`),
       * so strip the `skills/{skillName}/` prefix rather than just the first
       * segment. */
      const sandboxPrefix = `${SKILL_FILE_PREFIX}${skill.name}/`;
      const updates = result.files
        .filter((f) => !f.filename.endsWith('/SKILL.md'))
        .map((f) => {
          const ref: CodeEnvRef = {
            kind: 'skill',
            id: entityId,
            storage_session_id: result.storage_session_id,
            file_id: f.fileId,
            version: skill.version,
            executionProfile,
            ...(executionRouteKey !== executionProfile ? { executionRouteKey } : {}),
          };
          return {
            skillId: skill._id,
            relativePath: f.filename.startsWith(sandboxPrefix)
              ? f.filename.slice(sandboxPrefix.length)
              : f.filename.slice(f.filename.indexOf('/') + 1),
            codeEnvRef: ref,
          };
        });
      if (updates.length > 0) {
        try {
          await updateSkillFileCodeEnvIds(updates);
        } catch (err: unknown) {
          logger.error(
            '[primeSkillFiles] Failed to persist codeEnvRefs',
            getSafeErrorMetadata(err),
          );
        }
      }
    }

    return { storage_session_id: result.storage_session_id, files };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    logger.error('[primeSkillFiles] Batch upload failed', getSafeErrorMetadata(error));
    return null;
  }
}

export interface PrimeInvokedSkillsDeps {
  req: ServerRequest;
  /** Effective cancellation signal for the historical priming operation. */
  signal?: AbortSignal;
  /** Raw message payload (before formatAgentMessages). Used to extract invoked skill names. */
  payload?: Array<Partial<{ role: string; content: unknown }>>;
  /** Explicit durable names used by a validated event-actor preflight. */
  skillNames?: readonly string[];
  accessibleSkillIds: Types.ObjectId[];
  /** `execute_code` capability flag for the run. When false, the batch-upload
   *  path is skipped entirely — skill bodies still reconstruct for history
   *  rebuilds, but no sandbox traffic is generated. */
  codeEnvAvailable: boolean;
  getSkillByName: (
    name: string,
    accessibleIds: Types.ObjectId[],
  ) => Promise<{
    body: string;
    name: string;
    frontmatter?: Record<string, unknown>;
    _id: Types.ObjectId;
    version: number;
    fileCount: number;
  } | null>;
  listSkillFiles: (skillId: Types.ObjectId | string) => Promise<SkillFileRecord[]>;
  getStrategyFunctions: PrimeSkillFilesParams['getStrategyFunctions'];
  batchUploadCodeEnvFiles: PrimeSkillFilesParams['batchUploadCodeEnvFiles'];
  getSessionInfo?: PrimeSkillFilesParams['getSessionInfo'];
  checkIfActive?: PrimeSkillFilesParams['checkIfActive'];
  updateSkillFileCodeEnvIds?: PrimeSkillFilesParams['updateSkillFileCodeEnvIds'];
  codeExecutionContext?: PrimeSkillFilesParams['codeExecutionContext'];
  rateLimitBudget?: CodeApiRateLimitBudget;
}

export interface PrimeInvokedSkillsResult {
  initialSessions?: ToolSessionMap;
  /** Pre-resolved skill bodies keyed by skill name. Passed to formatAgentMessages
   *  so it can reconstruct HumanMessages at the right position in the message sequence. */
  skills?: Map<string, string>;
  /** Exact records resolved under the current request's ACL. */
  skillManifest?: Array<{
    id: string;
    name: string;
    version: number;
    contentDigest: string;
  }>;
}

export interface PrimeInvokedSkillsForProfilesDeps
  extends Omit<PrimeInvokedSkillsDeps, 'codeEnvAvailable' | 'codeExecutionContext'> {
  executionProfiles: CodeExecutionProfileRoute[];
}

/**
 * Extracts previously invoked skills from message history, resolves their
 * bodies from DB, and re-primes their files to the code env.
 *
 * Returns:
 * - initialSessions: seeds Graph.sessions so ToolNode injects session_id into bash/code tools
 * - skills: Map of skillName → body for formatAgentMessages to reconstruct HumanMessages
 */
export async function primeInvokedSkills(
  deps: PrimeInvokedSkillsDeps,
): Promise<PrimeInvokedSkillsResult> {
  if ((!deps.payload?.length && !deps.skillNames?.length) || !deps.accessibleSkillIds?.length) {
    return {};
  }

  const invokedSkills = new Set(deps.skillNames ?? []);
  for (const name of extractInvokedSkillsFromPayload(deps.payload ?? [])) {
    invokedSkills.add(name);
  }
  if (invokedSkills.size === 0) {
    return {};
  }

  const skills = new Map<string, string>();

  // Phase 1: Resolve all skills in parallel (DB lookups)
  const resolveResults = await Promise.allSettled(
    Array.from(invokedSkills).map(async (skillName) => {
      const skill = await deps.getSkillByName(skillName, deps.accessibleSkillIds);
      return skill ?? undefined;
    }),
  );

  const resolvedSkills: Array<{
    body: string;
    name: string;
    frontmatter?: Record<string, unknown>;
    _id: Types.ObjectId;
    version: number;
    fileCount: number;
  }> = [];
  for (const r of resolveResults) {
    if (r.status === 'fulfilled' && r.value) {
      assertStoredSkillBodyAllowed(r.value, deps.req);
      skills.set(r.value.name, r.value.body);
      resolvedSkills.push(r.value);
    } else if (r.status === 'rejected') {
      logger.warn('[primeInvokedSkills] Skill resolution failed:', getSafeErrorMetadata(r.reason));
    }
  }
  const skillManifest = resolvedSkills.map((skill) => ({
    id: skill._id.toString(),
    name: skill.name,
    version: skill.version,
    contentDigest: createSkillContentDigest(skill.body),
  }));

  // Phase 2: Single batch upload for ALL skills' files (shared session)
  let sessions: ToolSessionMap | undefined;
  const skillsWithFiles = resolvedSkills.filter((s) => s.fileCount > 0);

  if (deps.codeEnvAvailable && skillsWithFiles.length > 0) {
    const inspectStoredMetadata = shouldInspectStoredSkillFileMetadata(deps.req);
    const inspectStoredSkillFileContent = shouldInspectStoredSkillFileContent(deps.req);
    // Parallel file list lookups (R2 fix)
    const fileListResults = await Promise.all(
      skillsWithFiles.map(async (skill) => ({
        skill,
        files: await deps.listSkillFiles(skill._id),
      })),
    );

    if (inspectStoredMetadata && !inspectStoredSkillFileContent) {
      for (const { files } of fileListResults) {
        for (const file of files) {
          assertStoredSkillFileNameAllowed(file, deps.req);
        }
      }
    }

    // Session freshness check: the code env natively handles mixed sessions
    // (each file carries its own session_id, fetched independently). We check
    // ALL distinct sessions for freshness. If all are active, return cached
    // references with zero re-uploads. If any expired, re-upload everything.
    const executionProfile = deps.codeExecutionContext?.executionProfile ?? 'default';
    const executionRouteKey = deps.codeExecutionContext
      ? getCodeExecutionRouteKey(deps.codeExecutionContext)
      : executionProfile;
    if (!inspectStoredSkillFileContent && deps.getSessionInfo && deps.checkIfActive) {
      const allResolved = fileListResults.flatMap((r) =>
        r.files.map((f) => ({
          skill: r.skill,
          skillName: r.skill.name,
          file: f,
          ref: getCodeEnvRefForProfile(f, executionRouteKey),
        })),
      );
      const resolvedWithRef = allResolved.filter(
        (entry): entry is typeof entry & { ref: SkillCodeEnvRef } =>
          isCurrentSkillRef(entry.ref, entry.skill.version),
      );

      // Only use cache when ALL files have refs (no partial persistence)
      if (resolvedWithRef.length > 0 && resolvedWithRef.length === allResolved.length) {
        const refsBySession = new Map<string, CodeEnvRef>();
        for (const { ref } of resolvedWithRef) {
          if (ref && !refsBySession.has(ref.storage_session_id)) {
            refsBySession.set(ref.storage_session_id, ref);
          }
        }

        const checkResults = await Promise.all(
          Array.from(refsBySession.values()).map(async (ref) => {
            try {
              const lastModified = await deps.getSessionInfo?.(
                ref,
                deps.req,
                deps.codeExecutionContext,
                deps.signal,
              );
              deps.signal?.throwIfAborted();
              return !!(lastModified && deps.checkIfActive?.(lastModified));
            } catch (error) {
              if (isAbortError(error)) {
                throw error;
              }
              return false;
            }
          }),
        );
        deps.signal?.throwIfAborted();
        const allActive = checkResults.every(Boolean);

        if (allActive) {
          /* `id` is the STORAGE file_id (the per-file uuid the
           * file_server registered the upload under); `resource_id`
           * is the entity that owns the storage session — the
           * skill's `_id` here. codeapi's auth layer needs both:
           * `id` for the upload-existence check, `resource_id` for
           * sessionKey re-derivation (`<tenant>:skill:<resource_id>:v:<version>`).
           * Conflating them sent the storage nanoid through the
           * sessionKey switch and 403'd every shared-kind /exec. */
          const cachedFiles = resolvedWithRef.map(({ skillName, file, ref }) => ({
            id: ref!.file_id,
            resource_id: ref!.id,
            name: `${SKILL_FILE_PREFIX}${skillName}/${file.relativePath}`,
            storage_session_id: ref!.storage_session_id,
            kind: ref!.kind,
            ...(ref!.kind === 'skill' ? { version: ref!.version } : {}),
          }));
          if (cachedFiles.length > 0) {
            logger.debug(
              `[primeInvokedSkills] All ${refsBySession.size} session(s) active, reusing ${cachedFiles.length} cached files`,
            );
            sessions = new Map();
            /* `session_id` at the top of CodeSessionContext is the
             * (representative) execution session — ToolNode reads it
             * for continuity. Per-file storage is on each
             * `files[i].storage_session_id`. */
            sessions.set(Constants.EXECUTE_CODE, {
              session_id: cachedFiles[0].storage_session_id,
              files: cachedFiles,
              lastUpdated: Date.now(),
            } satisfies CodeSessionContext);
            return {
              initialSessions: sessions,
              skills: skills.size > 0 ? skills : undefined,
              skillManifest,
            };
          }
        }
      }
    }

    // Per-skill upload: each skill gets its own storage session keyed
    // by `(kind: 'skill', id: skillId, version: skill.version)`.
    // primeSkillFiles handles freshness caching per-skill, so only
    // expired skills re-upload. Code API handles mixed
    // storage_session_ids natively.
    const allPrimedFiles: Array<{
      id: string;
      resource_id: string;
      name: string;
      storage_session_id: string;
      kind: 'skill';
      version: number;
    }> = [];
    const uploadOptions = getCodeApiUploadOptions(deps.req, executionRouteKey);
    const rateLimitBudget =
      deps.rateLimitBudget ?? createCodeApiRateLimitBudget(uploadOptions.retryWaitMs);
    const primeResults = await Promise.allSettled(
      fileListResults.map(async ({ skill, files }) => {
        const result = await primeSkillFiles({
          skill,
          skillFiles: files,
          req: deps.req,
          getStrategyFunctions: deps.getStrategyFunctions,
          batchUploadCodeEnvFiles: deps.batchUploadCodeEnvFiles,
          getSessionInfo: deps.getSessionInfo,
          checkIfActive: deps.checkIfActive,
          updateSkillFileCodeEnvIds: deps.updateSkillFileCodeEnvIds,
          codeExecutionContext: deps.codeExecutionContext,
          rateLimitBudget,
          signal: deps.signal,
        });
        return { skill, result };
      }),
    );
    for (const r of primeResults) {
      if (r.status === 'fulfilled' && r.value.result) {
        for (const f of r.value.result.files) {
          allPrimedFiles.push({
            id: f.id,
            /* `resource_id` is the skill's `_id` — drives codeapi's
             * sessionKey re-derivation. See cachedFiles above for the
             * full id-vs-resource_id rationale. */
            resource_id: r.value.skill._id.toString(),
            name: f.name,
            storage_session_id: f.storage_session_id,
            kind: 'skill',
            version: r.value.skill.version,
          });
        }
      } else if (r.status === 'rejected') {
        if (isContentFilterError(r.reason) || isAbortError(r.reason)) {
          throw r.reason;
        }
        logger.warn(
          '[primeInvokedSkills] Failed to prime skill files:',
          getSafeErrorMetadata(r.reason),
        );
      } else {
        /* Fulfilled-null: primeSkillFiles swallowed an upload failure (429,
         * partial batch). The run proceeds without this skill's files. */
        logger.warn(
          `[primeInvokedSkills] Priming returned no files for skill "${r.value.skill.name}"`,
        );
      }
    }

    if (allPrimedFiles.length > 0) {
      sessions = new Map();
      /* `session_id` at the top of CodeSessionContext is the
       * (representative) execution session. Per-file storage is on
       * each file's `storage_session_id`. */
      sessions.set(Constants.EXECUTE_CODE, {
        session_id: allPrimedFiles[0].storage_session_id,
        files: allPrimedFiles,
        lastUpdated: Date.now(),
      } satisfies CodeSessionContext);
    }
  }

  return {
    initialSessions: sessions,
    skills: skills.size > 0 ? skills : undefined,
    skillManifest,
  };
}

/** Primes historical skill files once per selected Code API deployment and
 * seeds only the trusted session partitions that execute on that deployment. */
export async function primeInvokedSkillsForProfiles(
  deps: PrimeInvokedSkillsForProfilesDeps,
): Promise<PrimeInvokedSkillsResult> {
  if (deps.executionProfiles.length === 0) {
    return primeInvokedSkills({ ...deps, codeEnvAvailable: false });
  }

  const rateLimitBudget = createCodeApiRateLimitBudget(
    deps.req.config?.endpoints?.agents?.codeApiMaxRetryWaitMs,
  );

  const profileResults = await Promise.all(
    deps.executionProfiles.map(async (profile) => ({
      profile,
      result: await primeInvokedSkills({
        ...deps,
        codeEnvAvailable: true,
        codeExecutionContext: profile.codeExecutionContext,
        updateSkillFileCodeEnvIds: deps.updateSkillFileCodeEnvIds,
        rateLimitBudget,
        signal: deps.signal,
      }),
    })),
  );

  let initialSessions: ToolSessionMap | undefined;
  const skills = new Map<string, string>();
  const skillManifestByName = new Map<
    string,
    NonNullable<PrimeInvokedSkillsResult['skillManifest']>[number]
  >();
  for (const { profile, result } of profileResults) {
    const resultManifestByName = new Map(
      (result.skillManifest ?? []).map((skill) => [skill.name, skill]),
    );
    for (const [name, body] of result.skills ?? []) {
      const identity = resultManifestByName.get(name);
      if (identity == null) {
        throw new Error(`Skill "${name}" resolved without a semantic identity`);
      }
      const existingIdentity = skillManifestByName.get(name);
      const existingBody = skills.get(name);
      if (
        (existingIdentity != null &&
          JSON.stringify(existingIdentity) !== JSON.stringify(identity)) ||
        (existingBody != null && existingBody !== body)
      ) {
        throw new Error(`Skill "${name}" changed while execution profiles were initialized`);
      }
      skills.set(name, body);
      skillManifestByName.set(name, identity);
    }
    const skillFiles = result.initialSessions?.get(Constants.EXECUTE_CODE)?.files;
    if (!skillFiles?.length) {
      continue;
    }
    for (const sessionKey of profile.codeSessionKeys) {
      initialSessions = seedCodeFilesIntoSessions(
        skillFiles as CodeEnvFile[],
        initialSessions,
        sessionKey,
      );
    }
  }

  return {
    initialSessions,
    skills: skills.size > 0 ? skills : undefined,
    skillManifest:
      skillManifestByName.size > 0
        ? [...skillManifestByName.values()].sort((left, right) => left.id.localeCompare(right.id))
        : undefined,
  };
}
