import type { FileSources } from './files';

/**
 * Shared skill validation constants — the single source of truth for name,
 * description, title, body, and file-path length limits. Mirrored by
 * `packages/data-schemas/src/methods/skill.ts`; whenever those constants
 * change, the DB-side validators MUST be updated to match.
 *
 * Exported from `librechat-data-provider` so both frontend form validators
 * and backend Mongoose pre-save hooks use the same literals.
 */
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export const SKILL_DESCRIPTION_SHORT_THRESHOLD = 20;
export const SKILL_DISPLAY_TITLE_MAX_LENGTH = 128;
export const SKILL_BODY_MAX_LENGTH = 100_000;

/**
 * Kebab-case identifier pattern: must start with a lowercase letter or digit,
 * and contain only lowercase letters, digits, and hyphens. Mirrors the
 * backend `SKILL_NAME_PATTERN` in `packages/data-schemas/src/methods/skill.ts`.
 */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Source of a skill — where its canonical definition came from.
 * `inline` means the skill was authored directly in LibreChat.
 * `deployment` means the skill was loaded from the server's configured
 * deployment skill directory and is not persisted as a Skill document.
 * `github` is populated by admin-configured GitHub skill sync; `notion` is reserved.
 */
export type SkillSource = 'inline' | 'deployment' | 'github' | 'notion';

/**
 * Category inferred from a skill file's top-level directory prefix.
 * `script` for `scripts/...`, `reference` for `references/...`, `asset` for `assets/...`,
 * everything else (including root-level files) is `other`.
 */
export type SkillFileCategory = 'script' | 'reference' | 'asset' | 'other';

/** Nested object inside a structured frontmatter key. */
export type SkillFrontmatterObject = { [key: string]: SkillFrontmatterValue | undefined };

/**
 * Allowed value types inside a skill's YAML frontmatter. Scalars cover the
 * documented keys; nested arrays and objects describe the structured ones
 * (`hooks`, `metadata`, `references`), which real `SKILL.md` files write as a
 * list, a list of objects, or a map.
 *
 * Still no `unknown` or `any`: the payload is JSON-safe by construction, and
 * the server bounds depth, string length and array size when validating it.
 */
export type SkillFrontmatterValue =
  | string
  | number
  | boolean
  | null
  | SkillFrontmatterValue[]
  | SkillFrontmatterObject;

/**
 * Structured YAML frontmatter for a skill. All keys are optional on the wire
 * because not every skill document carries a complete frontmatter block —
 * `name` and `description` live as first-class columns on `TSkill` itself,
 * and frontmatter is an extension bag for additional fields like `when-to-use`,
 * `allowed-tools`, etc.
 */
export type SkillFrontmatter = {
  name?: string;
  description?: string;
} & Record<string, SkillFrontmatterValue | undefined>;

/**
 * Provenance metadata for skills that originated from an external source
 * (e.g. a GitHub commit SHA or a Notion page id).
 *
 * Populated by external sync workers with upstream identifiers such as source
 * ids, paths, and commit/blob SHAs.
 */
export type SkillSourceMetadata =
  | Record<string, string | number | boolean>
  | {
      provider: 'github';
      sourceId: string;
      upstreamId: string;
      owner: string;
      repo: string;
      ref: string;
      skillPath: string;
      commitSha?: string;
      skillBlobSha?: string;
      syncedAt?: string;
      syncStatus?: 'synced' | 'failed';
      error?: string;
    };

/**
 * A non-blocking coaching hint surfaced alongside a successful create/update
 * response. Unlike validation errors (which return 400 and block the write),
 * warnings ride on the 2xx response so the UI can show inline feedback
 * without rejecting the user's input. Example: "description is too short,
 * Claude may undertrigger this skill".
 */
export type TSkillWarning = {
  field: string;
  code: string;
  message: string;
  severity: 'warning';
};

/**
 * API shape for a full skill (returned by GET `/api/skills/:id`).
 *
 * Field semantics:
 * - `name` is the machine-readable kebab-case identifier Claude sees in its
 *   skill manifest. It's what drives triggering and must be stable across
 *   edits. Unique per author+tenant.
 * - `displayTitle` is the human-readable UI label only. NOT sent to Claude,
 *   NOT part of the trigger path — purely cosmetic.
 * - `description` is the "when to use this skill" sentence. Highest-leverage
 *   field for trigger accuracy; a short/vague one causes undertriggering.
 * - `frontmatter` is the structured YAML bag minus `name`/`description`
 *   (those live as top-level columns). Known keys receive value validation;
 *   unknown keys are retained and reported as non-blocking warnings.
 * - `source`/`sourceMetadata` identify whether the row is user-authored,
 *   deployment-provided, or mirrored from an external source such as GitHub.
 */
export type TSkill = {
  _id: string;
  name: string;
  displayTitle?: string;
  description: string;
  body: string;
  frontmatter?: SkillFrontmatter;
  category?: string;
  /**
   * @deprecated Replaced by the persisted `userInvocable` /
   * `disableModelInvocation` pair derived from frontmatter. Retained
   * temporarily so older form code that hasn't migrated still type-checks;
   * the backend no longer reads or writes it.
   */
  invocationMode?: import('../types').InvocationMode;
  /**
   * Mirrors the `disable-model-invocation` frontmatter field. `true` means
   * the model can no longer invoke this skill via the `skill` tool and the
   * skill is excluded from the catalog injected into the system prompt.
   * Manual `$` invocation is unaffected.
   */
  disableModelInvocation?: boolean;
  /**
   * Mirrors the `user-invocable` frontmatter field. `false` hides the skill
   * from the `$` popover and rejects manual invocation. Defaults to `true`.
   */
  userInvocable?: boolean;
  /**
   * Skill-declared tool allowlist (mirrors the `allowed-tools` frontmatter
   * field). When the skill is invoked, these tools are unioned into the
   * agent's effective tool set for the turn. Tolerant of unknown names —
   * the runtime intersects against the loaded tool registry, so skills
   * referencing yet-to-be-implemented tools import without breaking.
   */
  allowedTools?: string[];
  author: string;
  authorName: string;
  version: number;
  source: SkillSource;
  sourceMetadata?: SkillSourceMetadata;
  fileCount: number;
  /**
   * When `true`, the skill auto-primes into every turn — no user `$` picks
   * or model discretion required. Surfaced on the list view so the UI can
   * show a pin badge on rows that apply ambiently.
   */
  alwaysApply?: boolean;
  isPublic?: boolean;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Present on POST/PATCH responses when the server emitted non-blocking
   * coaching warnings (e.g. description too short). Never present on GET
   * responses.
   */
  warnings?: TSkillWarning[];
};

/**
 * Summary shape used in list endpoints — omits `body` and `frontmatter` to keep
 * list payloads small. Callers that need the full body/frontmatter must fetch
 * the detail via `GET /api/skills/:id`.
 */
export type TSkillSummary = Omit<TSkill, 'body' | 'frontmatter'>;

/**
 * Metadata for a single file bundled inside a skill.
 * File content itself is fetched separately via the file download endpoint.
 */
export type TSkillFile = {
  _id: string;
  skillId: string;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  source: FileSources;
  mimeType: string;
  bytes: number;
  category: SkillFileCategory;
  isExecutable: boolean;
  author: string;
  tenantId?: string;
  sourceMetadata?: Record<string, string | number | boolean>;
  /** Lazily cached text content (≤ 512 KB). Excluded from list responses. */
  content?: string;
  /** Set on first read. `true` prevents repeated storage reads for non-text files. */
  isBinary?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TGitHubSkillSyncCredentialSummary = {
  provider: 'github';
  credentialKey: string;
  credentialPresent: boolean;
  tokenFingerprint?: string;
  updatedAt?: string;
  createdAt?: string;
};

/** One upstream skill a sync run dropped, with the reason it was dropped. */
export type TGitHubSkillSyncSkippedSkill = {
  path: string;
  name?: string;
  errorCode: string;
  errorMessage: string;
};

/** One upstream file a sync run published a skill without, and why. */
export type TGitHubSkillSyncSkippedFile = {
  path: string;
  skillPath: string;
  errorCode: string;
  errorMessage: string;
};

export type TGitHubSkillSyncSourceStatus = {
  provider: 'github';
  sourceId: string;
  tenantId?: string;
  /** `partial`: some skills published, others were skipped (see `skippedSkills`). */
  status: 'idle' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';
  credentialKey?: string;
  credentialPresent: boolean;
  owner?: string;
  repo?: string;
  ref?: string;
  paths?: string[];
  startedAt?: string;
  finishedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  errorCode?: string;
  errorMessage?: string;
  syncedSkillCount: number;
  syncedFileCount: number;
  deletedSkillCount: number;
  deletedFileCount: number;
  skippedSkillCount: number;
  skippedSkills?: TGitHubSkillSyncSkippedSkill[];
  skippedFileCount: number;
  skippedFiles?: TGitHubSkillSyncSkippedFile[];
  updatedAt?: string;
  createdAt?: string;
};

export type TGitHubSkillSyncStatusResponse = {
  enabled: boolean;
  intervalMinutes: number;
  runOnStartup: boolean;
  sources: TGitHubSkillSyncSourceStatus[];
  credentials: TGitHubSkillSyncCredentialSummary[];
  fineGrainedTokenRecommendation: string;
};

export type TGitHubSkillSyncCredentialUpdateRequest = {
  token: string;
};

export type TGitHubSkillSyncManualRunResponse = {
  status: 'started' | 'skipped' | 'completed' | 'failed';
  message?: string;
  sources?: TGitHubSkillSyncSourceStatus[];
};

/** Request body for POST `/api/skills`. */
export type TCreateSkill = {
  name: string;
  displayTitle?: string;
  description: string;
  body: string;
  frontmatter?: Partial<SkillFrontmatter>;
  category?: string;
  /** When `true`, the skill auto-primes into every turn (mirrors always-apply frontmatter). */
  alwaysApply?: boolean;
};

/** Partial payload for PATCH `/api/skills/:id` — all fields optional. */
export type TUpdateSkillPayload = {
  name?: string;
  displayTitle?: string;
  description?: string;
  body?: string;
  frontmatter?: Partial<SkillFrontmatter>;
  category?: string;
  alwaysApply?: boolean;
};

/** Variables passed into the update mutation: id + expectedVersion + partial payload. */
export type TUpdateSkillVariables = {
  id: string;
  expectedVersion: number;
  payload: TUpdateSkillPayload;
};

/** Response from a successful PATCH — includes the bumped version. */
export type TUpdateSkillResponse = TSkill;

/** Response from a 409 concurrency conflict — includes the current authoritative state. */
export type TSkillConflictResponse = {
  error: 'skill_version_conflict';
  current: TSkill;
};

/** Query params for GET `/api/skills` (list). */
export type TSkillListRequest = {
  category?: string;
  search?: string;
  limit?: number;
  cursor?: string;
};

/** Paginated list response. `after` is the cursor to pass for the next page. */
export type TSkillListResponse = {
  skills: TSkillSummary[];
  has_more: boolean;
  after: string | null;
};

/**
 * Why one archive entry could not be imported. A stable code rather than a
 * message, so the client localizes the reason and server-side storage and
 * database text never reaches the uploader.
 */
export type SkillImportFailureReason =
  /** Path is absolute, traverses, or uses characters skills cannot store. */
  | 'invalid_path'
  /** Entry alone exceeds the per-file decompression limit. */
  | 'file_too_large'
  /** Archive exhausted the cumulative decompression budget at or before this entry. */
  | 'archive_too_large'
  /** Entry no longer matches what content inspection read. */
  | 'archive_entry_changed'
  /** Storage write or database row failed. */
  | 'persistence_failed';

/** One archive entry POST `/api/skills/import` could not persist. */
export type TSkillImportFailedFile = {
  /** Path inside the archive, relative to `SKILL.md`. */
  path: string;
  reason: SkillImportFailureReason;
  /** Limit in MB, when `reason` names a size limit. */
  limitMb?: number;
};

/**
 * Response from a failed `POST /api/skills/import` of an archive.
 *
 * `skill_import_incomplete` (422) means at least one bundled file failed and
 * everything the import created was rolled back. `skill_import_rollback_failed`
 * (500) means the same failure occurred but the partially created skill could
 * not be removed, so it may still be listed and needs deleting by hand.
 * `skill_import_cleanup_incomplete` (500) means the Skill row was removed but
 * dependent database or blob cleanup did not finish.
 */
export type TSkillImportFailedResponse = {
  error:
    | 'skill_import_incomplete'
    | 'skill_import_rollback_failed'
    | 'skill_import_cleanup_incomplete';
  message: string;
  failedFiles: TSkillImportFailedFile[];
  /** Present when the Skill row may remain and should be surfaced for deletion. */
  skillId?: string;
};

/** Response from DELETE `/api/skills/:id`. */
export type TDeleteSkillResponse = {
  id: string;
  deleted: true;
  /** False when the Skill row is gone but a dependent cleanup step needs repair. */
  cleanupComplete?: boolean;
};

/** Response from GET `/api/skills/:id/files`. */
export type TListSkillFilesResponse = {
  files: TSkillFile[];
};

/**
 * Upload body for POST `/api/skills/:id/files`.
 * In phase 1 the backend responds with 501; the client contract is still defined here
 * so hooks are stable when the upload pipeline is wired up in phase 2.
 */
export type TUploadSkillFilePayload = {
  relativePath: string;
};

/** Response from DELETE `/api/skills/:id/files/:relativePath`. */
export type TDeleteSkillFileResponse = {
  skillId: string;
  relativePath: string;
  deleted: true;
};

/** Response from GET `/api/skills/:id/files/:relativePath` (JSON mode). */
export type TSkillFileContentResponse = {
  /** Opaque storage revision for conditional sub-file replacement. Absent on older servers. */
  fileId?: string;
  content?: string;
  mimeType: string;
  isBinary: boolean;
  relativePath: string;
  filename: string;
  bytes: number;
};

/** Variables passed into the skill file upload mutation. */
export type TUploadSkillFileVariables = {
  skillId: string;
  formData: FormData;
};

/** Variables passed into the skill file delete mutation. */
export type TDeleteSkillFileVariables = {
  skillId: string;
  relativePath: string;
};

/**
 * Per-user skill active/inactive overrides (GET response and POST body payload).
 * Key = skill ObjectId string, value = explicit active state.
 * Skills absent from the map use the ownership-based default:
 * owned = active, shared = `defaultActiveOnShare` from config.
 */
export type TSkillStatesResponse = Record<string, boolean>;
