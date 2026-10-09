import {
  ResourceType,
  SkillsScope,
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_DESCRIPTION_SHORT_THRESHOLD as SKILL_DESCRIPTION_SHORT_THRESHOLD_SHARED,
  SKILL_DISPLAY_TITLE_MAX_LENGTH,
  SKILL_BODY_MAX_LENGTH,
  SKILL_NAME_PATTERN as SKILL_NAME_PATTERN_SHARED,
} from 'librechat-data-provider';
import type { CodeEnvRef } from 'librechat-data-provider';
import type { Model, Types, FilterQuery } from 'mongoose';
import type {
  ISkill,
  ISkillDocument,
  ISkillFile,
  ISkillFileDocument,
  ISkillSummary,
} from '~/types/skill';
import type { IAgent } from '~/types/agent';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { isValidObjectIdString } from '~/utils/objectId';
import { stripYamlTrailingComment } from '~/utils/yaml';
import { escapeRegExp } from '~/utils/string';
import logger from '~/config/winston';

/** ---------- Validation helpers (pure) ---------- */

/**
 * A single validation issue emitted by a skill validator. Most issues are
 * errors and block the mutation; some are warnings (e.g. "description is
 * awfully short, the agent may undertrigger the skill") that surface inline
 * coaching without rejecting the request.
 */
export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
  /**
   * Defaults to `'error'` when omitted. Errors cause `createSkill` /
   * `updateSkill` to throw with code `SKILL_VALIDATION_FAILED`; warnings
   * are surfaced on successful responses so the UI can show inline feedback.
   */
  severity?: 'error' | 'warning';
};

export type DeleteSkillCleanupStep = 'agent_allowlists' | 'skill_files' | 'permissions';

export type DeleteSkillResult = {
  /** Whether this call removed the Skill row. */
  deleted: boolean;
  /** Whether the Skill row is absent after this call, including an idempotent retry. */
  skillAbsent: boolean;
  /** Whether every dependent database cleanup step completed. */
  cleanupComplete: boolean;
  failedCleanupSteps: DeleteSkillCleanupStep[];
};

type SkillFileUpsertResult = {
  value: (ISkillFile & { _id: Types.ObjectId }) | null;
  lastErrorObject?: {
    updatedExisting?: boolean;
  };
};

/** Partition an issue list into blocking errors and non-blocking warnings. */
export function partitionIssues(issues: ValidationIssue[]): {
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
} {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const issue of issues) {
    if (issue.severity === 'warning') {
      warnings.push(issue);
    } else {
      errors.push(issue);
    }
  }
  return { errors, warnings };
}

const SKILL_NAME_MAX = SKILL_NAME_MAX_LENGTH;
const SKILL_DESCRIPTION_MAX = SKILL_DESCRIPTION_MAX_LENGTH;
const SKILL_DESCRIPTION_SHORT_THRESHOLD = SKILL_DESCRIPTION_SHORT_THRESHOLD_SHARED;
const SKILL_DISPLAY_TITLE_MAX = SKILL_DISPLAY_TITLE_MAX_LENGTH;
const SKILL_BODY_MAX = SKILL_BODY_MAX_LENGTH;
const SKILL_FILE_PATH_MAX = 500;
const SKILL_NAME_PATTERN = SKILL_NAME_PATTERN_SHARED;
const RELATIVE_PATH_CHARS = /^[a-zA-Z0-9._\-/]+$/;

/**
 * Brand namespaces reserved for Anthropic-published skills and first-party
 * bundles. Matched as prefixes, so `anthropic-helper` is rejected but
 * `research-anthropic-helper` is fine.
 */
const RESERVED_NAME_PREFIXES = ['anthropic-', 'claude-'];

/**
 * Slash-command names that collide with LibreChat / Claude Code CLI commands.
 * A skill with one of these names would shadow a real command in any
 * slash-command UI. Matched exactly (not as prefix).
 */
const RESERVED_NAME_WORDS = new Set([
  'help',
  'clear',
  'compact',
  'model',
  'exit',
  'quit',
  'settings',
  'anthropic',
  'claude',
]);

export function validateSkillName(name: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof name !== 'string' || name.length === 0) {
    issues.push({ field: 'name', code: 'REQUIRED', message: 'Name is required' });
    return issues;
  }
  if (name.length > SKILL_NAME_MAX) {
    issues.push({
      field: 'name',
      code: 'TOO_LONG',
      message: `Name must be ${SKILL_NAME_MAX} characters or less`,
    });
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push({
      field: 'name',
      code: 'INVALID_FORMAT',
      message:
        'Name must be kebab-case: start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens',
    });
  }
  const lowered = name.toLowerCase();
  if (RESERVED_NAME_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    issues.push({
      field: 'name',
      code: 'RESERVED_PREFIX',
      message: `Name cannot start with ${RESERVED_NAME_PREFIXES.map((p) => `"${p}"`).join(' or ')}`,
    });
  }
  if (RESERVED_NAME_WORDS.has(lowered)) {
    issues.push({
      field: 'name',
      code: 'RESERVED_WORD',
      message: `"${name}" is a reserved name`,
    });
  }
  return issues;
}

export function validateSkillDescription(description: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof description !== 'string' || description.trim().length === 0) {
    issues.push({
      field: 'description',
      code: 'REQUIRED',
      message: 'Description is required',
    });
    return issues;
  }
  if (description.length > SKILL_DESCRIPTION_MAX) {
    issues.push({
      field: 'description',
      code: 'TOO_LONG',
      message: `Description must be ${SKILL_DESCRIPTION_MAX} characters or less`,
    });
  }
  if (description.trim().length < SKILL_DESCRIPTION_SHORT_THRESHOLD) {
    issues.push({
      field: 'description',
      code: 'TOO_SHORT',
      severity: 'warning',
      message:
        'Short descriptions may cause the agent to miss triggering opportunities — aim for a concrete "when to use this skill" sentence.',
    });
  }
  return issues;
}

export function validateSkillBody(body: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (body !== undefined && typeof body !== 'string') {
    issues.push({ field: 'body', code: 'INVALID_TYPE', message: 'Body must be a string' });
    return issues;
  }
  if (typeof body === 'string' && body.length > SKILL_BODY_MAX) {
    issues.push({
      field: 'body',
      code: 'TOO_LONG',
      message: `Body must be ${SKILL_BODY_MAX} characters or less`,
    });
  }
  return issues;
}

export function validateSkillDisplayTitle(displayTitle: unknown): ValidationIssue[] {
  if (displayTitle === undefined || displayTitle === null) {
    return [];
  }
  if (typeof displayTitle !== 'string') {
    return [
      { field: 'displayTitle', code: 'INVALID_TYPE', message: 'Display title must be a string' },
    ];
  }
  if (displayTitle.length > SKILL_DISPLAY_TITLE_MAX) {
    return [
      {
        field: 'displayTitle',
        code: 'TOO_LONG',
        message: `Display title must be ${SKILL_DISPLAY_TITLE_MAX} characters or less`,
      },
    ];
  }
  return [];
}

/**
 * Validate the top-level `alwaysApply` column input. Mirrors the boolean
 * check on `frontmatter['always-apply']` so a loosely-typed API caller
 * sending `{"alwaysApply": "false"}` (string) gets a clean 400 at the
 * validation boundary instead of relying on Mongoose casting quirks to
 * coerce the value.
 *
 * `undefined` is the only pass-through value (meaning "don't touch this
 * field"). `null` is rejected: PATCH forwards any non-`undefined` value
 * straight into `$set`, so a `null` payload would persist `null` in a
 * boolean column, leaving the skill in a state that is neither "on" nor
 * "off" while `listAlwaysApplySkills` only matches `true`.
 */
export function validateAlwaysApply(alwaysApply: unknown): ValidationIssue[] {
  if (alwaysApply === undefined) {
    return [];
  }
  if (typeof alwaysApply !== 'boolean') {
    return [
      {
        field: 'alwaysApply',
        code: 'INVALID_TYPE',
        message: 'alwaysApply must be a boolean',
      },
    ];
  }
  return [];
}

/**
 * Known fields allowed inside a skill's YAML frontmatter. Anything else is
 * reported as a warning (see `validateSkillFrontmatter`) rather than rejected:
 * the frontmatter convention keeps growing, and a single unrecognized key in
 * one `SKILL.md` used to fail its whole GitHub sync source. The list is derived
 * from Anthropic's Agent Skills spec plus the fields LibreChat needs to pass
 * through (`name`/`description` are duplicated from the top-level columns
 * because real `SKILL.md` files include them in their frontmatter block).
 */
const ALLOWED_FRONTMATTER_KEYS = new Set<string>([
  'name',
  'description',
  'when-to-use',
  'allowed-tools',
  'arguments',
  'argument-hint',
  'user-invocable',
  'disable-model-invocation',
  'always-apply',
  'alwaysApply',
  'model',
  'effort',
  'context',
  'agent',
  'paths',
  'shell',
  'hooks',
  'version',
  'license',
  'compatibility',
  'metadata',
  'references',
]);

const CANONICAL_FRONTMATTER_KEYS = new Map(
  Array.from(ALLOWED_FRONTMATTER_KEYS, (key) => [key.toLowerCase(), key]),
);

export function getCanonicalSkillFrontmatterKey(key: string): string | undefined {
  return CANONICAL_FRONTMATTER_KEYS.get(key.toLowerCase());
}

export function normalizeSkillFrontmatterKeys(
  frontmatter: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { error: string } {
  const normalized = Object.create(null) as Record<string, unknown>;
  const recognizedKeys = new Map<string, string>();
  for (const [key, value] of Object.entries(frontmatter)) {
    const canonicalKey = getCanonicalSkillFrontmatterKey(key);
    if (canonicalKey) {
      const previousKey = recognizedKeys.get(canonicalKey);
      if (previousKey) {
        return {
          error: `Recognized frontmatter keys "${previousKey}" and "${key}" both resolve to "${canonicalKey}"`,
        };
      }
      recognizedKeys.set(canonicalKey, key);
    }
    normalized[canonicalKey ?? key] = value;
  }
  return { frontmatter: normalized };
}

const FRONTMATTER_MAX_STRING = 2000;
const FRONTMATTER_MAX_ARRAY = 100;
const FRONTMATTER_MAX_DEPTH = 4;
const NON_PERSISTABLE_FRONTMATTER_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type FrontmatterKind = 'string' | 'number' | 'boolean' | 'stringArray';

const FRONTMATTER_KIND: Record<string, FrontmatterKind | FrontmatterKind[]> = {
  name: 'string',
  description: 'string',
  'when-to-use': 'string',
  'allowed-tools': ['string', 'stringArray'],
  arguments: ['string', 'stringArray'],
  'argument-hint': 'string',
  'user-invocable': 'boolean',
  'disable-model-invocation': 'boolean',
  'always-apply': 'boolean',
  alwaysApply: 'boolean',
  model: 'string',
  effort: ['string', 'number'],
  context: 'string',
  agent: 'string',
  paths: ['string', 'stringArray'],
  shell: 'string',
  version: 'string',
  license: 'string',
  compatibility: 'string',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isValidFrontmatterKey(key: string): boolean {
  return !key.includes('\u0000') && !NON_PERSISTABLE_FRONTMATTER_KEYS.has(key);
}

function containsInvalidFrontmatterKey(value: unknown, depth = 0): boolean {
  if (depth > FRONTMATTER_MAX_DEPTH) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((nestedValue) => containsInvalidFrontmatterKey(nestedValue, depth + 1));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nestedValue]) =>
      !isValidFrontmatterKey(key) || containsInvalidFrontmatterKey(nestedValue, depth + 1),
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= FRONTMATTER_MAX_ARRAY &&
    value.every((v) => typeof v === 'string' && v.length <= FRONTMATTER_MAX_STRING)
  );
}

function matchesKind(value: unknown, kind: FrontmatterKind): boolean {
  if (kind === 'string') {
    return typeof value === 'string' && value.length <= FRONTMATTER_MAX_STRING;
  }
  if (kind === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (kind === 'boolean') {
    return typeof value === 'boolean';
  }
  return isStringArray(value);
}

/**
 * Shallow structural sanity check for `hooks`/`metadata` objects. We don't
 * know their full schema yet, so we just verify they are plain objects with
 * JSON-serializable leaf values up to a max depth — enough to block pathological
 * payloads without constraining legitimate frontmatter extensions.
 */
function isJsonSafe(value: unknown, depth: number): boolean {
  if (depth > FRONTMATTER_MAX_DEPTH) {
    return false;
  }
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string') return (value as string).length <= FRONTMATTER_MAX_STRING;
  if (t === 'number') return Number.isFinite(value);
  if (t === 'boolean') return true;
  if (Array.isArray(value)) {
    if (value.length > FRONTMATTER_MAX_ARRAY) return false;
    return value.every((v) => isJsonSafe(v, depth + 1));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).every(
      ([key, nestedValue]) => isValidFrontmatterKey(key) && isJsonSafe(nestedValue, depth + 1),
    );
  }
  return false;
}

/**
 * Validate a skill's structured YAML frontmatter. Known keys are type-checked
 * against `FRONTMATTER_KIND`; `hooks`, `metadata` and `references` fall back to
 * a shallow JSON-safety check because their full schemas live outside this
 * module. Unknown keys are reported as warnings, not errors: authors regularly
 * carry keys from other tooling, and failing the skill for one of them takes
 * down every other skill in the same GitHub sync source.
 */
export function validateSkillFrontmatter(frontmatter: unknown): ValidationIssue[] {
  if (frontmatter === undefined || frontmatter === null) {
    return [];
  }
  if (!isPlainObject(frontmatter)) {
    return [
      {
        field: 'frontmatter',
        code: 'INVALID_TYPE',
        message: 'Frontmatter must be a plain object',
      },
    ];
  }

  const normalized = normalizeSkillFrontmatterKeys(frontmatter);
  if ('error' in normalized) {
    return [
      {
        field: 'frontmatter',
        code: 'DUPLICATE_KEY',
        message: normalized.error,
      },
    ];
  }

  const issues: ValidationIssue[] = [];
  for (const [key, value] of Object.entries(normalized.frontmatter)) {
    if (!isValidFrontmatterKey(key)) {
      issues.push({
        field: 'frontmatter',
        code: 'INVALID_KEY',
        message: 'Frontmatter keys must be persistable object property names',
      });
      continue;
    }
    if (containsInvalidFrontmatterKey(value)) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'INVALID_KEY',
        message: `"${key}" contains a frontmatter key that cannot be persisted`,
      });
      continue;
    }
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'UNKNOWN_KEY',
        severity: 'warning',
        message: `"${key}" is not a recognized frontmatter key and is stored as-is`,
      });
      /* The key is tolerated, its value still is not: an unrecognized key is
         persisted, so it stays inside the same depth, array and string bounds
         every structured key is held to. */
      if (!isJsonSafe(value, 0)) {
        issues.push({
          field: `frontmatter.${key}`,
          code: 'INVALID_SHAPE',
          message: `"${key}" must be a JSON-safe value (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING}, max array ${FRONTMATTER_MAX_ARRAY})`,
        });
      }
      continue;
    }

    if (key === 'references') {
      if (!isJsonSafe(value, 0)) {
        issues.push({
          field: 'frontmatter.references',
          code: 'INVALID_SHAPE',
          message: `"references" must be a JSON-safe value (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING})`,
        });
      }
      continue;
    }

    if (key === 'hooks' || key === 'metadata') {
      if (!isPlainObject(value) || !isJsonSafe(value, 0)) {
        issues.push({
          field: `frontmatter.${key}`,
          code: 'INVALID_SHAPE',
          message: `"${key}" must be a plain JSON-safe object (max depth ${FRONTMATTER_MAX_DEPTH}, max string ${FRONTMATTER_MAX_STRING})`,
        });
      }
      continue;
    }

    const expected = FRONTMATTER_KIND[key];
    if (!expected) {
      continue;
    }
    const kinds = Array.isArray(expected) ? expected : [expected];
    if (!kinds.some((kind) => matchesKind(value, kind))) {
      issues.push({
        field: `frontmatter.${key}`,
        code: 'INVALID_TYPE',
        message: `"${key}" must be ${kinds.join(' or ')}`,
      });
    }
  }
  return issues;
}

export function validateRelativePath(relativePath: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    issues.push({
      field: 'relativePath',
      code: 'REQUIRED',
      message: 'Relative path is required',
    });
    return issues;
  }
  if (relativePath.length > SKILL_FILE_PATH_MAX) {
    issues.push({
      field: 'relativePath',
      code: 'TOO_LONG',
      message: `Relative path must be ${SKILL_FILE_PATH_MAX} characters or less`,
    });
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    issues.push({
      field: 'relativePath',
      code: 'ABSOLUTE_PATH',
      message: 'Relative path must not start with a slash',
    });
  }
  if (!RELATIVE_PATH_CHARS.test(relativePath)) {
    issues.push({
      field: 'relativePath',
      code: 'INVALID_CHARS',
      message: 'Relative path contains invalid characters',
    });
  }
  const segments = relativePath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    issues.push({
      field: 'relativePath',
      code: 'TRAVERSAL',
      message: 'Relative path cannot contain empty segments or "." / ".."',
    });
  }
  if (relativePath === 'SKILL.md' || segments[0] === 'SKILL.md') {
    issues.push({
      field: 'relativePath',
      code: 'RESERVED',
      message: 'SKILL.md is managed via the skill body, not file uploads',
    });
  }
  return issues;
}

export function inferSkillFileCategory(
  relativePath: string,
): 'script' | 'reference' | 'asset' | 'other' {
  const [top] = relativePath.split('/');
  if (top === 'scripts') return 'script';
  if (top === 'references') return 'reference';
  if (top === 'assets') return 'asset';
  return 'other';
}

/** ---------- Method factory ---------- */

export interface SkillDeps {
  /** Removes all ACL entries for a resource. Injected from PermissionService. */
  removeAllPermissions: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
}

export type CreateSkillInput = {
  name: string;
  displayTitle?: string;
  description: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  category?: string;
  author: Types.ObjectId;
  authorName: string;
  source?: 'inline' | 'github' | 'notion';
  sourceMetadata?: Record<string, unknown>;
  /**
   * When `true`, the skill is auto-primed into every turn. Callers pass this
   * through alongside `frontmatter` so the boolean lands on both the indexed
   * first-class column (queryable) and the raw frontmatter bag (inspectable).
   */
  alwaysApply?: boolean;
  tenantId?: string;
};

export type UpdateSkillInput = {
  name?: string;
  displayTitle?: string;
  description?: string;
  body?: string;
  frontmatter?: Record<string, unknown>;
  category?: string;
  alwaysApply?: boolean;
  source?: 'inline' | 'github' | 'notion';
  sourceMetadata?: Record<string, unknown>;
};

export type GetAuthorSkillByNameParams = {
  name: string;
  author: Types.ObjectId | string;
  tenantId?: string | null;
};

/**
 * Maps the runtime-enforced frontmatter fields onto their first-class
 * column equivalents. Returns only the keys that were explicitly set on the
 * frontmatter so callers can decide whether to write `undefined` (skip the
 * `$set`) versus a concrete value.
 *
 * `allowed-tools` accepts string or string[] per the validator; both are
 * normalized to an array. Empty strings are filtered out so a stray comma
 * in YAML doesn't leak through as `''`.
 */
export function deriveStructuredFrontmatterFields(
  frontmatter: Record<string, unknown> | undefined,
): {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string[];
} {
  if (!frontmatter || typeof frontmatter !== 'object') {
    return {};
  }
  const normalized = normalizeSkillFrontmatterKeys(frontmatter);
  if ('error' in normalized) {
    return {};
  }
  frontmatter = normalized.frontmatter;
  const derived: {
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
    allowedTools?: string[];
  } = {};
  const disableModelInvocationRaw = frontmatter['disable-model-invocation'];
  if (typeof disableModelInvocationRaw === 'boolean') {
    derived.disableModelInvocation = disableModelInvocationRaw;
  }
  const userInvocableRaw = frontmatter['user-invocable'];
  if (typeof userInvocableRaw === 'boolean') {
    derived.userInvocable = userInvocableRaw;
  }
  const allowedToolsRaw = frontmatter['allowed-tools'];
  if (typeof allowedToolsRaw === 'string') {
    /**
     * YAML scalars like `allowed-tools: web_search` are parsed as a single
     * string. Wrap into a one-element array; we deliberately do NOT split
     * on commas — the validator already accepts string-array form and
     * trying to "be helpful" by splitting `"web_search, file_search"`
     * would silently invent semantics the spec doesn't promise.
     */
    if (allowedToolsRaw.length > 0) {
      derived.allowedTools = [allowedToolsRaw];
    }
  } else if (Array.isArray(allowedToolsRaw)) {
    derived.allowedTools = allowedToolsRaw.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
  }
  return derived;
}

/**
 * Read-time fallback for skills authored before the structured columns
 * existed: if the column is unset but the matching key is present in
 * `frontmatter`, fill the column in on the returned object so downstream
 * runtime checks (`skill.userInvocable === false`,
 * `skill.disableModelInvocation === true`, `skill.allowedTools`) behave
 * the same way they would for a freshly-created skill.
 *
 * Side-effect-free w.r.t. the DB (no writes), but mutates its argument
 * in place and returns the same reference. Callers passing a `lean()`
 * doc this is fine — the doc is a fresh JS object owned by the caller.
 * When the skill is next updated, `updateSkill` re-derives and persists
 * the columns naturally, so this fallback gradually becomes a no-op.
 *
 * Skills with the columns already populated short-circuit to no-op.
 */
export function backfillDerivedFromFrontmatter<
  T extends {
    frontmatter?: Record<string, unknown>;
    disableModelInvocation?: boolean;
    userInvocable?: boolean;
    allowedTools?: string[];
  },
>(skill: T | null): T | null {
  if (!skill || !skill.frontmatter) {
    return skill;
  }
  const derived = deriveStructuredFrontmatterFields(skill.frontmatter);
  if (skill.disableModelInvocation === undefined && derived.disableModelInvocation !== undefined) {
    skill.disableModelInvocation = derived.disableModelInvocation;
  }
  if (skill.userInvocable === undefined && derived.userInvocable !== undefined) {
    skill.userInvocable = derived.userInvocable;
  }
  if (skill.allowedTools === undefined && derived.allowedTools !== undefined) {
    skill.allowedTools = derived.allowedTools;
  }
  return skill;
}

function getAlwaysApplyFrontmatterValue(
  frontmatter: Record<string, unknown> | undefined,
): boolean | undefined {
  const canonical = frontmatter?.['always-apply'];
  if (typeof canonical === 'boolean') {
    return canonical;
  }
  const camelAlias = frontmatter?.alwaysApply;
  if (typeof camelAlias === 'boolean') {
    return camelAlias;
  }
  return undefined;
}

export type UpsertSkillFileInput = {
  /** When supplied, replace only this stored revision; never recreate a deleted file. */
  expectedFileId?: string;
  /** Insert only when the path is absent, even if another writer creates it first. */
  createOnly?: boolean;
  skillId: Types.ObjectId | string;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  source: string;
  sourceMetadata?: Record<string, unknown>;
  mimeType: string;
  bytes: number;
  isExecutable?: boolean;
  author: Types.ObjectId | string;
  tenantId?: string;
};

export type ListSkillsByAccessParams = {
  /** Trusted capability-authorized tenant scope; never accept directly from client input. */
  manageTenantId?: string;
  accessibleIds: Types.ObjectId[];
  category?: string;
  search?: string;
  limit: number;
  cursor?: string | null;
};

export type ListSkillsByAccessResult = {
  /**
   * Summary rows — `body` and `frontmatter` are intentionally omitted at the
   * query projection layer to keep list payloads small. Callers that need the
   * full document must fetch the detail via `getSkillById`.
   */
  skills: Array<ISkillSummary & { _id: Types.ObjectId }>;
  has_more: boolean;
  after: string | null;
};

export type ListAlwaysApplySkillsParams = {
  accessibleIds: Types.ObjectId[];
  /** Max rows to return per page. The caller paginates to fill an active-state budget. */
  limit: number;
  /** Opaque cursor from a prior page. `null` / absent = first page. */
  cursor?: string | null;
};

export type ListAlwaysApplySkillsResult = {
  /**
   * Rows for `alwaysApply: true` skills within `accessibleIds` on this page.
   * Returns `body` eagerly — callers prime the full SKILL.md on every turn,
   * so round-tripping through `getSkillById` per skill would double DB ops.
   */
  skills: Array<{
    _id: Types.ObjectId;
    name: string;
    body: string;
    author: Types.ObjectId;
    frontmatter?: Record<string, unknown>;
    allowedTools?: string[];
    version: number;
  }>;
  /** `true` when another page exists beyond this one. */
  has_more: boolean;
  /** Cursor for the next page, or `null` when `has_more` is `false`. */
  after: string | null;
};

export type UpdateSkillResult =
  | {
      status: 'updated';
      skill: ISkill & { _id: Types.ObjectId };
      warnings: ValidationIssue[];
    }
  | { status: 'conflict'; current: ISkill & { _id: Types.ObjectId } }
  | { status: 'not_found' };

export type CreateSkillResult = {
  skill: ISkill & { _id: Types.ObjectId };
  warnings: ValidationIssue[];
};

type BodyAlwaysApplyResult =
  | { status: 'absent' }
  | { status: 'valid'; value: boolean }
  | { status: 'invalid' };

/**
 * Extractor for the `always-apply` / `alwaysApply` flag sitting inside a SKILL.md body's
 * YAML frontmatter block. The REST edit flow lets users rewrite the full
 * SKILL.md text via `update.body` without a structured `frontmatter`
 * object, so this is the only signal we have for "user flipped
 * `always-apply:` or `alwaysApply:` inline in their editor".
 *
 * Returns a discriminated union so callers can tell:
 *  - `absent` — no always-apply key (leave column alone; could be
 *    "user removed the flag" or "user hasn't written it yet" — both
 *    resolve to no-op). An empty value (`always-apply:` with nothing
 *    after the colon) is also treated as absent to allow mid-edit
 *    placeholder states without rejecting a save.
 *  - `valid` — parsed cleanly as `true` / `false` (case-insensitive,
 *    quote-tolerant, YAML inline-comment-tolerant).
 *  - `invalid` — key is present with a non-empty value that isn't a
 *    recognizable boolean (e.g. `tru`, `yes`, `1`). Validation rejects
 *    this rather than silently ignoring so `always-apply: tru` typos
 *    surface as 400s instead of drifting the column from what the
 *    saved SKILL.md text says. When both forms are present, the canonical
 *    `always-apply` form wins because existing files may already rely on it.
 */
function extractAlwaysApplyFromBody(body: string | undefined): BodyAlwaysApplyResult {
  if (typeof body !== 'string' || body.length === 0) {
    return { status: 'absent' };
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith('---')) {
    return { status: 'absent' };
  }
  const after = trimmed.slice(3);
  const closingIdx = after.indexOf('\n---');
  if (closingIdx === -1) {
    return { status: 'absent' };
  }
  const block = after.slice(0, closingIdx);
  let aliasResult: BodyAlwaysApplyResult | undefined;
  for (const line of block.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== 'always-apply' && normalizedKey !== 'alwaysapply') {
      continue;
    }
    // Strip the YAML inline comment BEFORE unquoting — a line like
    // `always-apply: "true" # note` has both, and if we only handled
    // whole-line quoting first, the quoted branch wouldn't match and
    // the comment-strip would leave `"true"` which parses as invalid.
    let value = stripYamlTrailingComment(line.slice(colon + 1).trim()).trim();
    if (value === '') {
      const result: BodyAlwaysApplyResult = { status: 'absent' };
      if (normalizedKey === 'always-apply') {
        return result;
      }
      aliasResult = result;
      continue;
    }
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value[value.length - 1] === '"') ||
        (value[0] === "'" && value[value.length - 1] === "'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.trim();
    if (value === '') {
      const result: BodyAlwaysApplyResult = { status: 'absent' };
      if (normalizedKey === 'always-apply') {
        return result;
      }
      aliasResult = result;
      continue;
    }
    const lowered = value.toLowerCase();
    let result: BodyAlwaysApplyResult;
    if (lowered === 'true') {
      result = { status: 'valid', value: true };
    } else if (lowered === 'false') {
      result = { status: 'valid', value: false };
    } else {
      result = { status: 'invalid' };
    }
    if (normalizedKey === 'always-apply') {
      return result;
    }
    aliasResult = result;
  }
  return aliasResult ?? { status: 'absent' };
}

/**
 * Resolve the effective `alwaysApply` boolean for a create/update call.
 *
 * The indexed `alwaysApply` column is the source of truth for auto-priming
 * queries; it can also be carried inline inside the SKILL.md `body` or in
 * the structured `frontmatter` bag. All three surfaces must stay in sync
 * or a skill edit that flips `always-apply:` in the body would leave the
 * column stale and the UI / auto-priming query would use the old value.
 *
 * Precedence:
 *  1. An explicit top-level `alwaysApply` wins (caller overrides).
 *  2. Otherwise, derive from `frontmatter['always-apply']` or the accepted
 *     alias `frontmatter.alwaysApply` when either is a strict boolean.
 *  3. Otherwise, parse `always-apply:` / `alwaysApply:` out of the SKILL.md body
 *     frontmatter block (covers the UI edit flow that sends only
 *     `body` without a structured `frontmatter` object).
 *  4. Otherwise, return `fallback` (typically `false` on create, or the
 *     current column value on update so an update that doesn't touch
 *     any of the three sources leaves the column alone).
 */
function resolveAlwaysApplyFromInput(
  explicit: boolean | undefined,
  frontmatter: Record<string, unknown> | undefined,
  body: string | undefined,
  fallback: boolean,
  /* Callers that have already parsed the body (e.g. because they also
     ran body-level validation) can thread the result in to avoid a
     second parse. Leave undefined to let the helper parse on demand. */
  precomputedBody?: BodyAlwaysApplyResult,
): boolean {
  if (typeof explicit === 'boolean') {
    return explicit;
  }
  const fromFrontmatter = getAlwaysApplyFrontmatterValue(frontmatter);
  if (typeof fromFrontmatter === 'boolean') {
    return fromFrontmatter;
  }
  const fromBody = precomputedBody ?? extractAlwaysApplyFromBody(body);
  if (fromBody.status === 'valid') {
    return fromBody.value;
  }
  return fallback;
}

/**
 * Narrows candidate skill ids to those backed by an existing Skill doc or
 * recognized by an injected external skill registry.
 * Existence-only check (no ACL) so pruning an agent allowlist never drops
 * skills the saving user merely can't view. Preserves input order, dedupes,
 * and drops malformed ids — they can't reference anything. Candidates are
 * lowercased before comparison: `isValidObjectIdString` accepts uppercase
 * hex, but `_id.toString()` is always lowercase, and a casing mismatch
 * would silently drop a valid id (and an emptied allowlist means the full
 * catalog — the opposite of the configured scope).
 */
export async function filterExistingSkillIds(
  mongoose: typeof import('mongoose'),
  skillIds: string[],
  isExternalSkillId?: (id: string) => boolean,
): Promise<string[]> {
  const candidates = [
    ...new Set(skillIds.filter(isValidObjectIdString).map((id) => id.toLowerCase())),
  ];
  if (candidates.length === 0) {
    return [];
  }
  const Skill = mongoose.models.Skill as Model<ISkillDocument>;
  const docs = await Skill.find(
    { _id: { $in: candidates.map((id) => new mongoose.Types.ObjectId(id)) } },
    { _id: 1 },
  ).lean<Array<{ _id: Types.ObjectId }>>();
  const existing = new Set(docs.map((doc) => doc._id.toString()));
  return candidates.filter((id) => existing.has(id) || isExternalSkillId?.(id) === true);
}

/**
 * Validate the `always-apply` value that would be derived from the
 * SKILL.md body's inline frontmatter. Only reports an issue when the
 * key is present with an unparseable value — absent / valid / empty
 * all pass silently so mid-edit saves that haven't touched the flag
 * yet don't get rejected. Wired into both `createSkill` and
 * `updateSkill` so a body PATCH carrying `always-apply: tru` (typo)
 * surfaces as 400 instead of drifting the indexed column.
 */
export function validateAlwaysApplyInBody(body: string | undefined): ValidationIssue[] {
  const result = extractAlwaysApplyFromBody(body);
  if (result.status === 'invalid') {
    return [
      {
        field: 'body.frontmatter.alwaysApply',
        code: 'INVALID_TYPE',
        message:
          '"always-apply" or "alwaysApply" in SKILL.md frontmatter must be a boolean (true or false)',
      },
    ];
  }
  return [];
}

export function createSkillMethods(
  mongoose: typeof import('mongoose'),
  deps: SkillDeps,
): {
  createSkill: (data: CreateSkillInput) => Promise<CreateSkillResult>;
  getSkillById: (id: string | Types.ObjectId) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  getSkillByName: (
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: {
      /**
       * Manual paths (`$` popover, always-apply once Phase 5 lands) set
       * this so a same-name newer `userInvocable: false` duplicate can't
       * shadow the older user-invocable doc the popover surfaced.
       * Disable-model-invocation status is irrelevant here — manually-
       * primed disabled skills are explicitly supported (iter 4).
       */
      preferUserInvocable?: boolean;
      /**
       * Model paths (`skill` / `read_file` tool handlers) set this so a
       * same-name newer `disable-model-invocation: true` duplicate can't
       * shadow the cataloged model-invocable doc. User-invocability is
       * irrelevant here — `userInvocable: false` skills are model-only
       * and remain valid model-invocation targets.
       *
       * Both flags fall back to the newest match when no preferred doc
       * exists, so handlers can still fire their explicit-rejection
       * error paths (e.g. "cannot be invoked by the model" in the
       * disabled-only case).
       */
      preferModelInvocable?: boolean;
    },
  ) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  getAuthorSkillByName: (
    params: GetAuthorSkillByNameParams,
  ) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsByAccess: (params: ListSkillsByAccessParams) => Promise<ListSkillsByAccessResult>;
  listAlwaysApplySkills: (
    params: ListAlwaysApplySkillsParams,
  ) => Promise<ListAlwaysApplySkillsResult>;
  updateSkill: (params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }) => Promise<UpdateSkillResult>;
  deleteSkill: (id: string) => Promise<DeleteSkillResult>;
  deleteUserSkills: (userId: Types.ObjectId | string) => Promise<number>;
  findSkillBySourceIdentity: (params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }) => Promise<(ISkill & { _id: Types.ObjectId }) | null>;
  listSkillsBySource: (params: {
    source: 'github' | 'notion';
    sourceId: string;
  }) => Promise<Array<ISkill & { _id: Types.ObjectId }>>;
  listSkillFiles: (
    skillId: Types.ObjectId | string,
  ) => Promise<Array<ISkillFile & { _id: Types.ObjectId }>>;
  upsertSkillFile: (row: UpsertSkillFileInput) => Promise<ISkillFile & { _id: Types.ObjectId }>;
  deleteSkillFile: (
    skillId: Types.ObjectId | string,
    relativePath: string,
  ) => Promise<{ deleted: boolean }>;
  getSkillFileByPath: (
    skillId: Types.ObjectId | string,
    relativePath: string,
  ) => Promise<(ISkillFile & { _id: Types.ObjectId }) | null>;
  updateSkillFileContent: (
    skillId: Types.ObjectId | string,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ) => Promise<void>;
  updateSkillFileCodeEnvIds: (
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ) => Promise<{ matchedCount: number; modifiedCount: number }>;
} {
  const { ObjectId } = mongoose.Types;

  function buildSkillFilter(
    params: Pick<
      ListSkillsByAccessParams,
      'accessibleIds' | 'category' | 'search' | 'manageTenantId'
    >,
  ): FilterQuery<ISkillDocument> {
    const filter: FilterQuery<ISkillDocument> = params.manageTenantId
      ? { tenantId: params.manageTenantId }
      : { _id: { $in: params.accessibleIds } };
    if (params.category && params.category.length > 0) {
      filter.category = params.category;
    }
    if (params.search && params.search.length > 0) {
      const rx = new RegExp(escapeRegExp(params.search), 'i');
      filter.$or = [{ name: rx }, { description: rx }, { displayTitle: rx }];
    }
    return filter;
  }

  function decodeCursor(
    cursor: string | null | undefined,
  ): { updatedAt: Date; _id: Types.ObjectId } | null {
    if (!cursor || cursor === 'undefined' || cursor === 'null') {
      return null;
    }
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        updatedAt?: string;
        _id?: string;
      };
      if (
        !decoded.updatedAt ||
        !decoded._id ||
        Number.isNaN(new Date(decoded.updatedAt).getTime()) ||
        !isValidObjectIdString(decoded._id)
      ) {
        return null;
      }
      return { updatedAt: new Date(decoded.updatedAt), _id: new ObjectId(decoded._id) };
    } catch (error) {
      logger.warn(`[skill.decodeCursor] Invalid cursor: ${(error as Error).message}`);
      return null;
    }
  }

  function encodeCursor(row: { updatedAt: Date; _id: Types.ObjectId }): string {
    return Buffer.from(
      JSON.stringify({ updatedAt: row.updatedAt.toISOString(), _id: row._id.toString() }),
    ).toString('base64');
  }

  async function createSkill(data: CreateSkillInput): Promise<CreateSkillResult> {
    const normalizedFrontmatter = isPlainObject(data.frontmatter)
      ? normalizeSkillFrontmatterKeys(data.frontmatter)
      : undefined;
    const frontmatter =
      normalizedFrontmatter && 'frontmatter' in normalizedFrontmatter
        ? normalizedFrontmatter.frontmatter
        : data.frontmatter;
    const bodyIssues = validateSkillBody(data.body);
    /* Parse body's always-apply status once — reused for validation
       (below) and derivation in `resolveAlwaysApplyFromInput`. Avoids
       parsing the same YAML frontmatter block twice per create. */
    const bodyAlwaysApply =
      bodyIssues.length === 0 && data.body !== undefined
        ? extractAlwaysApplyFromBody(data.body)
        : undefined;
    const issues: ValidationIssue[] = [
      ...validateSkillName(data.name),
      ...validateSkillDescription(data.description),
      ...bodyIssues,
      ...validateSkillDisplayTitle(data.displayTitle),
      ...validateSkillFrontmatter(frontmatter),
      ...validateAlwaysApply(data.alwaysApply),
    ];
    /* Body-level `always-apply:` only needs to be well-formed when a
       higher-precedence source won't override it (see
       `resolveAlwaysApplyFromInput` for the cascade). A caller sending
       an explicit top-level `alwaysApply` or a structured
       an always-apply value in structured `frontmatter` has the body value overridden at
       derivation time, so rejecting them for a typo they aren't relying
       on would be user-hostile. */
    if (
      bodyAlwaysApply?.status === 'invalid' &&
      typeof data.alwaysApply !== 'boolean' &&
      getAlwaysApplyFrontmatterValue(frontmatter) === undefined
    ) {
      issues.push({
        field: 'body.frontmatter.alwaysApply',
        code: 'INVALID_TYPE',
        message:
          '"always-apply" or "alwaysApply" in SKILL.md frontmatter must be a boolean (true or false)',
      });
    }
    const { errors, warnings } = partitionIssues(issues);
    if (errors.length > 0) {
      const error = new Error('Skill validation failed');
      (error as Error & { issues?: ValidationIssue[]; code?: string }).issues = errors;
      (error as Error & { code?: string }).code = 'SKILL_VALIDATION_FAILED';
      throw error;
    }

    const Skill = mongoose.models.Skill as Model<ISkillDocument>;

    // Application-level uniqueness check on (name, author, tenantId).
    // The unique index in the schema is the persistent guarantee, but Mongoose
    // creates indexes asynchronously and tests can race ahead of index creation,
    // so we also enforce it here for deterministic behavior and a clean error.
    const existing = await Skill.findOne({
      name: data.name,
      author: data.author,
      tenantId: data.tenantId ?? null,
    })
      .select('_id')
      .lean();
    if (existing) {
      const error = new Error(`A skill with name "${data.name}" already exists for this author`);
      (error as Error & { code?: string | number }).code = 11000;
      throw error;
    }

    const derived = deriveStructuredFrontmatterFields(frontmatter);
    const doc = await Skill.create({
      name: data.name,
      displayTitle: data.displayTitle,
      description: data.description,
      body: data.body ?? '',
      frontmatter: frontmatter ?? {},
      category: data.category ?? '',
      author: data.author,
      authorName: data.authorName,
      version: 1,
      source: data.source ?? 'inline',
      sourceMetadata: data.sourceMetadata,
      fileCount: 0,
      alwaysApply: resolveAlwaysApplyFromInput(
        data.alwaysApply,
        frontmatter,
        data.body,
        false,
        bodyAlwaysApply,
      ),
      tenantId: data.tenantId,
      ...derived,
    });
    return {
      skill: doc.toObject() as unknown as ISkill & { _id: Types.ObjectId },
      warnings,
    };
  }

  async function getSkillById(
    id: string | Types.ObjectId,
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    if (typeof id === 'string' && !isValidObjectIdString(id)) {
      return null;
    }
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const doc = await Skill.findById(id).lean();
    return (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null;
  }

  async function getSkillByName(
    name: string,
    accessibleIds: Types.ObjectId[],
    options?: {
      /**
       * Manual paths (`$` popover, always-apply once Phase 5 lands) set
       * this so a same-name newer `userInvocable: false` duplicate can't
       * shadow the older user-invocable doc the popover surfaced.
       * Disable-model-invocation status is irrelevant here — manually-
       * primed disabled skills are explicitly supported (iter 4).
       */
      preferUserInvocable?: boolean;
      /**
       * Model paths (`skill` / `read_file` tool handlers) set this so a
       * same-name newer `disable-model-invocation: true` duplicate can't
       * shadow the cataloged model-invocable doc. User-invocability is
       * irrelevant here — `userInvocable: false` skills are model-only
       * and remain valid model-invocation targets.
       *
       * Both flags fall back to the newest match when no preferred doc
       * exists, so handlers can still fire their explicit-rejection
       * error paths (e.g. "cannot be invoked by the model" in the
       * disabled-only case).
       */
      preferModelInvocable?: boolean;
    },
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const preferUserInvocable = options?.preferUserInvocable === true;
    const preferModelInvocable = options?.preferModelInvocable === true;
    /* Single-doc fast path when no preference is requested — preserves
       the previous performance characteristics for callers that just
       want "newest match". */
    if (!preferUserInvocable && !preferModelInvocable) {
      const doc = await Skill.findOne({ name, _id: { $in: accessibleIds } })
        .sort({ updatedAt: -1 })
        .lean();
      return backfillDerivedFromFrontmatter(
        (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null,
      );
    }
    /* Multi-doc path: fetch all matching docs (typically 1, rarely 2+
       across same-name duplicates) and pick the first satisfying the
       caller's preference; fall back to newest. */
    const docs = (await Skill.find({ name, _id: { $in: accessibleIds } })
      .sort({ updatedAt: -1 })
      .lean()) as unknown as Array<ISkill & { _id: Types.ObjectId }>;
    if (docs.length === 0) {
      return null;
    }
    for (const doc of docs) {
      backfillDerivedFromFrontmatter(doc);
    }
    const preferred = docs.find((d) => {
      if (preferUserInvocable && d.userInvocable === false) {
        return false;
      }
      if (preferModelInvocable && d.disableModelInvocation === true) {
        return false;
      }
      return true;
    });
    return preferred ?? docs[0];
  }

  async function getAuthorSkillByName(
    params: GetAuthorSkillByNameParams,
  ): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const doc = await Skill.findOne({
      name: params.name,
      author: params.author,
      tenantId: params.tenantId ?? null,
    })
      .sort({ updatedAt: -1 })
      .lean();
    return backfillDerivedFromFrontmatter(
      (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null,
    );
  }

  async function listSkillsByAccess(
    params: ListSkillsByAccessParams,
  ): Promise<ListSkillsByAccessResult> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const limit = Math.min(Math.max(1, params.limit || 20), 100);

    const baseFilter = buildSkillFilter(params);
    const cursor = decodeCursor(params.cursor);

    let filter: FilterQuery<ISkillDocument> = baseFilter;
    if (cursor) {
      const cursorCondition: FilterQuery<ISkillDocument> = {
        $or: [
          { updatedAt: { $lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, _id: { $gt: cursor._id } },
        ],
      };
      filter = { $and: [baseFilter, cursorCondition] };
    }

    const rows = await Skill.find(filter)
      .sort({ updatedAt: -1, _id: 1 })
      .limit(limit + 1)
      /* `frontmatter` is deliberately NOT projected: the structured
         columns (disableModelInvocation / userInvocable / allowedTools /
         alwaysApply) are always populated by `createSkill` / `updateSkill`
         going forward, and the branch this code ships on never shipped
         to main — so no legacy rows exist that would need a frontmatter
         read-time backfill on summaries. Skipping it saves ~2KB/skill ×
         100/page of wire traffic. `backfillDerivedFromFrontmatter` is
         still called below as defensive code; it short-circuits when
         `frontmatter` is undefined. */
      .select(
        'name displayTitle description category author authorName version source sourceMetadata fileCount alwaysApply tenantId disableModelInvocation userInvocable allowedTools createdAt updatedAt',
      )
      .lean();

    /* Defensive read-time fallback. With `frontmatter` excluded from the
       projection, the helper short-circuits immediately; kept in the loop
       so a future projection change (or legacy rows appearing via a
       migration) continues to get runtime-column restoration for free. */
    for (const row of rows) {
      backfillDerivedFromFrontmatter(row as unknown as ISkill);
    }

    const has_more = rows.length > limit;
    const sliced = has_more ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const after =
      has_more && last
        ? encodeCursor({
            updatedAt: last.updatedAt as Date,
            _id: last._id as Types.ObjectId,
          })
        : null;

    return {
      skills: sliced as unknown as Array<ISkillSummary & { _id: Types.ObjectId }>,
      has_more,
      after,
    };
  }

  async function listAlwaysApplySkills(
    params: ListAlwaysApplySkillsParams,
  ): Promise<ListAlwaysApplySkillsResult> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    if (!params.accessibleIds.length) {
      return { skills: [], has_more: false, after: null };
    }
    const limit = Math.min(Math.max(1, params.limit || 20), 100);

    const baseFilter: FilterQuery<ISkillDocument> = {
      _id: { $in: params.accessibleIds },
      alwaysApply: true,
    };
    const cursor = decodeCursor(params.cursor);

    let filter: FilterQuery<ISkillDocument> = baseFilter;
    if (cursor) {
      const cursorCondition: FilterQuery<ISkillDocument> = {
        $or: [
          { updatedAt: { $lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, _id: { $gt: cursor._id } },
        ],
      };
      filter = { $and: [baseFilter, cursorCondition] };
    }

    const rows = await Skill.find(filter)
      .sort({ updatedAt: -1, _id: 1 })
      .limit(limit + 1)
      .select('name body author frontmatter updatedAt allowedTools version')
      .lean();

    const has_more = rows.length > limit;
    const sliced = has_more ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const after =
      has_more && last
        ? encodeCursor({
            updatedAt: last.updatedAt as Date,
            _id: last._id as Types.ObjectId,
          })
        : null;

    /**
     * `allowedTools` is projected alongside `name`/`body`/`author` so the
     * always-apply prime pipeline (post-Phase 6) can union skill-declared
     * tool allowlists into the agent's effective tool set for the turn —
     * same symmetry as the manual-prime path, which reads the column off
     * `getSkillByName`. Older rows predating the column show up with
     * `allowedTools === undefined` (the backfill helper runs on those at
     * read time elsewhere; per-turn priming is fine with undefined).
     */
    const skills = sliced.map((row) => {
      const result: ListAlwaysApplySkillsResult['skills'][number] = {
        _id: row._id as Types.ObjectId,
        name: row.name,
        body: row.body ?? '',
        author: row.author as Types.ObjectId,
        version: row.version,
        frontmatter: row.frontmatter,
      };
      if (row.allowedTools !== undefined) {
        result.allowedTools = row.allowedTools;
      }
      return result;
    });

    return { skills, has_more, after };
  }

  async function updateSkill(params: {
    id: string;
    expectedVersion: number;
    update: UpdateSkillInput;
  }): Promise<UpdateSkillResult> {
    const { id, expectedVersion, update } = params;
    if (!isValidObjectIdString(id)) {
      return { status: 'not_found' };
    }
    const normalizedFrontmatter = isPlainObject(update.frontmatter)
      ? normalizeSkillFrontmatterKeys(update.frontmatter)
      : undefined;
    const frontmatter =
      normalizedFrontmatter && 'frontmatter' in normalizedFrontmatter
        ? normalizedFrontmatter.frontmatter
        : update.frontmatter;

    const bodyIssues = update.body !== undefined ? validateSkillBody(update.body) : [];
    /* Parse body's always-apply status once — reused for validation
       (precedence-aware, below) and the derivation cascade further
       down. Avoids parsing the same YAML frontmatter block twice per
       update. */
    const bodyAlwaysApply =
      bodyIssues.length === 0 && update.body !== undefined
        ? extractAlwaysApplyFromBody(update.body)
        : undefined;
    const issues: ValidationIssue[] = [];
    if (update.name !== undefined) issues.push(...validateSkillName(update.name));
    if (update.description !== undefined)
      issues.push(...validateSkillDescription(update.description));
    issues.push(...bodyIssues);
    if (update.displayTitle !== undefined)
      issues.push(...validateSkillDisplayTitle(update.displayTitle));
    if (update.frontmatter !== undefined) issues.push(...validateSkillFrontmatter(frontmatter));
    if (update.alwaysApply !== undefined) issues.push(...validateAlwaysApply(update.alwaysApply));
    /* Body-level `always-apply:` only needs to be well-formed when a
       higher-precedence source won't override it (see
       `resolveAlwaysApplyFromInput` for precedence). Rejecting a typo
       the caller is already overriding would be user-hostile, and the
       body-inline derivation branch below is skipped for those
       payloads anyway. */
    if (
      bodyAlwaysApply?.status === 'invalid' &&
      update.alwaysApply === undefined &&
      getAlwaysApplyFrontmatterValue(frontmatter) === undefined
    ) {
      issues.push({
        field: 'body.frontmatter.alwaysApply',
        code: 'INVALID_TYPE',
        message:
          '"always-apply" or "alwaysApply" in SKILL.md frontmatter must be a boolean (true or false)',
      });
    }
    const { errors, warnings } = partitionIssues(issues);
    if (errors.length > 0) {
      const error = new Error('Skill validation failed');
      (error as Error & { issues?: ValidationIssue[]; code?: string }).issues = errors;
      (error as Error & { code?: string }).code = 'SKILL_VALIDATION_FAILED';
      throw error;
    }

    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const setPayload: Record<string, unknown> = {};
    const unsetPayload: Record<string, ''> = {};
    if (update.name !== undefined) setPayload.name = update.name;
    if (update.displayTitle !== undefined) setPayload.displayTitle = update.displayTitle;
    if (update.description !== undefined) setPayload.description = update.description;
    if (update.body !== undefined) setPayload.body = update.body;
    if (update.source !== undefined) setPayload.source = update.source;
    if (update.sourceMetadata !== undefined) setPayload.sourceMetadata = update.sourceMetadata;
    if (update.frontmatter !== undefined) {
      setPayload.frontmatter = frontmatter;
      /**
       * Derived columns track frontmatter — when frontmatter changes, the
       * derived view must follow. Fields the new frontmatter omits are
       * unset (back to schema default) so removing `disable-model-invocation`
       * from a SKILL.md re-enables model invocation on the next save.
       */
      const derived = deriveStructuredFrontmatterFields(frontmatter);
      for (const key of ['disableModelInvocation', 'userInvocable', 'allowedTools'] as const) {
        if (derived[key] !== undefined) {
          setPayload[key] = derived[key];
        } else {
          unsetPayload[key] = '';
        }
      }
    }
    if (update.category !== undefined) setPayload.category = update.category;
    /**
     * Keep the indexed `alwaysApply` column in sync with whatever the update
     * is carrying: an explicit top-level `alwaysApply` always wins; a
     * structured `frontmatter` with `always-apply: true/false` or the
     * accepted `alwaysApply` alias is next; and a `body` update is scanned last for an inline `always-apply:` line
     * inside the SKILL.md frontmatter block. The body path is load-bearing
     * for the REST edit flow — the current UI sends `body` without a
     * parallel `frontmatter` object, so inline edits to `always-apply:` / `alwaysApply:`
     * would otherwise leave the column stale and auto-priming / pin
     * badges would keep using the old value.
     *
     * When a `body` is submitted with NO `always-apply:` line (e.g. the
     * user removed the line from SKILL.md), that counts as a positive
     * declaration of "not always-apply" — the column flips to `false`.
     * Leaving it untouched would leave a skill that was once always-apply
     * silently auto-priming even after its own SKILL.md no longer
     * declares the flag.
     *
     * Important: the gates key off the *presence of an always-apply value*
     * at each level, not the presence of the parent field. An API caller
     * that sends both `body` and an unrelated `frontmatter` bag (e.g.
     * editing category + rewriting SKILL.md in one PATCH) still gets the
     * body-inline flag respected because no structured always-apply key
     * is absent in that payload.
     */
    let derivedAlwaysApply: boolean | undefined;
    if (update.alwaysApply !== undefined) {
      derivedAlwaysApply = update.alwaysApply;
    }
    if (derivedAlwaysApply === undefined && update.frontmatter !== undefined) {
      const fromFrontmatter = getAlwaysApplyFrontmatterValue(frontmatter);
      if (typeof fromFrontmatter === 'boolean') {
        derivedAlwaysApply = fromFrontmatter;
      }
    }
    if (derivedAlwaysApply === undefined && bodyAlwaysApply !== undefined) {
      if (bodyAlwaysApply.status === 'valid') {
        derivedAlwaysApply = bodyAlwaysApply.value;
      } else if (bodyAlwaysApply.status === 'absent') {
        /* An `absent` result means the user submitted a new body that
           declares no `always-apply:` key (either the key was removed or
           no frontmatter block was ever there). The body is the
           authoritative source for this skill's declared state: editing
           it to drop the flag intends to turn auto-priming off, so flip
           the column to `false`. Without this, a skill that was once
           `alwaysApply: true` would keep auto-priming after the user
           removed the declaration from SKILL.md — a persistent,
           invisible mismatch between the file and runtime behavior.
           `invalid` is rejected upstream by `validateAlwaysApplyInBody`
           so this branch only handles the legitimate absence case. */
        derivedAlwaysApply = false;
      }
    }
    if (derivedAlwaysApply !== undefined) {
      setPayload.alwaysApply = derivedAlwaysApply;
    }

    const updateOps: Record<string, unknown> = {
      $set: setPayload,
      $inc: { version: 1 },
    };
    if (Object.keys(unsetPayload).length > 0) {
      updateOps.$unset = unsetPayload;
    }
    const result = await Skill.findOneAndUpdate(
      { _id: new ObjectId(id), version: expectedVersion },
      updateOps,
      { new: true },
    ).lean();

    if (result) {
      return {
        status: 'updated',
        skill: result as unknown as ISkill & { _id: Types.ObjectId },
        warnings,
      };
    }

    const current = await Skill.findById(id).lean();
    if (!current) {
      return { status: 'not_found' };
    }
    return {
      status: 'conflict',
      current: current as unknown as ISkill & { _id: Types.ObjectId },
    };
  }

  /**
   * Removes deleted skill ids from every agent's `skills` allowlist. A dangling
   * id is invisible in the builder yet keeps the allowlist non-empty, so the
   * runtime scopes the catalog to an empty intersection and the agent silently
   * loses all skills. Direct `updateMany` on purpose: hygiene, not an authored
   * edit — no version entry, timestamps untouched.
   *
   * Ids are lowercased first: allowlists store canonical `_id.toString()`
   * values, and an uppercase-but-valid id would delete the Skill doc yet
   * leave the dangling entry behind.
   *
   * Agents whose ENTIRE allowlist is being deleted fail closed instead:
   * an emptied allowlist with `skills_enabled: true` means the full
   * accessible catalog at runtime, so a plain `$pull` would silently widen
   * a deliberately restricted agent. Disabling skills preserves the
   * restriction until an author makes a new explicit choice.
   *
   * That inference only applies to agents with no explicit `skills_scope`.
   * With a scope persisted, the field already says what an empty allowlist
   * means -- `selected` resolves to no skills on its own, and `all` means the
   * full catalog on purpose -- so disabling them would turn skills off behind
   * the author's back.
   */
  async function removeSkillsFromAgentAllowlists(skillIds: string[]): Promise<boolean> {
    if (skillIds.length === 0) {
      return true;
    }
    const ids = skillIds.map((id) => id.toLowerCase());
    const Agent = mongoose.models.Agent as Model<IAgent>;
    try {
      await Agent.updateMany(
        {
          skills: { $in: ids, $not: { $elemMatch: { $nin: ids } } },
          /** Only `all` and `selected` opt out: each already defines what an
           *  empty allowlist means. A missing field (matched here because
           *  `$nin` also matches absent) is the legacy shape, and an explicit
           *  `none` with the master flag still true is a contradictory shape
           *  the API accepts, which `skillDeps` would otherwise keep reading
           *  as permission to expose the skill-authoring tools. */
          skills_scope: { $nin: [SkillsScope.all, SkillsScope.selected] },
        },
        { $set: { skills: [], skills_enabled: false } },
        { timestamps: false },
      );
      await Agent.updateMany(
        { skills: { $in: ids } },
        { $pull: { skills: { $in: ids } } },
        { timestamps: false },
      );
      return true;
    } catch (error) {
      logger.error(
        '[removeSkillsFromAgentAllowlists] Error pruning agent skill allowlists:',
        error,
      );
      return false;
    }
  }

  async function deleteSkill(id: string): Promise<DeleteSkillResult> {
    if (!isValidObjectIdString(id)) {
      return {
        deleted: false,
        skillAbsent: false,
        cleanupComplete: false,
        failedCleanupSteps: [],
      };
    }
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const objectId = new ObjectId(id);
    const res = await Skill.deleteOne({ _id: objectId });
    const failedCleanupSteps: DeleteSkillCleanupStep[] = [];
    const allowlistsRemoved = await removeSkillsFromAgentAllowlists([id]);
    if (!allowlistsRemoved) {
      failedCleanupSteps.push('agent_allowlists');
    }

    const [filesResult, permissionsResult] = await Promise.allSettled([
      SkillFile.deleteMany({ skillId: objectId }),
      deps.removeAllPermissions({ resourceType: ResourceType.SKILL, resourceId: id }),
    ]);
    if (filesResult.status === 'rejected') {
      failedCleanupSteps.push('skill_files');
      logger.error(`[deleteSkill] Error removing files for ${id}:`, filesResult.reason);
    }
    if (permissionsResult.status === 'rejected') {
      failedCleanupSteps.push('permissions');
      logger.error(`[deleteSkill] Error removing permissions for ${id}:`, permissionsResult.reason);
    }

    return {
      deleted: Boolean(res.deletedCount),
      skillAbsent: true,
      cleanupComplete: failedCleanupSteps.length === 0,
      failedCleanupSteps,
    };
  }

  async function deleteUserSkills(userId: Types.ObjectId | string): Promise<number> {
    const userObjectId = typeof userId === 'string' ? new ObjectId(userId) : userId;
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const soleOwned = await deps.getSoleOwnedResourceIds(userObjectId, ResourceType.SKILL);
    if (soleOwned.length === 0) {
      return 0;
    }
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    await SkillFile.deleteMany({ skillId: { $in: soleOwned } });
    const res = await Skill.deleteMany({ _id: { $in: soleOwned } });
    await removeSkillsFromAgentAllowlists(soleOwned.map((rid) => rid.toString()));
    await Promise.allSettled(
      soleOwned.map((rid) =>
        deps
          .removeAllPermissions({
            resourceType: ResourceType.SKILL,
            resourceId: rid.toString(),
          })
          .catch((error) =>
            logger.error(`[deleteUserSkills] Error removing permissions for ${rid}:`, error),
          ),
      ),
    );
    return res.deletedCount ?? 0;
  }

  async function findSkillBySourceIdentity(params: {
    source: 'github' | 'notion';
    upstreamId: string;
    tenantId?: string;
  }): Promise<(ISkill & { _id: Types.ObjectId }) | null> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const tenantFilter: FilterQuery<ISkillDocument> = params.tenantId
      ? { tenantId: params.tenantId }
      : { $or: [{ tenantId: { $exists: false } }, { tenantId: null }] };
    const doc = await Skill.findOne({
      source: params.source,
      'sourceMetadata.upstreamId': params.upstreamId,
      ...tenantFilter,
    }).lean();
    return (doc as unknown as (ISkill & { _id: Types.ObjectId }) | null) ?? null;
  }

  async function listSkillsBySource(params: {
    source: 'github' | 'notion';
    sourceId: string;
  }): Promise<Array<ISkill & { _id: Types.ObjectId }>> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const rows = await Skill.find({
      source: params.source,
      'sourceMetadata.sourceId': params.sourceId,
    }).lean();
    return rows as unknown as Array<ISkill & { _id: Types.ObjectId }>;
  }

  /**
   * Atomically bumps `Skill.version` and adjusts `fileCount` by `delta`.
   * `delta` is `+1` when a new file is inserted, `-1` when one is deleted, and
   * `0` when an existing file is replaced in place.
   *
   * NOTE on consistency: this runs as a **separate** MongoDB operation from
   * the `upsertSkillFile` / `deleteSkillFile` that triggers it. MongoDB only
   * provides multi-document ACID via transactions (which require a replica
   * set), and LibreChat does not currently require that deployment shape. In
   * the rare case where a SkillFile write succeeds but the subsequent
   * `findByIdAndUpdate` here fails (connection drop, primary failover mid-
   * request), the `fileCount` on the parent Skill will drift from the true
   * row count until the next successful upsert/delete corrects it. Options if
   * this ever shows up in practice:
   *   - wrap both ops in a transaction (requires a replica set)
   *   - periodic reconciliation: `fileCount = count(skill_files where skillId = ?)`
   *   - treat `fileCount` as advisory and recompute on read when accuracy
   *     matters
   * For phase 1, skill files are stubbed at the upload boundary, so the risk
   * window doesn't open in practice.
   */
  async function bumpSkillVersionAndAdjustFileCount(
    skillId: Types.ObjectId | string,
    delta: number,
  ): Promise<void> {
    const Skill = mongoose.models.Skill as Model<ISkillDocument>;
    const updateOps: Record<string, Record<string, number>> = { $inc: { version: 1 } };
    if (delta !== 0) {
      updateOps.$inc.fileCount = delta;
    }
    await Skill.findByIdAndUpdate(skillId, updateOps);
  }

  async function listSkillFiles(
    skillId: Types.ObjectId | string,
  ): Promise<Array<ISkillFile & { _id: Types.ObjectId }>> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const rows = await SkillFile.find({ skillId })
      .select('-content')
      .sort({ relativePath: 1 })
      .lean();
    return rows as unknown as Array<ISkillFile & { _id: Types.ObjectId }>;
  }

  async function upsertSkillFile(
    row: UpsertSkillFileInput,
  ): Promise<ISkillFile & { _id: Types.ObjectId }> {
    const issues = validateRelativePath(row.relativePath);
    if (issues.length > 0) {
      const error = new Error('Skill file validation failed');
      (error as Error & { issues?: ValidationIssue[]; code?: string }).issues = issues;
      (error as Error & { code?: string }).code = 'SKILL_FILE_VALIDATION_FAILED';
      throw error;
    }
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const fields = {
      skillId: row.skillId,
      relativePath: row.relativePath,
      file_id: row.file_id,
      filename: row.filename,
      filepath: row.filepath,
      storageKey: row.storageKey,
      storageRegion: row.storageRegion,
      source: row.source,
      sourceMetadata: row.sourceMetadata,
      mimeType: row.mimeType,
      bytes: row.bytes,
      category: inferSkillFileCategory(row.relativePath),
      isExecutable: row.isExecutable ?? false,
      author: row.author,
      tenantId: row.tenantId,
    };
    if (row.createOnly) {
      if (row.expectedFileId != null) {
        throw new Error('A file cannot require both an absent path and an existing revision');
      }
      let created: ISkillFileDocument;
      try {
        created = await SkillFile.create(fields);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 11000) {
          throw Object.assign(new Error('Skill file was created by another writer'), {
            code: 'SKILL_FILE_CONFLICT',
          });
        }
        throw error;
      }
      await bumpSkillVersionAndAdjustFileCount(row.skillId, 1);
      return created.toObject() as unknown as ISkillFile & { _id: Types.ObjectId };
    }
    const result = (await SkillFile.findOneAndUpdate(
      {
        skillId: row.skillId,
        relativePath: row.relativePath,
        ...(row.expectedFileId != null ? { file_id: row.expectedFileId } : {}),
      },
      {
        $set: fields,
        $unset: { content: '', isBinary: '', codeEnvRef: '', codeEnvRefs: '' },
      },
      { new: true, upsert: row.expectedFileId == null, includeResultMetadata: true },
    ).lean()) as unknown as SkillFileUpsertResult;
    const current = result.value;
    if (!current && row.expectedFileId != null) {
      throw Object.assign(new Error('Skill file changed since it was read'), {
        code: 'SKILL_FILE_CONFLICT',
      });
    }
    if (!current) {
      const error = new Error('Skill file upsert failed to read the saved file row');
      (error as Error & { code?: string }).code = 'SKILL_FILE_UPSERT_NOT_FOUND';
      throw error;
    }
    const delta = result.lastErrorObject?.updatedExisting === false ? 1 : 0;
    await bumpSkillVersionAndAdjustFileCount(row.skillId, delta);
    return current;
  }

  async function deleteSkillFile(
    skillId: Types.ObjectId | string,
    relativePath: string,
  ): Promise<{ deleted: boolean }> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const res = await SkillFile.deleteOne({ skillId, relativePath });
    if (!res.deletedCount) {
      return { deleted: false };
    }
    await bumpSkillVersionAndAdjustFileCount(skillId, -1);
    return { deleted: true };
  }

  // The public surface is scoped to methods that handlers and the user
  async function getSkillFileByPath(
    skillId: Types.ObjectId | string,
    relativePath: string,
  ): Promise<(ISkillFile & { _id: Types.ObjectId }) | null> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const row = await SkillFile.findOne({ skillId, relativePath }).lean();
    return row as unknown as (ISkillFile & { _id: Types.ObjectId }) | null;
  }

  async function updateSkillFileContent(
    skillId: Types.ObjectId | string,
    relativePath: string,
    update: { content?: string; isBinary?: boolean },
    expectedFileId?: string,
  ): Promise<void> {
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    await SkillFile.updateOne(
      { skillId, relativePath, ...(expectedFileId != null ? { file_id: expectedFileId } : {}) },
      { $set: update },
    );
  }

  async function updateSkillFileCodeEnvIds(
    updates: Array<{
      skillId: Types.ObjectId | string;
      relativePath: string;
      codeEnvRef: CodeEnvRef;
    }>,
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    if (updates.length === 0) return { matchedCount: 0, modifiedCount: 0 };
    const SkillFile = mongoose.models.SkillFile as Model<ISkillFileDocument>;
    const ops = updates.map((u) => {
      const routeKey = u.codeEnvRef.executionRouteKey ?? u.codeEnvRef.executionProfile ?? 'default';
      return {
        updateOne: {
          filter: { skillId: u.skillId, relativePath: u.relativePath },
          update: {
            $set: {
              codeEnvRef: u.codeEnvRef,
              [`codeEnvRefs.${routeKey}`]: u.codeEnvRef,
            },
          },
        },
      };
    });

    /**
     * The returned `{matchedCount, modifiedCount}` lets callers warn on
     * partial writes — a silent miss here turns every subsequent prime
     * into a fresh upload (massive egress at scale). If the wrapper's
     * tenant injection ends up dropping rows, the warn log makes it
     * visible instead of failing closed.
     */
    const result = await tenantSafeBulkWrite(SkillFile, ops);
    if (result.modifiedCount < updates.length) {
      logger.warn(
        `[updateSkillFileCodeEnvIds] Persisted ${result.modifiedCount}/${updates.length} codeEnvRefs (matched ${result.matchedCount}). Subsequent primes for unmatched files will re-upload.`,
      );
    }
    return { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  }

  return {
    createSkill,
    getSkillById,
    getSkillByName,
    getAuthorSkillByName,
    listSkillsByAccess,
    listAlwaysApplySkills,
    updateSkill,
    deleteSkill,
    deleteUserSkills,
    findSkillBySourceIdentity,
    listSkillsBySource,
    listSkillFiles,
    upsertSkillFile,
    deleteSkillFile,
    getSkillFileByPath,
    updateSkillFileContent,
    updateSkillFileCodeEnvIds,
  };
}

export type SkillMethods = ReturnType<typeof createSkillMethods>;
