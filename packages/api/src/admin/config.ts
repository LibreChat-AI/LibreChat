import {
  BASE_PRINCIPAL_CONFIG_SECTIONS,
  BASE_ONLY_CONFIG_SECTIONS,
  DERIVED_CONFIG_PATHS,
  configSchema,
  PrincipalType,
  PrincipalModel,
  INTERFACE_PERMISSION_FIELDS,
  RUNTIME_CONFIG_INTERFACE_FIELDS,
  PERMISSION_SUB_KEYS,
  hasProcessMCPServerConfig,
  isProcessMCPServerConfig,
  isProcessMCPServerField,
  EModelEndpoint,
} from 'librechat-data-provider';
import {
  logger,
  getAtPath,
  unsetAtPath,
  isPlainRecord,
  isDotFreePath,
  isSegmentPrefix,
  parseFieldPath,
  setConfigFields,
  applyConfigChange,
  getConfigEntryKey,
  getConfigEntryMatcher,
  getConfigEntryIdentity,
  unsetConfigPaths,
  getConfigRevision,
  isConfigEntryError,
  isConfigRecordPath,
  pruneEmptyAncestors,
  isConfigArrayItemPath,
  isAcceptedOverrideSection,
  MAX_CONFIG_CHANGE_OPS,
  MAX_CONFIG_ENTRY_KEY_LENGTH,
  getConfigChangeIssues,
  getConfigArrayMergeKey,
  getIndexedMergeKeyIssues,
  getLiftedConfigTombstones,
  getConfigBatchWrittenPaths,
  isSameConfigValue,
  isConfigRevision,
  isConfigPathError,
  resolveRawConfig,
  isFieldNameRejection,
  getDottedSectionIssues,
  runConfigMutation,
  getConfigFieldIssues,
  toConfigOverrideState,
  tombstoneConfigPaths,
  applyConfigTombstones,
  isBaseConfigPrincipal,
  ABSENT_CONFIG_REVISION,
  replaceConfigOverrides,
  parseConfigPathSegments,
  getConfigOverrideIssues,
  getIgnoredConfigOverrides,
  YAML_HELD_PATHS,
  getExpectedRevision,
  MAX_CONFIG_PATH_DEPTH,
  getDefaultConfigPriority,
  BASE_CONFIG_PRINCIPAL_ID,
  isConfigRevisionConflict,
  ConfigRevisionConflictError,
  isConfigOverrideStateEmpty,
  isVertexConfigured,
  toConfigDraft,
  toConfigIdentityPath,
  renameConfigIdentityPath,
  resolveConfigIdentityPath,
  parseConfigPath,
  formatKeyedPath,
  isConfigEntryKey,
  isKeyedConfigPath,
  isConfigEntryArrayItemPath,
  renameConfigEntriesTombstones,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  ConfigDraft,
  ConfigChange,
  ConfigRecord,
  ConfigSection,
  ConfigWriteOutcome,
  ConfigRevision,
  ConfigFieldWrite,
  SystemCapability,
  ConfigPathError,
  ConfigPathInputs,
  ConfigOverrideIssue,
  ConfigPathErrorReason,
  ConfigOverrideState,
  ConfigOverrideLayer,
  ConfigEntryError,
  AdminConfigChangeOp,
  AdminConfigChangeRef,
  AdminConfigSkipReason,
  AdminConfigIgnoreReason,
  AdminConfigIgnoredSecret,
  AdminConfigAppliedLocation,
  AdminConfigLocation,
  AdminConfigWriteReport,
  AdminConfigErrorCode,
  AdminConfigIgnoredOverride,
  AdminConfigInvalidResponse,
  AdminConfigChangesResponse,
  AdminConfigChangeErrorResponse,
  AdminConfigReloadResponse,
  AdminConfigReloadErrorResponse,
  ConfigMutationOutcome,
  ConfigMutationPlan,
  ConfigIdentityStep,
  ConfigDerivation,
  ConfigEntryStep,
  ConfigLocation,
  ConfigEntryRename,
  YamlHeldPath,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { CapabilityUser } from '~/middleware/capabilities';
import type { ConfigReloadReport } from '~/app/invalidation';
import type { EnvReferencePolicy } from '~/app/allowlist';
import type { ConfigSecretRename } from './secrets';
import type { SecretReentryIssue } from './binding';
import type { ServerRequest } from '~/types/http';
import type { RecordAuditEntry } from './audit';
import type { SecretReentry } from './reentry';
import {
  RENAME_HINT_PATHS,
  getArraySecretKey,
  encryptConfigSecretFields,
  encryptConfigSecrets,
  carryRenamedConfigSecrets,
  getEnteredConfigSecrets,
  getConfigSecretMutationPaths,
  getConfigSecretInputError,
  getConfigSecretSections,
  isConfigSecretAncestorPath,
  isConfigSecretDescendantPath,
  isConfigSecretKeyRename,
  isConfigSecretPreservablePatch,
  isConfigSecretRelatedSegments,
  preserveConfigSecrets,
  redactConfigSecrets,
  redactResolvedConfigSecrets,
} from './secrets';
import {
  SECRET_BINDINGS,
  REBINDING_SECTIONS,
  getSecretBindingKey,
  getRebindingIdentity,
  toIgnoredSecretOverride,
  withoutStoredSecretBindings,
} from '~/app/rebinding';
import {
  parseEnvAllowlist,
  getEnvReferenceIssues,
  createEnvReferencePolicy,
  ENV_REFERENCE_NOT_ALLOWED,
  hasDisallowedStoredReference,
} from '~/app/allowlist';
import {
  MCP_SERVER_SECTIONS,
  findSecretReentry,
  getBoundKeyReentryIssues,
  getAzureGroupReentryIssues,
} from './reentry';
import {
  entersBoundSecret,
  bindSecretDestinations,
  isWebSearchBindingPath,
  getWebSearchReentryIssues,
} from './binding';
import { getConfigPartition, getActivePartition, runInPartition } from './partition';
import { buildAdminConfigMeta, getCatalogModelsTtlMs } from './meta';
import { createAdminAuditEmitter, configTarget } from './audit';
import { DEFAULT_OVERRIDE_CACHE_TTL } from '~/app/service';
import { getSafeErrorMetadata } from '~/utils/errors';
import { mergeOverrideLayers } from '~/app/overrides';
import { expandCustomEndpoint } from '~/app/params';

const UNSAFE_SEGMENTS = /(?:^|\.)(__[\w]*|constructor|prototype)(?:\.|$)/;
const MAX_PATCH_ENTRIES = 100;
/** The audit target of a reload: the file every instance loads again. */
const CONFIG_FILE_TARGET = 'librechat.yaml';
const RELOAD_AUDIT_TARGET = { type: 'config', id: CONFIG_FILE_TARGET, name: CONFIG_FILE_TARGET };
const BASE_ONLY_OVERRIDE_SECTIONS = new Set<string>(BASE_ONLY_CONFIG_SECTIONS);
const BASE_PRINCIPAL_OVERRIDE_SECTIONS = new Set<string>(BASE_PRINCIPAL_CONFIG_SECTIONS);
const PROCESS_MCP_CONFIG_ERROR =
  'Process-backed MCP servers can only be configured in librechat.yaml';
const LANGFUSE_HEADERS_CONFIG_ERROR =
  'Langfuse request headers can only be configured in librechat.yaml';

/**
 * Langfuse export headers carry proxy/gateway credentials, but they are a map
 * of values rather than one scalar path, so the config secret registry cannot
 * encrypt them at rest or mask them on read. Keeping them out of stored
 * overrides is what makes them deployment-level: an admin-written map would sit
 * in Mongo in plaintext and come back in plaintext, unlike `langfuse.secretKey`.
 */
function isLangfuseHeadersFieldPath(fieldPath: string): boolean {
  return fieldPath === 'langfuse.headers' || fieldPath.startsWith('langfuse.headers.');
}

/**
 * Whether an overrides payload carries Langfuse headers under any spelling.
 *
 * `overrides` is a Mixed document written wholesale, so a dotted property name
 * survives verbatim: `{ langfuse: { "headers.X-Token": "..." } }` and
 * `{ "langfuse.headers": {...} }` both persist a credential that the nested-map
 * redactor never walks, and a later read returns it unchanged.
 */
function hasLangfuseHeadersOverride(rawOverrides: Record<string, unknown>): boolean {
  for (const key of Object.keys(rawOverrides)) {
    if (key === 'langfuse.headers' || key.startsWith('langfuse.headers.')) {
      return true;
    }
  }

  const rawLangfuse = rawOverrides.langfuse;
  if (rawLangfuse == null || typeof rawLangfuse !== 'object' || Array.isArray(rawLangfuse)) {
    return false;
  }
  return Object.keys(rawLangfuse).some((key) => key === 'headers' || key.startsWith('headers.'));
}

export function isValidFieldPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('.') &&
    !path.endsWith('.') &&
    !path.includes('..') &&
    !path.includes('$') &&
    !UNSAFE_SEGMENTS.test(path)
  );
}

export function getTopLevelSection(fieldPath: string): string {
  return fieldPath.split('.')[0];
}

function isProcessMCPServerFieldPath(fieldPath: string, value: unknown): boolean {
  const [section, _serverName, field] = fieldPath.split('.');
  if (section !== 'mcpServers') {
    return false;
  }
  if (field == null) {
    return fieldPath === section
      ? hasProcessMCPServerConfig(value)
      : isProcessMCPServerConfig(value);
  }
  return isProcessMCPServerField(field) || (field === 'type' && value === 'stdio');
}

/** Sections whose guards read dotted paths, so a segment that contains a dot is refused there. */
const DOT_FREE_SECTIONS = new Set(['mcpServers', 'mcpConfig', 'langfuse']);

/**
 * Where a field write, removal or tombstone lands. `fieldPath` is the dotted spelling that the
 * section, permission and secret guards read; it names exactly `segments` when `dotFree`. With
 * `entry`, the target is one entry of the array merged by key at `segments`, by its key, or a
 * path inside it, and `fieldPath` is its canonical keyed path (`endpoints.custom["Name"]`).
 */
interface FieldTarget {
  segments: string[];
  fieldPath: string;
  dotFree: boolean;
  entry?: ConfigEntryStep;
}

type FieldTargetRead =
  | { ok: true; target: FieldTarget }
  | { ok: false; error: string; reason?: ConfigPathErrorReason };

const KEYED_PATH_ERROR =
  'Invalid keyed path: an entry is named by a JSON string key right after an array merged by key, as in endpoints.custom["Name"].headers';

/**
 * Reads a keyed `fieldPath` (`endpoints.custom["Name"].headers.X`): one entry of an array
 * merged by key, by its key, and a path inside it. Nothing submitted is echoed back.
 */
function readKeyedTarget(fieldPath: string): FieldTargetRead {
  const location = parseConfigPath(fieldPath);
  if (!location?.entry || !getConfigArrayMergeKey(location.segments)) {
    return { ok: false, error: KEYED_PATH_ERROR, reason: 'keyed_path' };
  }
  const { key, rest } = location.entry;
  return {
    ok: true,
    target: {
      segments: [...location.segments],
      fieldPath: formatKeyedPath(location.segments, key, rest),
      dotFree: true,
      entry: { key, rest: [...rest] },
    },
  };
}

/**
 * Reads a target from exactly one of `fieldPath` (validated as it always was) and `segments`.
 * Both spellings share the {@link MAX_CONFIG_PATH_DEPTH} cap. A segment that contains a dot is
 * refused wherever a guard would split it: as the section, inside sections whose guards read
 * dotted paths, and on a registered secret's path. A `fieldPath` holding an entry key step
 * (`["`) is read as a keyed path ({@link readKeyedTarget}).
 */
function readFieldTarget(fieldPath: unknown, segments: unknown): FieldTargetRead {
  if (segments === undefined) {
    if (typeof fieldPath === 'string' && isKeyedConfigPath(fieldPath)) {
      return readKeyedTarget(fieldPath);
    }
    if (typeof fieldPath !== 'string' || !isValidFieldPath(fieldPath)) {
      return { ok: false, error: `Invalid or unsafe field path: ${String(fieldPath)}` };
    }
    const parsed = parseFieldPath(fieldPath);
    if (parsed.length > MAX_CONFIG_PATH_DEPTH) {
      return { ok: false, error: 'Field path is too deep', reason: 'too_deep' };
    }
    return { ok: true, target: { segments: parsed, fieldPath, dotFree: true } };
  }
  if (fieldPath !== undefined) {
    return { ok: false, error: 'Provide either fieldPath or segments, not both' };
  }
  const parsed = parseConfigPathSegments(segments);
  if (!parsed.ok) {
    return { ok: false, error: 'Invalid or unsafe field path segments', reason: parsed.reason };
  }
  const target: FieldTarget = {
    segments: parsed.segments,
    fieldPath: parsed.segments.join('.'),
    dotFree: isDotFreePath(parsed.segments),
  };
  const [section] = target.segments;
  if (
    !target.dotFree &&
    (section.includes('.') ||
      DOT_FREE_SECTIONS.has(section) ||
      isConfigSecretRelatedSegments(target.segments))
  ) {
    return {
      ok: false,
      error: 'This path cannot address a key that contains a dot',
      reason: 'dotted_segment',
    };
  }
  return { ok: true, target };
}

function fieldTargetErrorResponse(
  res: Response,
  failure: { error: string; reason?: ConfigPathErrorReason },
): Response {
  const { error, reason } = failure;
  return reason
    ? errorResponse(res, 400, 'CONFIG_PATH_INVALID', error, { reason })
    : errorResponse(res, 400, 'INVALID_FIELD_PATH', error);
}

/** How a target is named in audit metadata: its dotted path, or its segments when lossy. */
function describeFieldTarget(target: FieldTarget): string {
  return target.dotFree ? target.fieldPath : JSON.stringify(target.segments);
}

/** `segments` in a query string is a JSON-encoded array; anything else is passed on to fail. */
function readSegmentsQuery(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * The field writes in request order: each dot-free entry as encryption and secret
 * preservation left it (one they dropped is skipped), right after it the preview companion
 * the secret pipeline wrote for it, each dotted entry as sent, then any other field the
 * pipeline added. A preview travels with its secret, so a later write of an ancestor that
 * puts the stored secret back replaces both, and no preview ever describes another key.
 */
function toOrderedWrites(
  entries: ReadonlyArray<{ target: FieldTarget; value: unknown }>,
  fields: Record<string, unknown>,
): ConfigFieldWrite[] {
  const pending = new Map(Object.entries(fields));
  const writes: ConfigFieldWrite[] = [];
  for (const { target, value } of entries) {
    if (!target.dotFree) {
      writes.push({ segments: target.segments, value });
      continue;
    }
    if (!pending.has(target.fieldPath)) {
      continue;
    }
    for (const fieldPath of getConfigSecretMutationPaths(target.fieldPath)) {
      if (pending.has(fieldPath)) {
        writes.push({ segments: parseFieldPath(fieldPath), value: pending.get(fieldPath) });
        pending.delete(fieldPath);
      }
    }
  }
  for (const [fieldPath, value] of pending) {
    writes.push({ segments: parseFieldPath(fieldPath), value });
  }
  return writes;
}

/** One step of a field patch: a write, or the reset of a path (a secret with its preview). */
type PatchStep = { write: ConfigFieldWrite } | { reset: ConfigLocation[] };

/**
 * A field patch's steps in request order: each entry's writes as {@link toOrderedWrites} orders
 * them, and in its place each entry whose whole value was cut out, as the reset of its path.
 */
function toOrderedSteps(
  entries: ReadonlyArray<{ target: FieldTarget; value: unknown; reset: boolean }>,
  fields: Record<string, unknown>,
): PatchStep[] {
  const steps: PatchStep[] = [];
  let run: Array<{ target: FieldTarget; value: unknown }> = [];
  const pending = { ...fields };
  const flush = () => {
    const runFields: Record<string, unknown> = {};
    for (const { target } of run) {
      for (const fieldPath of target.dotFree
        ? getConfigSecretMutationPaths(target.fieldPath)
        : []) {
        if (Object.prototype.hasOwnProperty.call(pending, fieldPath)) {
          runFields[fieldPath] = pending[fieldPath];
          delete pending[fieldPath];
        }
      }
    }
    steps.push(...toOrderedWrites(run, runFields).map((write) => ({ write })));
    run = [];
  };
  for (const entry of entries) {
    if (!entry.reset) {
      run.push(entry);
      continue;
    }
    flush();
    steps.push({ reset: getRemovalPaths(entry.target) });
  }
  flush();
  steps.push(...toOrderedWrites([], pending).map((write) => ({ write })));
  return steps;
}

function toStepWrites(steps: readonly PatchStep[]): ConfigFieldWrite[] {
  return steps.flatMap((step) => ('write' in step ? [step.write] : []));
}

/**
 * Validation of a patch with resets, as `getConfigFieldIssues` judges writes alone: the end
 * state the steps leave, with the keyed tombstones of each renamed entry (`renames`) moved to
 * its new key, and issues on every written or reset path, and those it introduced.
 */
function getPatchStepIssues(
  steps: readonly PatchStep[],
  floor: Partial<TCustomConfig>,
  stored: ConfigRecord | null,
  renames: readonly ConfigEntryRename[],
  derivation: ConfigDerivation,
): ConfigOverrideIssue[] {
  const written = steps.flatMap((step) =>
    'write' in step ? [[...step.write.segments]] : step.reset.map(({ segments }) => [...segments]),
  );
  const indexed = getIndexedMergeKeyIssues(written);
  if (indexed.length > 0) {
    return indexed;
  }
  const lifted = getLiftedConfigTombstones(toStepWrites(steps).map(({ segments }) => segments));
  const candidate = renameConfigEntriesTombstones(
    applyPatchSteps(toConfigOverrideState(stored), steps),
    renames,
  );
  return getConfigChangeIssues(candidate, floor, stored, written, lifted, derivation);
}

/** Applies a patch's steps in order to the stored document's state. */
function applyPatchSteps(state: ConfigOverrideState, steps: readonly PatchStep[]) {
  return steps.reduce(
    (current, step) =>
      'write' in step
        ? setConfigFields(current, [step.write])
        : unsetConfigPaths(current, step.reset),
    state,
  );
}

/**
 * Returns true if `fieldPath` targets an interface permission field or permission sub-key.
 *
 * - `"interface.prompts"` → true (boolean permission field)
 * - `"interface.agents.use"` → true (permission sub-key)
 * - `"interface.mcpServers"` → true (entire composite field)
 * - `"interface.mcpServers.use"` → true (permission sub-key)
 * - `"interface.mcpServers.placeholder"` → false (UI-only sub-key)
 * - `"interface.peoplePicker.users"` → true (all peoplePicker sub-keys are permissions)
 * - `"interface.modelSelect"` → false (UI-only field)
 */
function isInterfacePermissionPath(fieldPath: string): boolean {
  const parts = fieldPath.split('.');
  if (parts[0] !== 'interface' || parts.length < 2) {
    return false;
  }
  if (!INTERFACE_PERMISSION_FIELDS.has(parts[1])) {
    return false;
  }
  // "interface.<permField>" with no sub-key → permission (blocks the whole field),
  // EXCEPT dual-purpose runtime fields (e.g. schedules) whose bare top-level value
  // is a runtime enable toggle, not a permission — those must pass through so admin
  // field patches/tombstones can set or clear them (their .use/.create permission
  // sub-keys are still blocked below).
  if (parts.length === 2) {
    return !RUNTIME_CONFIG_INTERFACE_FIELDS.has(parts[1]);
  }
  // "interface.<permField>.<subKey>" → only block if sub-key is a permission bit
  return PERMISSION_SUB_KEYS.has(parts[2]);
}

/**
 * Collapses an explicit disable on a dual-purpose runtime interface field (e.g. `schedules`)
 * to its boolean form.
 *
 * For these fields `use` is BOTH a permission bit — stripped from DB overrides — and the
 * runtime disable signal. Stripping it alone would leave `{ maxPerUser: 2 }`, which
 * `getLimits` reads as ENABLED because an object opts in unless it sets `use: false`. An
 * override written to stop scheduled billing for a principal would therefore start it.
 * Other object forms are left alone so a principal can still narrow limits.
 */
function normalizeRuntimeInterfaceValue(field: string, value: unknown): unknown {
  if (!RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
    return value;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  return (value as Record<string, unknown>).use === false ? false : value;
}

/** Applies {@link normalizeRuntimeInterfaceValue} to a bare `interface.<field>` patch. */
function normalizeInterfaceFieldPatch(fieldPath: string, value: unknown): unknown {
  const parts = fieldPath.split('.');
  if (parts[0] !== 'interface' || parts.length !== 2) {
    return value;
  }
  return normalizeRuntimeInterfaceValue(parts[1], value);
}

/** Sets a key as data, so a submitted `__proto__` key never becomes a prototype. */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Drops the role-permission fields from a whole `interface` override: a composite permission
 * field keeps its UI-only sub-keys, a runtime field keeps its boolean form, and runtime disables
 * are normalized. Returns what is left (`undefined` when nothing is) and the dropped paths
 * relative to `interface`.
 */
function filterInterfaceOverride(iface: Record<string, unknown>): {
  value?: Record<string, unknown>;
  stripped: string[][];
} {
  const value: Record<string, unknown> = {};
  const stripped: string[][] = [];
  for (const [field, rawValue] of Object.entries(iface)) {
    const fieldValue = normalizeRuntimeInterfaceValue(field, rawValue);
    if (!INTERFACE_PERMISSION_FIELDS.has(field)) {
      defineKey(value, field, fieldValue);
      continue;
    }
    if (isPlainRecord(fieldValue)) {
      const uiOnly: Record<string, unknown> = {};
      for (const [sub, subValue] of Object.entries(fieldValue)) {
        if (PERMISSION_SUB_KEYS.has(sub)) {
          stripped.push([field, sub]);
        } else {
          defineKey(uiOnly, sub, subValue);
        }
      }
      if (Object.keys(uiOnly).length > 0) {
        defineKey(value, field, uiOnly);
      }
      continue;
    }
    if (RUNTIME_CONFIG_INTERFACE_FIELDS.has(field)) {
      defineKey(value, field, fieldValue);
      continue;
    }
    stripped.push([field]);
  }
  return { value: Object.keys(value).length > 0 ? value : undefined, stripped };
}

/** A failure a field guard answers with 400: a message and a stable code. */
interface FieldGuardError {
  error: string;
  code: 'PROCESS_MCP_CONFIG' | 'LANGFUSE_HEADERS_CONFIG' | 'SECRET_PATH';
}

/** Why a field write at `fieldPath` is refused outright, checked before anything is read. */
function getFieldWriteError(fieldPath: string, value: unknown): FieldGuardError | null {
  if (isProcessMCPServerFieldPath(fieldPath, value)) {
    return { error: PROCESS_MCP_CONFIG_ERROR, code: 'PROCESS_MCP_CONFIG' };
  }
  if (isLangfuseHeadersFieldPath(fieldPath)) {
    return { error: LANGFUSE_HEADERS_CONFIG_ERROR, code: 'LANGFUSE_HEADERS_CONFIG' };
  }
  if (isConfigSecretDescendantPath(fieldPath)) {
    return {
      error: `Cannot patch inside protected secret path: ${fieldPath}`,
      code: 'SECRET_PATH',
    };
  }
  const secretInputError = getConfigSecretInputError(fieldPath, value);
  if (secretInputError) {
    return { error: secretInputError, code: 'SECRET_PATH' };
  }
  if (Array.isArray(value) && isConfigSecretAncestorPath(fieldPath)) {
    return {
      error: `Cannot patch protected secret ancestor as an array: ${fieldPath}`,
      code: 'SECRET_PATH',
    };
  }
  return null;
}

/** Why a removal or tombstone at `fieldPath` is refused outright. */
function getFieldRemovalError(fieldPath: string): FieldGuardError | null {
  const secretInputError = getConfigSecretInputError(fieldPath, undefined);
  return secretInputError ? { error: secretInputError, code: 'SECRET_PATH' } : null;
}

/**
 * Why the generic config API leaves a path alone instead of changing it: a section only
 * librechat.yaml configures, a section with its own admin API, or an interface permission. The
 * request still succeeds (owner decision: skip and report, never 400).
 */
function getFieldSkipReason(fieldPath: string): AdminConfigSkipReason | null {
  const section = getTopLevelSection(fieldPath);
  if (BASE_ONLY_OVERRIDE_SECTIONS.has(section)) {
    return 'base_only_section';
  }
  if (BASE_PRINCIPAL_OVERRIDE_SECTIONS.has(section)) {
    return 'dedicated_section';
  }
  return isInterfacePermissionPath(fieldPath) ? 'interface_permission' : null;
}

const SKIP_DESCRIPTIONS: Readonly<Record<AdminConfigSkipReason, string>> = {
  base_only_section: 'base-only config field %s - configure it in librechat.yaml instead',
  base_only_path: 'base-only config path %s - configure it in librechat.yaml instead',
  deployment_only_path: 'deployment-only config path %s - configure it in librechat.yaml instead',
  dedicated_section: 'dedicated tenant-wide config field %s in the generic config API',
  interface_permission: 'interface permission field %s — use role permissions instead',
  process_mcp_server: 'override of process-backed MCP server %s - configure it in librechat.yaml',
  derived_path:
    'derived config path %s - the server derives it from the field it resolves, write that instead',
};

/** Logs a skipped path; `action` is how the route words it (`Stripping`, `Ignoring tombstone for`). */
function logSkippedField(action: string, fieldPath: string, reason: AdminConfigSkipReason): void {
  logger.warn(
    `[adminConfig] ${action} ${SKIP_DESCRIPTIONS[reason].replace('%s', JSON.stringify(fieldPath))}`,
  );
}

/** A field the generic config API never stores a value at, and why. */
interface HeldPath {
  segments: readonly string[];
  reason: YamlHeldPath['reason'] | 'derived_path';
}

/** Fields the server derives from another one (`rules.derivedPaths`), which the merge never applies. */
const DERIVED_HELD_PATHS: readonly HeldPath[] = DERIVED_CONFIG_PATHS.map((path) => ({
  segments: path.split('.'),
  reason: 'derived_path',
}));

let writeHeldPaths: readonly HeldPath[] | undefined;

/**
 * Fields only librechat.yaml sets (`YAML_HELD_PATHS`) and derived fields: no write stores them.
 * Built on first use rather than at import, as the other readers of `YAML_HELD_PATHS` do.
 */
function getWriteHeldPaths(): readonly HeldPath[] {
  writeHeldPaths ??= [...YAML_HELD_PATHS, ...DERIVED_HELD_PATHS];
  return writeHeldPaths;
}

/**
 * Why a write or tombstone at `segments` is skipped because the path is, or lies inside, a field
 * only librechat.yaml sets or one the server derives. Removing a stored value there is cleanup
 * and is never skipped.
 */
function getHeldPathSkipReason(segments: readonly string[]): HeldPath['reason'] | null {
  return (
    getWriteHeldPaths().find((held) => isSegmentPrefix(held.segments, segments))?.reason ?? null
  );
}

/** A part of a written value the API does not store, at its full location. */
interface SkippedPart {
  segments: string[];
  reason: AdminConfigSkipReason;
}

/**
 * Removes the fields only librechat.yaml sets, and the derived ones, below `segments` from a value
 * written there (`endpoints.agents` carrying `pullRequests.provider` or `eventDriven`,
 * `endpoints.anthropic` carrying `vertexConfig`), with the objects that leaves empty. Returns the
 * value to store and the parts it removed.
 */
function stripHeldPaths(
  segments: readonly string[],
  value: unknown,
): { value: unknown; stripped: SkippedPart[] } {
  let result = value;
  const stripped: SkippedPart[] = [];
  for (const { segments: path, reason } of getWriteHeldPaths()) {
    if (path.length <= segments.length || !isSegmentPrefix(segments, path)) {
      continue;
    }
    const relative = path.slice(segments.length);
    if (!isPlainRecord(result) || getAtPath(result, relative) === undefined) {
      continue;
    }
    result = pruneEmptyAncestors(unsetAtPath(result, relative), relative);
    stripped.push({ segments: [...path], reason });
  }
  return { value: result, stripped };
}

const PROCESS_MCP_SERVER_OVERRIDE_ERROR =
  'An MCP server librechat.yaml runs as a local process can only be configured in librechat.yaml';

/** The MCP servers librechat.yaml (`base`) runs as local processes, by name. */
function getProcessServerNames(base: Partial<TCustomConfig>): Set<string> {
  const servers = (base as { mcpServers?: unknown }).mcpServers;
  if (!isPlainRecord(servers)) {
    return new Set();
  }
  return new Set(
    Object.entries(servers)
      .filter(([, serverConfig]) => isProcessMCPServerConfig(serverConfig))
      .map(([name]) => name),
  );
}

/**
 * Whether `segments` names an MCP server librechat.yaml runs as a local process, or a path inside
 * one. The merge never applies an override or tombstone there (the process is shared by every
 * user), so a write or tombstone there is refused rather than stored with no effect.
 */
function isProcessServerPath(segments: readonly string[], processServers: ReadonlySet<string>) {
  return segments.length >= 2 && segments[0] === 'mcpServers' && processServers.has(segments[1]);
}

/** What a written value stores once the parts the API does not store are cut out. */
interface FilteredValue {
  value: unknown;
  skipped: SkippedPart[];
  /** Something was cut out and nothing of the value is left: the write resets its path. */
  emptied: boolean;
}

function isEmptied(value: unknown): boolean {
  return value === undefined || (isPlainRecord(value) && Object.keys(value).length === 0);
}

/**
 * Removes the servers librechat.yaml runs as local processes from a whole `mcpServers` value
 * (any other value is returned as is), so a client that writes back the section it read, stored
 * no-ops included, still succeeds. Applied once librechat.yaml is loaded, after
 * {@link filterWrittenValue}.
 */
function stripProcessServers(
  segments: readonly string[],
  value: unknown,
  processServers: ReadonlySet<string>,
): FilteredValue {
  const names =
    segments.length === 1 && segments[0] === 'mcpServers' && isPlainRecord(value)
      ? Object.keys(value).filter((name) => processServers.has(name))
      : [];
  if (names.length === 0) {
    return { value, skipped: [], emptied: false };
  }
  const kept: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(value as Record<string, unknown>)) {
    if (!processServers.has(name)) {
      defineKey(kept, name, server);
    }
  }
  return {
    value: kept,
    skipped: names.map((name) => ({
      segments: ['mcpServers', name],
      reason: 'process_mcp_server',
    })),
    emptied: isEmptied(kept),
  };
}

/**
 * Cuts out of a value written at `segments` what the generic config API never stores there,
 * whatever librechat.yaml holds: role-permission fields of a whole `interface`, and fields only
 * librechat.yaml sets. PUT, PATCH and change batches share it, so each reports the same parts as
 * skipped.
 */
function filterWrittenValue(segments: readonly string[], value: unknown): FilteredValue {
  const skipped: SkippedPart[] = [];
  let next = value;
  if (segments.length === 1 && segments[0] === 'interface' && isPlainRecord(next)) {
    const filtered = filterInterfaceOverride(next);
    for (const path of filtered.stripped) {
      skipped.push({ segments: ['interface', ...path], reason: 'interface_permission' });
    }
    if (filtered.stripped.length > 0 && !filtered.value) {
      return { value: undefined, skipped, emptied: true };
    }
    next = filtered.value ?? next;
  }
  const held = stripHeldPaths(segments, next);
  skipped.push(...held.stripped);
  return { value: held.value, skipped, emptied: skipped.length > 0 && isEmptied(held.value) };
}

/** A skipped part as the write report names it. */
function toSkippedLocation(part: SkippedPart): AdminConfigLocation & {
  reason: AdminConfigSkipReason;
} {
  return { path: part.segments.join('.'), segments: part.segments, reason: part.reason };
}

function toLocation(segments: readonly string[]): AdminConfigLocation {
  return { path: segments.join('.'), segments: [...segments] };
}

/**
 * The report of a write at one field target: a keyed target by its keyed path, its collection,
 * the entry key and the path inside the entry, as a change ref names it.
 */
function toTargetReport(target: FieldTarget): AdminConfigWriteReport {
  if (!target.entry) {
    return { applied: [toLocation(target.segments)], skipped: [] };
  }
  const { key, rest } = target.entry;
  const applied: AdminConfigAppliedLocation = {
    path: target.fieldPath,
    segments: [...target.segments],
    key,
    ...(rest.length > 0 && { entryPath: [...rest] }),
  };
  return { applied: [applied], skipped: [] };
}

/**
 * Positional slot where config methods once took a Mongoose `ClientSession`; the portable
 * config store does not join transactions.
 */
type NoSession = undefined;

/** Options of the principal-scoped config writes the handlers delegate whole. */
interface ConfigWriteOptions {
  /** Write only when the stored document is at this revision (`absent`: only if none exists). */
  expectedRevision?: ConfigRevision;
}

interface ConfigLifecycleOptions extends ConfigWriteOptions {
  /** Act only on a document that holds nothing; otherwise resolve to `null`. */
  expectEmpty?: boolean;
}

export interface AdminConfigDeps {
  listAllConfigs: (filter?: { isActive?: boolean }, session?: NoSession) => Promise<ConfigRecord[]>;
  findConfigByPrincipal: (
    principalType: PrincipalType,
    principalId: string,
    options?: { includeInactive?: boolean },
    session?: NoSession,
  ) => Promise<ConfigRecord | null>;
  /**
   * Writes the principal's whole document when it is still at `expected` (`absent`: only when
   * none exists), or throws a `ConfigRevisionConflictError`. PUT, PATCH, POST `/changes`,
   * tombstones and web search unsets plan the next document from the one they read, so
   * validation, the principal check and secret preservation see exactly what the write replaces.
   */
  writeConfigDocument: (
    principalType: PrincipalType,
    principalId: string,
    draft: ConfigDraft,
    expected: ConfigRevision,
  ) => Promise<ConfigRecord>;
  /**
   * Removes every path (dotted, or `{ segments }` for keys that contain dots) in one write,
   * pruning parents left empty; `null` when there is no document.
   */
  unsetConfigField: (
    principalType: PrincipalType,
    principalId: string,
    fieldPaths: ConfigPathInputs,
    session?: NoSession,
    options?: ConfigWriteOptions,
  ) => Promise<ConfigRecord | null>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string,
    session?: NoSession,
    options?: ConfigLifecycleOptions,
  ) => Promise<ConfigRecord | null>;
  /** Resolves to the post-write document and whether this write changed `isActive`. */
  toggleConfigActiveTracked: (
    principalType: PrincipalType,
    principalId: string,
    isActive: boolean,
    options?: ConfigLifecycleOptions,
  ) => Promise<{ config: ConfigRecord; changed: boolean } | null>;
  /**
   * Sets only the document's priority in the caller's tenant partition (platform-level without
   * a tenant, never a tenant's document for the same principal); resolves to it and whether
   * this write changed it, or `null` when the principal has none there. Without it the priority
   * route answers 501.
   */
  setConfigPriority?: (
    principalType: PrincipalType,
    principalId: string,
    priority: number,
    options?: ConfigWriteOptions,
  ) => Promise<ConfigWriteOutcome | null>;
  /**
   * Whether the role (exact name), group or user (ObjectId) exists in the caller's tenant
   * partition: the caller's tenant, or without one only platform-level principals. A write that
   * would create a principal's first document refuses one that does not (404
   * `PRINCIPAL_NOT_FOUND`), since that profile would never apply to anyone. Without this
   * lookup nothing is checked.
   */
  principalExists?: (principalType: PrincipalType, principalId: string) => Promise<boolean>;
  hasConfigCapability: (
    user: CapabilityUser,
    section: ConfigSection | null,
    verb?: 'manage' | 'read',
  ) => Promise<boolean>;
  /** Pre-flight-only: whether the caller holds any config-read capability at all (broad or any section), so a zero-access caller 403s before a DB fetch. */
  hasAnyConfigReadAccess?: (user: CapabilityUser) => Promise<boolean>;
  /** Resolves which of a set of sections the caller can read in a single batched query. */
  getReadableConfigSections?: (
    user: CapabilityUser,
    sections: ConfigSection[],
  ) => Promise<{ broad: boolean; sections: Set<string> }>;
  hasCapability?: (user: CapabilityUser, capability: SystemCapability) => Promise<boolean>;
  getAppConfig?: (options?: {
    role?: string;
    userId?: string;
    tenantId?: string;
    baseOnly?: boolean;
    /** Read the overrides from the store instead of the per-principal merged-config cache. */
    bypassOverrideCache?: boolean;
  }) => Promise<AppConfig>;
  /** Invalidate the config caches a mutation affects; awaited before the response is sent. */
  invalidateConfigCaches?: (tenantId?: string) => Promise<void>;
  /**
   * The same clear for `POST /reload`, then librechat.yaml loaded again on this instance and,
   * once it loaded, the broadcast, resolving with what each step reached instead of only logging
   * a failure, so the route can answer for it.
   */
  reloadConfigCaches?: (tenantId?: string) => Promise<ConfigReloadReport>;
  /** Optional audit emission for override mutations; fail-open unless `auditFailClosed`. */
  recordAuditEntry?: RecordAuditEntry;
  /** When true, a failed audit write surfaces as a 5xx after the mutation has
   * been persisted. Defaults to fail-open. */
  auditFailClosed?: boolean;
  /**
   * The `overrideCacheTtl` the app config service runs with, which `GET /meta` reports.
   * Defaults to the service's own default.
   */
  overrideCacheTtlMs?: number;
  /**
   * Extra env names override values may reference (`CONFIG_OVERRIDE_ENV_ALLOWLIST`), beyond
   * those librechat.yaml references and the built-in endpoint credentials. Must match what the
   * app config service is given, so a write is judged by the policy its values resolve under.
   */
  overrideEnvAllowlist?: string;
  /**
   * Whether the app config service derives Azure groups, Vertex AI and the Azure Assistants
   * endpoint from overrides again (`CONFIG_REDERIVE_ENDPOINTS`): `GET /meta` reports it as
   * `features.endpointRederive`, and write responses judge what a write drops by the same merge.
   */
  rederiveEndpoints?: boolean;
}

/**
 * What writes over `yaml` (librechat.yaml) are checked against beyond the schema: the custom
 * endpoint parameter definitions startup would expand (`invalid_param_definitions`), and whether
 * librechat.yaml configures the Vertex AI a write may turn on, besides the derived checks the
 * store always runs (Azure groups, Vertex AI, model spec endpoints).
 */
function getWriteDerivation(yaml: Partial<TCustomConfig> | null): ConfigDerivation {
  return { expandCustomEndpoint, vertexConfigured: isVertexConfigured(yaml) };
}

// ── Validation helpers ───────────────────────────────────────────────

const CONFIG_PRINCIPAL_TYPES = new Set([
  PrincipalType.USER,
  PrincipalType.GROUP,
  PrincipalType.ROLE,
]);

export function validatePrincipalType(value: string): value is PrincipalType {
  return CONFIG_PRINCIPAL_TYPES.has(value as PrincipalType);
}

const INVALID_PRIORITY_ERROR = 'priority must be a non-negative number';

function isValidPriority(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function invalidPriorityResponse(res: Response): Response {
  return res.status(400).json({ error: INVALID_PRIORITY_ERROR, code: 'INVALID_PRIORITY' });
}

export function principalNotFoundResponse(res: Response): Response {
  return res.status(404).json({ error: 'Principal not found', code: 'PRINCIPAL_NOT_FOUND' });
}

function principalModel(type: PrincipalType): PrincipalModel {
  switch (type) {
    case PrincipalType.USER:
      return PrincipalModel.USER;
    case PrincipalType.GROUP:
      return PrincipalModel.GROUP;
    case PrincipalType.ROLE:
      return PrincipalModel.ROLE;
    case PrincipalType.PUBLIC:
      return PrincipalModel.ROLE;
    default: {
      const _exhaustive: never = type;
      logger.warn(`[adminConfig] Unmapped PrincipalType: ${String(_exhaustive)}`);
      return PrincipalModel.ROLE;
    }
  }
}

export function getCapabilityUser(req: ServerRequest): CapabilityUser | null {
  if (!req.user) {
    return null;
  }
  return {
    id: req.user.id ?? req.user._id?.toString() ?? '',
    role: req.user.role ?? '',
    tenantId: (req.user as { tenantId?: string }).tenantId,
  };
}

/**
 * `AppConfig` keys exempt from the generic per-key `read:configs:<section>`
 * lookup in `filterSectionsByReadAccess`, for three distinct reasons:
 * - `paths` is a server-computed constant (resolved at module load), not a
 *   `TCustomConfig` section, so no `read:configs:<section>` grant could ever
 *   apply to it.
 * - `config` is the nested container whose contents are filtered separately
 *   below; checking the outer key against a nonexistent `read:configs:config`
 *   grant would always fail and strip the whole object, including sections
 *   the caller legitimately holds.
 * - `availableTools` is derived from the `filteredTools`/`includedTools`
 *   sections plus a filesystem scan, not itself a grantable section. It gets
 *   its own explicit check below, gated on those two source sections, rather
 *   than a lookup against the nonexistent `read:configs:availableTools`.
 * Real `TCustomConfig` sections (e.g. `fileStrategy`) must never be added
 * here: exempting one would return it to every caller regardless of grants.
 */
const STRUCTURAL_APP_CONFIG_KEYS = new Set(['paths', 'availableTools', 'config']);

/**
 * Top-level `AppConfig` response field → canonical `ConfigSection` name.
 * `getAppConfig` renames a few sections in the resolved payload
 * (`interface` → `interfaceConfig`, `turnstile` → `turnstileConfig`,
 * `mcpServers` → `mcpConfig`). The read-grant capability is keyed by the
 * canonical section name, so the top-level filter must normalize through
 * this map before calling `canRead`. Otherwise a caller holding
 * `read:configs:interface` gets `interfaceConfig` incorrectly stripped
 * because no section named "interfaceConfig" exists to grant.
 */
const APP_CONFIG_FIELD_TO_SECTION: Readonly<Record<string, string>> = {
  interfaceConfig: 'interface',
  turnstileConfig: 'turnstile',
  mcpConfig: 'mcpServers',
};

export type ReadableSections = { broad: boolean; sections: ReadonlySet<string> };

/** Every section `configSchema` defines: a write resolves read access to all of them before it commits. */
const CONFIG_SCHEMA_SECTIONS = Object.keys(configSchema.shape) as ConfigSection[];
const FULL_READ_ACCESS: ReadableSections = { broad: true, sections: new Set() };
/** Shows no section: an assign-only write stores an empty document. */
const NO_READ_ACCESS: ReadableSections = { broad: false, sections: new Set() };

export function canReadSection(readable: ReadableSections, section: string): boolean {
  return readable.broad || readable.sections.has(section);
}

/** Strips every top-level key not in `preserveKeys` that `canRead` rejects. */
export function filterSectionsByReadAccess<T extends Record<string, unknown>>(
  obj: T,
  canRead: (section: string) => boolean,
  preserveKeys: Set<string> = new Set(),
): T {
  const result: Record<string, unknown> = { ...obj };
  for (const key of Object.keys(result)) {
    if (!preserveKeys.has(key) && !canRead(key)) {
      delete result[key];
    }
  }
  return result as T;
}

export function filterConfigDocForReadAccess<T extends ConfigRecord>(
  config: T,
  readable: ReadableSections,
): T {
  const canRead = (section: string): boolean => canReadSection(readable, section);
  const filteredOverrides = filterSectionsByReadAccess(
    (config.overrides ?? {}) as Record<string, unknown>,
    canRead,
  );

  let filteredTombstones = config.tombstones;
  if (config.tombstones?.length) {
    filteredTombstones = config.tombstones.filter((path) => canRead(getTopLevelSection(path)));
  }

  return {
    ...config,
    overrides: filteredOverrides as Partial<TCustomConfig>,
    tombstones: filteredTombstones,
  };
}

function filterAppConfigForReadAccess(appConfig: AppConfig, readable: ReadableSections): AppConfig {
  const canRead = (section: string): boolean => canReadSection(readable, section);
  const canReadTopLevelField = (field: string): boolean =>
    canRead(APP_CONFIG_FIELD_TO_SECTION[field] ?? field);

  const filtered = filterSectionsByReadAccess(
    appConfig as unknown as Record<string, unknown>,
    canReadTopLevelField,
    STRUCTURAL_APP_CONFIG_KEYS,
  );
  if (!canRead('filteredTools') && !canRead('includedTools')) {
    delete (filtered as { availableTools?: unknown }).availableTools;
  }
  const nestedConfig = (filtered as { config?: Record<string, unknown> }).config;
  if (nestedConfig != null && typeof nestedConfig === 'object') {
    (filtered as { config?: unknown }).config = filterSectionsByReadAccess(nestedConfig, canRead);
  }
  return filtered as unknown as AppConfig;
}

/** All section names a config document's overrides/tombstones could reference. */
export function collectConfigSections(config: ConfigRecord): string[] {
  return [
    ...Object.keys(config.overrides ?? {}),
    ...(config.tombstones ?? []).map(getTopLevelSection),
  ];
}

/** All section names an `AppConfig` response could reference, normalized to canonical section names. */
function collectAppConfigSections(appConfig: AppConfig): string[] {
  const topLevel = Object.keys(appConfig)
    .filter((key) => !STRUCTURAL_APP_CONFIG_KEYS.has(key))
    .map((key) => APP_CONFIG_FIELD_TO_SECTION[key] ?? key);
  const nested = (appConfig as unknown as { config?: Record<string, unknown> }).config;
  return [...topLevel, ...(nested ? Object.keys(nested) : [])];
}

type ConfigResponse = ConfigRecord & { revision: ConfigRevision };

/** The document as the admin API returns it: secrets redacted, with its revision. */
export function redactConfigForResponse(config: ConfigRecord): ConfigResponse {
  const safeConfig = JSON.parse(JSON.stringify(config)) as ConfigRecord;
  if (safeConfig.overrides) {
    safeConfig.overrides = withoutStoredSecretBindings(safeConfig.overrides);
    redactConfigSecrets(safeConfig.overrides, { previewPlaintext: true });
  }
  return { ...safeConfig, revision: getConfigRevision(config) };
}

/**
 * Redacts an `AppConfig` for an admin read. For a config merged with overrides,
 * `yamlConfig` is the librechat.yaml config beneath them: a plaintext secret an
 * override stored before its path was registered gets a preview, like a read
 * of the override document itself.
 */
function redactAppConfigForResponse(appConfig: AppConfig, yamlConfig?: AppConfig): AppConfig {
  const safeConfig = JSON.parse(JSON.stringify(appConfig)) as AppConfig & { config?: unknown };
  redactConfigSecrets(safeConfig, { previewPlaintext: yamlConfig != null, yamlConfig });
  redactResolvedConfigSecrets(safeConfig);
  if (safeConfig.config != null && typeof safeConfig.config === 'object') {
    redactConfigSecrets(safeConfig.config);
    redactResolvedConfigSecrets(safeConfig.config);
  }
  return safeConfig;
}

/**
 * A written document the way a read would return it: filtered to the read access resolved
 * before the write, then redacted, with the revision of the whole stored document so the next
 * write can be conditioned on it.
 */
function toWrittenConfig(config: ConfigRecord, access: ReadableSections): ConfigResponse {
  const readable = access.broad ? config : filterConfigDocForReadAccess(config, access);
  return redactConfigForResponse(readable);
}

/**
 * The credentials a written document's layer drops at merge (`secretRebinding`), limited to the
 * sections the response may show: each path names a server, endpoint or group of its section.
 */
function filterIgnoredForReadAccess(
  ignored: readonly AdminConfigIgnoredSecret[],
  access: ReadableSections,
): AdminConfigIgnoredSecret[] {
  return ignored.filter(({ segments }) => canReadSection(access, segments[0]));
}

/** Read access to only the sections a write manages, for a response that resolves no other. */
function toWrittenSectionsAccess(
  hasBroadManage: boolean,
  managedSections: readonly string[],
): ReadableSections {
  return hasBroadManage ? FULL_READ_ACCESS : { broad: false, sections: new Set(managedSections) };
}

/**
 * A write's response: the written document as a read shows it, what the write applied and
 * skipped (`report`, for the field writes), and what its layer drops.
 */
function sendWrittenConfig(
  res: Response,
  status: number,
  config: ConfigRecord,
  access: ReadableSections,
  ignoredSecrets: readonly AdminConfigIgnoredSecret[] = [],
  report?: AdminConfigWriteReport,
): Response {
  const ignored = filterIgnoredForReadAccess(ignoredSecrets, access);
  return res.status(status).json({
    config: toWrittenConfig(config, access),
    ...report,
    ...(ignored.length > 0 && { ignored }),
  });
}

/** The write report of a request: the locations it applied, and the parts it skipped. */
function toWriteReport(
  applied: ReadonlyArray<readonly string[]>,
  skipped: readonly SkippedPart[],
): AdminConfigWriteReport {
  return { applied: applied.map(toLocation), skipped: skipped.map(toSkippedLocation) };
}

/** Logs each skipped part; `action` is how the route words it (`Stripping`, `Ignoring tombstone for`). */
function logSkippedParts(action: string, skipped: readonly SkippedPart[]): void {
  for (const { segments, reason } of skipped) {
    logSkippedField(action, segments.join('.'), reason);
  }
}

/** A 4xx of the admin config API: a message and a stable code, plus any route-specific fields. */
function errorResponse(
  res: Response,
  status: number,
  code: AdminConfigErrorCode,
  error: string,
  extra?: Record<string, unknown>,
): Response {
  return res.status(status).json({ error, code, ...extra });
}

export function authRequiredResponse(res: Response): Response {
  return errorResponse(res, 401, 'AUTH_REQUIRED', 'Authentication required');
}

export function forbiddenResponse(res: Response): Response {
  return errorResponse(res, 403, 'FORBIDDEN', 'Insufficient permissions');
}

function forbiddenSectionResponse(res: Response, section: string): Response {
  return errorResponse(
    res,
    403,
    'FORBIDDEN_SECTION',
    `Insufficient permissions for config section: ${section}`,
    { section },
  );
}

function invalidPrincipalTypeResponse(res: Response, principalType: string): Response {
  return errorResponse(
    res,
    400,
    'INVALID_PRINCIPAL_TYPE',
    `Invalid principalType: ${principalType}`,
  );
}

function configNotFoundResponse(res: Response): Response {
  return errorResponse(res, 404, 'CONFIG_NOT_FOUND', 'Config not found');
}

function processServerOverrideResponse(res: Response, extra?: Record<string, unknown>): Response {
  return errorResponse(
    res,
    400,
    'PROCESS_MCP_SERVER_OVERRIDE',
    PROCESS_MCP_SERVER_OVERRIDE_ERROR,
    extra,
  );
}

/**
 * Field writes must address a section `configSchema` defines: anything else (`paths`, the raw
 * `config`, an AppService alias such as `interfaceConfig`) would reach runtime state. The path
 * is not echoed back.
 */
function unknownSectionResponse(res: Response): Response {
  return res.status(400).json({ error: 'Unknown config section', code: 'UNKNOWN_SECTION' });
}

/**
 * Reports only locations, stable codes and the schema's own bounds and options (`params`, from
 * an allowlist that never copies the submitted value): schema messages can echo the submitted
 * values. `segments` names the location key by key, since `path` is ambiguous once a record key
 * itself holds a dot. `report` adds what a route reports alongside them (a batch's `skipped`).
 */
function invalidOverrideResponse(
  res: Response,
  issues: ConfigOverrideIssue[],
  report?: Pick<AdminConfigChangeErrorResponse, 'skipped'>,
): Response {
  return res.status(400).json({
    error: 'Invalid config override',
    code: 'CONFIG_OVERRIDE_INVALID',
    issues: issues.map(({ path, segments, code, params }) =>
      params ? { path, segments, code, params } : { path, segments, code },
    ),
    ...report,
  } satisfies AdminConfigInvalidResponse);
}

/**
 * The database refused a key name in the written overrides, such as a dotted record key on an
 * engine that cannot store one. Nothing was written; the key is not echoed.
 */
function unstorableKeyResponse(res: Response, operation: string): Response {
  logger.warn(
    `[adminConfig] ${operation}: the database rejected a key name in the overrides, such as a dotted record key this engine cannot store`,
  );
  return res.status(422).json({
    error: 'The database cannot store a key name in this config',
    code: 'CONFIG_KEY_NOT_STORABLE',
  });
}

/**
 * The answer to a reload that did not load librechat.yaml on this instance or did not reach
 * every instance, or `null` when it did. A refused file is reported first, since retrying cannot
 * fix it; its issues carry locations and zod codes only.
 */
function getReloadFailure(
  report: ConfigReloadReport,
): { status: number; body: AdminConfigReloadErrorResponse } | null {
  const loadFailure = report.loaded?.ok === false ? report.loaded.error : undefined;
  if (loadFailure?.code === 'CONFIG_INVALID') {
    return {
      status: 422,
      body: {
        error: 'librechat.yaml failed to load; the last good config is still served',
        code: 'CONFIG_RELOAD_INVALID',
        issues: loadFailure.issues.map(({ path, segments, code }) => ({ path, segments, code })),
      },
    };
  }
  if (!report.cleared || loadFailure) {
    return {
      status: 500,
      body: { error: 'Failed to reload config', code: 'CONFIG_RELOAD_FAILED' },
    };
  }
  if (report.broadcast !== 'failed') {
    return null;
  }
  return {
    status: 503,
    body: {
      error: 'Config reloaded on this instance only; the other instances could not be notified',
      code: 'CONFIG_RELOAD_BROADCAST_FAILED',
    },
  };
}

/**
 * Rejects a write that would send a stored secret to a destination it was not
 * entered for. Reports only locations and stable codes, never a value; `segments`
 * names the location key by key, as other config issues do.
 */
function secretReentryResponse(res: Response, issues: SecretReentryIssue[]): Response {
  return res.status(400).json({
    error: 'Enter the stored API key again when changing the URL it is sent to',
    code: 'CONFIG_SECRET_REENTRY_REQUIRED',
    issues: issues.map(({ path, segments, code, secretPath }) => ({
      path,
      segments,
      code,
      secretPath,
    })),
  });
}

/**
 * A write run on the validation floor, with the active Base document it was last judged on
 * (`undefined` when the write read none: Base itself, or a write with nothing to validate).
 */
type FloorOutcome<T> = ConfigMutationOutcome<T> & { base?: ConfigRecord | null };

/**
 * The tenant partitions a write to one principal's document involves. `tenantId` is the one the
 * document merges in (`undefined`: the deployment's own, tenantless), so the write is judged on
 * librechat.yaml as that partition resolves it and on that partition's Base. `activeTenantId` is
 * the request's own (the caller's), where the store addresses role documents and creates a
 * document the write makes.
 */
interface WriteScope {
  tenantId: string | undefined;
  activeTenantId: string | undefined;
}

/**
 * Why a planned unset or tombstone wrote nothing: no document to unset, no principal to create
 * one for, or a stored credential it would send elsewhere without entering it again.
 */
type RemovalStop =
  | { status: 404; missing: 'config' | 'principal' }
  | { status: 400; reentry: SecretReentryIssue[] }
  | { status: 400; mcpReentry: SecretReentry };

function removalStopResponse(res: Response, stop: RemovalStop): Response {
  if ('reentry' in stop) {
    return secretReentryResponse(res, stop.reentry);
  }
  if ('mcpReentry' in stop) {
    return mcpReentryResponse(res, stop.mcpReentry);
  }
  return stop.missing === 'principal'
    ? principalNotFoundResponse(res)
    : configNotFoundResponse(res);
}

const INVALID_EXPECTED_REVISION_ERROR =
  'expectedRevision must be "absent" or a revision returned by the config API';

/** A client precondition: absent (none given), a well-formed revision, or malformed. */
function readExpectedRevision(
  value: unknown,
): { ok: true; value?: ConfigRevision } | { ok: false } {
  if (value === undefined || value === null) {
    return { ok: true };
  }
  return isConfigRevision(value) ? { ok: true, value } : { ok: false };
}

function invalidExpectedRevisionResponse(res: Response): Response {
  return res
    .status(400)
    .json({ error: INVALID_EXPECTED_REVISION_ERROR, code: 'INVALID_EXPECTED_REVISION' });
}

/** Reports why a path cannot apply to the stored document, without echoing the path. */
function invalidPathResponse(res: Response, error: ConfigPathError): Response {
  return res.status(400).json({
    error: 'Config path cannot be applied to the stored config',
    code: 'CONFIG_PATH_INVALID',
    reason: error.reason,
  });
}

function preservePatchedConfigSecretFields(
  fields: Record<string, unknown>,
  existingOverrides?: unknown,
): Record<string, unknown> {
  const result = { ...fields };
  for (const [fieldPath, value] of Object.entries(result)) {
    if (isConfigSecretPreservablePatch(fieldPath, value)) {
      result[fieldPath] = preserveConfigSecrets(value, existingOverrides, fieldPath);
    }
  }
  return result;
}

/** Most rename hints one write accepts. */
const MAX_RENAMES = 50;
const UNSAFE_NAME = /^(?:\$|__)|^(?:constructor|prototype)$/;

type RenamesRead = { ok: true; renames: ConfigSecretRename[] } | { ok: false; reason: string };

const RENAME_PATHS: ReadonlySet<string> = new Set(RENAME_HINT_PATHS);

function isRenamePath(path: unknown): path is ConfigSecretRename['path'] {
  return typeof path === 'string' && RENAME_PATHS.has(path);
}

/** Whether a hint renames entries of an array merged by key, rather than keys of a record. */
function isEntryRename(rename: ConfigSecretRename): boolean {
  return getConfigArrayMergeKey(parseFieldPath(rename.path)) !== undefined;
}

/** How a hint's name is compared with the others of its path: an entry key by its identity. */
function getRenameIdentity(path: ConfigSecretRename['path'], name: string): string {
  return getConfigEntryIdentity(parseFieldPath(path), name);
}

/**
 * Reads the body's `renames` hint: `[{ path, previousName, name }]` for `mcpServers` (a server
 * renamed or duplicated from the stored `previousName`) or `endpoints.custom` (a custom endpoint
 * renamed from the stored entry named `previousName`), telling the write to carry the secrets the
 * entry it writes as `name` omits from there. Never stored. A custom endpoint name must be one a
 * keyed path can address (`isConfigEntryKey`), since the entry's keyed tombstones move with it,
 * and one entry is renamed once per write (`duplicate_source`): its tombstones move to one name.
 * A server may be duplicated, so several hints may share its `previousName`.
 */
function readRenames(value: unknown): RenamesRead {
  if (value === undefined || value === null) {
    return { ok: true, renames: [] };
  }
  if (!Array.isArray(value) || value.length > MAX_RENAMES) {
    return { ok: false, reason: 'invalid_renames' };
  }
  const renames: ConfigSecretRename[] = [];
  const targets = new Set<string>();
  const sources = new Set<string>();
  for (const item of value) {
    const { path, previousName, name } = (item ?? {}) as Record<string, unknown>;
    if (!isRenamePath(path)) {
      return { ok: false, reason: 'unsupported_path' };
    }
    if (
      typeof previousName !== 'string' ||
      typeof name !== 'string' ||
      previousName === '' ||
      name === '' ||
      UNSAFE_NAME.test(previousName) ||
      UNSAFE_NAME.test(name) ||
      getRenameIdentity(path, previousName) === getRenameIdentity(path, name)
    ) {
      return { ok: false, reason: 'invalid_name' };
    }
    const rename: ConfigSecretRename = { path, previousName, name };
    const entry = isEntryRename(rename);
    if (entry && (!isConfigEntryKey(previousName) || !isConfigEntryKey(name))) {
      return { ok: false, reason: 'invalid_name' };
    }
    const target = JSON.stringify([path, getRenameIdentity(path, name)]);
    if (targets.has(target)) {
      return { ok: false, reason: 'duplicate_target' };
    }
    targets.add(target);
    const source = JSON.stringify([path, getRenameIdentity(path, previousName)]);
    if (entry && sources.has(source)) {
      return { ok: false, reason: 'duplicate_source' };
    }
    sources.add(source);
    renames.push(rename);
  }
  return { ok: true, renames };
}

/** The entry renames a hint carries out, which move the old entries' keyed tombstones. */
function toEntryRenames(renames: readonly ConfigSecretRename[]): ConfigEntryRename[] {
  return renames.filter(isEntryRename).map(({ path, previousName, name }) => ({
    segments: parseFieldPath(path),
    from: previousName,
    to: name,
  }));
}

function invalidRenameResponse(res: Response, reason: string): Response {
  return res
    .status(400)
    .json({ error: 'Invalid rename hint', code: 'CONFIG_RENAME_INVALID', reason });
}

/** Whether a write sets the value at `target`: at it, below it, or at an ancestor whose value reaches it. */
function writesTarget(writes: readonly ConfigFieldWrite[], target: readonly string[]): boolean {
  return writes.some(
    ({ segments, value }) =>
      isSegmentPrefix(target, segments) ||
      (isSegmentPrefix(segments, target) &&
        getAtPath(value, target.slice(segments.length)) !== undefined),
  );
}

/**
 * The entries `writes` leave in the merged-by-key array at `segments`: those of the last write
 * that covers it, or `undefined` when none does or it leaves no array there.
 */
function getWrittenArray(
  writes: readonly ConfigFieldWrite[],
  segments: readonly string[],
): unknown[] | undefined {
  let items: unknown[] | undefined;
  let covered = false;
  for (const write of writes) {
    if (isSegmentPrefix(write.segments, segments)) {
      const value = getAtPath(write.value, segments.slice(write.segments.length));
      items = Array.isArray(value) ? value : undefined;
      covered = true;
    }
  }
  return covered ? items : undefined;
}

/** Whether `items` holds an entry of the merged-by-key array at `segments` keyed `name`. */
function holdsEntry(items: unknown, segments: readonly string[], name: string): boolean {
  const keyField = getConfigArrayMergeKey(segments);
  return (
    keyField !== undefined &&
    Array.isArray(items) &&
    items.some(getConfigEntryMatcher(segments, keyField, name))
  );
}

/**
 * Why an entry rename hint cannot apply to this write: either name is one librechat.yaml
 * defines (`inherited_entry`, as for a batch `rename`), `previousName` is not a stored entry of
 * the principal (`source_not_found`), `name` already is one (`target_exists`), the write does not
 * write `name` (`target_not_written`) or still writes `previousName` (`source_still_written`).
 */
function getEntryRenameIssue(
  { path, previousName, name }: ConfigSecretRename,
  stored: { overrides?: unknown } | null,
  writes: readonly ConfigFieldWrite[],
  base: Partial<TCustomConfig>,
): string | null {
  const segments = parseFieldPath(path);
  const yamlItems = getAtPath(base, segments);
  if (holdsEntry(yamlItems, segments, previousName) || holdsEntry(yamlItems, segments, name)) {
    return 'inherited_entry';
  }
  const storedItems = getAtPath(stored?.overrides, segments);
  if (!holdsEntry(storedItems, segments, previousName)) {
    return 'source_not_found';
  }
  if (holdsEntry(storedItems, segments, name)) {
    return 'target_exists';
  }
  const written = getWrittenArray(writes, segments);
  if (!holdsEntry(written, segments, name)) {
    return 'target_not_written';
  }
  return holdsEntry(written, segments, previousName) ? 'source_still_written' : null;
}

/**
 * Why a rename hint cannot apply to this write: for a server, its source is not a stored server,
 * or the write does not write its target; for a custom endpoint, see {@link getEntryRenameIssue}.
 */
function getRenameIssue(
  renames: readonly ConfigSecretRename[],
  stored: { overrides?: unknown } | null,
  writes: readonly ConfigFieldWrite[],
  base: Partial<TCustomConfig>,
): string | null {
  for (const rename of renames) {
    if (isEntryRename(rename)) {
      const issue = getEntryRenameIssue(rename, stored, writes, base);
      if (issue) {
        return issue;
      }
      continue;
    }
    const { path, previousName, name } = rename;
    const storedRecord = (stored?.overrides as Record<string, unknown> | undefined)?.[path];
    if (
      storedRecord == null ||
      typeof storedRecord !== 'object' ||
      !Object.prototype.hasOwnProperty.call(storedRecord, previousName)
    ) {
      return 'source_not_found';
    }
    if (!writesTarget(writes, [path, name])) {
      return 'target_not_written';
    }
  }
  return null;
}

function mcpReentryResponse(res: Response, reentry: SecretReentry): Response {
  const { message, code, server, fields } = reentry;
  return res.status(400).json({ error: message, code, server, fields });
}

/** Describes rename hints for the audit record: paths and names, never values. */
function describeRenames(renames: readonly ConfigSecretRename[]): string {
  return renames.map(({ path, previousName, name }) => `${path}:${previousName}>${name}`).join(',');
}

/**
 * Whether removing a field in `section` can change where a bound secret is sent: only then does a
 * field removal or tombstone report what it drops.
 */
function isBoundSecretSection(section: string | undefined): boolean {
  return section != null && REBINDING_SECTIONS.includes(section);
}

/** Whether a document overrides or tombstones anything in a section with bound secrets. */
function touchesBoundSecretSections(
  record: Pick<ConfigOverrideLayer, 'overrides' | 'tombstones'>,
): boolean {
  const overrides = (record.overrides ?? {}) as Record<string, unknown>;
  return REBINDING_SECTIONS.some(
    (section) =>
      section in overrides ||
      (record.tombstones ?? []).some(
        (path) => typeof path === 'string' && path.split('.')[0] === section,
      ),
  );
}

const MCP_SECTIONS = new Set<string>(MCP_SERVER_SECTIONS);

/** A removal enters no secret: whatever credential it leaves in place was kept. */
const NO_ENTERED_SECRETS: ReadonlySet<string> = new Set();

/** Whether a path holds Azure groups or anything in them: `endpoints`, and all of its Azure section. */
function isAzureGroupPath(segments: readonly string[]): boolean {
  return (
    segments[0] === 'endpoints' &&
    (segments.length === 1 || segments[1] === EModelEndpoint.azureOpenAI)
  );
}

/** Sections whose keys sit beside their own destination: OCR's and each speech service's. */
const SCALAR_BOUND_SECTIONS = new Set<string>(['ocr', 'speech']);

/** Whether a path names an OCR or speech key itself, or its preview: removing it moves nothing. */
function isScalarSecretPath(segments: readonly string[]): boolean {
  return SECRET_BINDINGS.some(
    ({ path, secretKey }) =>
      segments.length === path.length + 1 &&
      path.every((segment, index) => segments[index] === segment) &&
      (segments[path.length] === secretKey || segments[path.length] === `${secretKey}Preview`),
  );
}

/**
 * Whether a path holds a key bound to the destination beside it, or that destination: OCR,
 * speech, or a custom endpoint (and `endpoints` whole). The key itself is not such a path.
 */
function isBoundKeyPath(segments: readonly string[]): boolean {
  if (isScalarSecretPath(segments)) {
    return false;
  }
  return (
    SCALAR_BOUND_SECTIONS.has(segments[0]) ||
    (segments[0] === 'endpoints' && (segments.length === 1 || segments[1] === 'custom'))
  );
}

/**
 * Whether removing or tombstoning `target` can change where a stored credential is sent: a web
 * search URL (or the whole section) beside a stored key, any field of an MCP server, anything an
 * Azure group's key and destination sit in, or anything an OCR, speech or custom endpoint key
 * and its destination sit in.
 */
function isBoundRemoval(target: FieldTarget): boolean {
  return (
    (target.dotFree && isWebSearchBindingPath(target.fieldPath)) ||
    MCP_SECTIONS.has(target.segments[0]) ||
    isAzureGroupPath(target.segments) ||
    isBoundKeyPath(target.segments)
  );
}

/**
 * The stored keys a planned document keeps beside a destination it changes, which the request
 * must enter again: web search keys, Azure group keys (compared over librechat.yaml's resolved
 * groups, from `baseConfig`), and custom endpoint, OCR and speech keys (compared as the document
 * alone sends them over librechat.yaml). MCP credentials answer with their own error
 * (`findSecretReentry`).
 */
function getKeptKeyReentryIssues(
  stored: ConfigRecord | null | undefined,
  candidate: ConfigOverrideState,
  entered: ReadonlySet<string>,
  baseConfig: AppConfig | undefined,
): SecretReentryIssue[] {
  return [
    ...getWebSearchReentryIssues(stored, candidate, entered),
    ...getAzureGroupReentryIssues({
      stored,
      candidate,
      entered,
      base: {
        groups: baseConfig?.config?.endpoints?.[EModelEndpoint.azureOpenAI]?.groups,
        groupMap: baseConfig?.endpoints?.[EModelEndpoint.azureOpenAI]?.groupMap,
      },
    }),
    ...getBoundKeyReentryIssues({ stored, candidate, entered, baseConfig }),
  ];
}

// ── Change batches ───────────────────────────────────────────────────

type ChangeOpKind = AdminConfigChangeOp['op'];

const CHANGE_OPS: ReadonlySet<string> = new Set<ChangeOpKind>([
  'set',
  'unset',
  'tombstone',
  'upsertEntry',
  'removeEntry',
  'rename',
]);

/** Changes whose own path may not reach into a merged-by-key array entry by position. */
const INDEXED_PATH_OPS: ReadonlySet<ChangeOpKind> = new Set<ChangeOpKind>([
  'set',
  'unset',
  'rename',
]);

/**
 * Changes that leave an override or tombstone at their path, refused inside an MCP server
 * librechat.yaml runs as a local process (an `unset` there is cleanup).
 */
const SERVER_WRITE_OPS: ReadonlySet<ChangeOpKind> = new Set<ChangeOpKind>([
  'set',
  'tombstone',
  'rename',
]);

type SkippedChange = AdminConfigChangeRef & { reason: AdminConfigSkipReason };
type IgnoredChange = AdminConfigChangeRef & { reason: AdminConfigIgnoreReason };

/** A 400 for one change of a batch; `opIndex` names it and nothing submitted is echoed. */
interface ChangeFailure {
  error: string;
  code: string;
  opIndex: number;
  reason?: string;
}

/**
 * A change of a batch, checked and prepared before the stored document is read: guards run,
 * skipped parts are cut out, and submitted secrets are encrypted once. What depends on the
 * stored document (secrets an object omits, entries to rename) is resolved while applying.
 */
interface PreparedChange {
  index: number;
  op: ChangeOpKind;
  target: FieldTarget;
  /** The entry key of `upsertEntry` and `removeEntry`; the old key of `rename`. */
  key?: string;
  /** The new key of `rename`. */
  to?: string;
  /**
   * `set`: the value to store, after normalization and stripping. `upsertEntry`: the entry as
   * submitted, before its secrets are encrypted.
   */
  value?: unknown;
  /** `set` on a dot-free path: `value` with secrets encrypted, plus any preview companion. */
  fields?: Record<string, unknown>;
  /** `upsertEntry`: the entry with secrets encrypted. */
  entry?: Record<string, unknown>;
  /**
   * `unset` and `tombstone`: the paths removed together (a secret and its preview), or the keyed
   * location. `set`: the paths it resets instead, when nothing of its value is stored.
   */
  paths?: ConfigLocation[];
}

type PreparedRead =
  | {
      ok: true;
      /** Two changes with the same identity address the same location. */
      identity: string;
      section: string;
      /** `null` when the whole change is skipped. */
      change: PreparedChange | null;
      skipped: SkippedChange[];
    }
  | { ok: false; failure: ChangeFailure };

function changeFailure(
  opIndex: number,
  error: string,
  code: string,
  reason?: string,
): PreparedRead {
  return {
    ok: false,
    failure: reason ? { error, code, opIndex, reason } : { error, code, opIndex },
  };
}

function toChangeRef(
  change: Pick<PreparedChange, 'index' | 'op' | 'target' | 'key'>,
): AdminConfigChangeRef {
  const ref: AdminConfigChangeRef = {
    opIndex: change.index,
    op: change.op,
    segments: [...change.target.segments],
  };
  if (change.key !== undefined && change.op !== 'rename') {
    ref.key = change.key;
  }
  if (change.target.entry && change.target.entry.rest.length > 0) {
    ref.entryPath = [...change.target.entry.rest];
  }
  return ref;
}

function isEntryOp(op: ChangeOpKind): boolean {
  return op === 'upsertEntry' || op === 'removeEntry' || op === 'rename';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * The locations an `unset` of `target` removes together: a secret and its preview companion,
 * or a keyed target's entry location.
 */
function getRemovalPaths(target: FieldTarget): ConfigLocation[] {
  if (target.entry) {
    return [{ segments: target.segments, entry: target.entry }];
  }
  return target.dotFree
    ? getConfigSecretMutationPaths(target.fieldPath).map((path) => ({
        segments: parseFieldPath(path),
      }))
    : [{ segments: target.segments }];
}

const INSIDE_ARRAY_TOMBSTONE_ERROR =
  'A tombstone can hide a whole array, not an element or a path inside one; hide an entry of a collection merged by key by its key, as in endpoints.custom["Name"]';

const KEYED_WRITE_ERROR =
  'A keyed path can be hidden (tombstone) or reset (unset), not written: write the entry in its collection';

/** A 400 a keyed target answers with: a message, a stable code and a reason. */
interface KeyedTargetError {
  error: string;
  code: 'CONFIG_PATH_INVALID' | 'SECRET_PATH';
  reason?: ConfigPathErrorReason;
}

/**
 * Why a keyed target cannot be hidden or reset, checked before anything is read: it names the
 * entry's key field (hide the whole entry instead), the entry's registered secret, its preview
 * or its destination fingerprint, or for a tombstone, a path inside one of the entry's own
 * arrays, which the merge cannot hide part of.
 */
function getKeyedTargetError(target: FieldTarget, tombstone: boolean): KeyedTargetError | null {
  const { segments, entry } = target;
  if (!entry) {
    return null;
  }
  const [field] = entry.rest;
  if (field !== undefined && field === getConfigArrayMergeKey(segments)) {
    return {
      error: "An entry's key cannot be removed: hide or reset the whole entry instead",
      code: 'CONFIG_PATH_INVALID',
      reason: 'merge_key',
    };
  }
  const secretKey = getArraySecretKey(segments.join('.'));
  const removalError = getFieldRemovalError(target.fieldPath);
  if (removalError || (secretKey && field === getSecretBindingKey(secretKey))) {
    return {
      error: 'Secret fields of an entry cannot be addressed by key: write the entry instead',
      code: 'SECRET_PATH',
    };
  }
  if (tombstone && isConfigEntryArrayItemPath(segments, entry.rest)) {
    return {
      error: 'A tombstone can hide a whole array, not an element or a path inside one',
      code: 'CONFIG_PATH_INVALID',
      reason: 'inside_array',
    };
  }
  return null;
}

/**
 * Prepares a `set`: refuses what PATCH refuses, skips what PATCH strips, filters a whole
 * `interface` object and base-only fields out of the value (reporting each), and encrypts it.
 * A set replaces what is stored at its path with what is left of its value, so one whose
 * whole value is filtered out resets the path, as an `unset` does.
 */
function prepareSet(
  raw: Record<string, unknown>,
  base: Pick<PreparedChange, 'index' | 'op' | 'target'>,
  skipReason: AdminConfigSkipReason | null,
): PreparedRead | { ok: true; change: PreparedChange | null; skipped: SkippedChange[] } {
  const { index, target } = base;
  if (!Object.prototype.hasOwnProperty.call(raw, 'value') || raw.value === undefined) {
    return changeFailure(index, 'A set change needs a value', 'INVALID_CHANGE');
  }
  const guardError = getFieldWriteError(target.fieldPath, raw.value);
  if (guardError) {
    return changeFailure(index, guardError.error, guardError.code);
  }
  const ref = toChangeRef(base);
  if (skipReason) {
    return { ok: true, change: null, skipped: [{ ...ref, reason: skipReason }] };
  }
  const filtered = filterWrittenValue(
    target.segments,
    normalizeInterfaceFieldPatch(target.fieldPath, raw.value),
  );
  const skipped: SkippedChange[] = filtered.skipped.map(({ segments, reason }) => ({
    ...ref,
    segments,
    reason,
  }));
  if (filtered.emptied) {
    return { ok: true, change: { ...base, paths: getRemovalPaths(target) }, skipped };
  }
  const { value } = filtered;
  const fields = target.dotFree
    ? encryptConfigSecretFields({ [target.fieldPath]: value })
    : undefined;
  return { ok: true, change: { ...base, value, fields }, skipped };
}

/** Prepares an entry change: the path must hold a merged-by-key array (or, to rename, a record). */
function prepareEntryChange(
  raw: Record<string, unknown>,
  base: Pick<PreparedChange, 'index' | 'op' | 'target'>,
  skipReason: AdminConfigSkipReason | null,
): PreparedRead | { ok: true; change: PreparedChange | null; skipped: SkippedChange[] } {
  const { index, op, target } = base;
  const keyField = getConfigArrayMergeKey(target.segments);
  let change: PreparedChange;
  if (op === 'rename') {
    if (!isNonEmptyString(raw.from) || !isNonEmptyString(raw.to)) {
      return changeFailure(
        index,
        'A rename needs non-empty from and to',
        'CONFIG_ENTRY_INVALID',
        'invalid_entry',
      );
    }
    if (keyField && !isConfigEntryKey(raw.to)) {
      return changeFailure(
        index,
        'An entry renamed in a collection merged by key needs a name a keyed path can address',
        'CONFIG_ENTRY_INVALID',
        'invalid_entry',
      );
    }
    if (!keyField) {
      if (!isConfigRecordPath(target.segments)) {
        return changeFailure(
          index,
          'A rename addresses a collection merged by key or a record of named entries',
          'CONFIG_ENTRY_INVALID',
          'not_collection',
        );
      }
      for (const name of [raw.from, raw.to]) {
        const keyTarget = readFieldTarget(undefined, [...target.segments, name]);
        if (!keyTarget.ok) {
          return changeFailure(index, keyTarget.error, 'CONFIG_PATH_INVALID', keyTarget.reason);
        }
      }
      if (isConfigSecretKeyRename(target.segments, raw.from, raw.to)) {
        return changeFailure(index, 'A rename cannot move a registered secret', 'SECRET_PATH');
      }
    }
    change = { ...base, key: raw.from, to: raw.to };
  } else if (!keyField) {
    return changeFailure(
      index,
      'Entry changes address a collection merged by key, such as endpoints.custom',
      'CONFIG_ENTRY_INVALID',
      'not_collection',
    );
  } else if (op === 'removeEntry') {
    if (!isNonEmptyString(raw.key)) {
      return changeFailure(
        index,
        'removeEntry needs a non-empty key',
        'CONFIG_ENTRY_INVALID',
        'invalid_entry',
      );
    }
    change = { ...base, key: raw.key };
  } else {
    const key = getConfigEntryKey(raw.entry, keyField);
    if (key === undefined) {
      return changeFailure(
        index,
        `upsertEntry needs an entry object with a non-empty ${keyField}`,
        'CONFIG_ENTRY_INVALID',
        'invalid_entry',
      );
    }
    const guardError = getFieldWriteError(target.fieldPath, [raw.entry]);
    if (guardError) {
      return changeFailure(index, guardError.error, guardError.code);
    }
    const [entry] = encryptConfigSecrets([raw.entry as Record<string, unknown>], target.fieldPath);
    change = { ...base, key, entry, value: raw.entry };
  }
  if (skipReason) {
    return { ok: true, change: null, skipped: [{ ...toChangeRef(change), reason: skipReason }] };
  }
  return { ok: true, change, skipped: [] };
}

/**
 * What a change addresses, for refusing two changes of a batch that address the same thing: a
 * path, or one entry of a collection (by its key's identity, so `Ollama` and `ollama` are one
 * custom endpoint; a rename by the key it starts from).
 */
function getChangeIdentity(
  raw: Record<string, unknown>,
  op: ChangeOpKind,
  target: FieldTarget,
): string {
  const { segments, entry } = target;
  const toEntry = (key: unknown): string =>
    JSON.stringify([
      'entry',
      segments,
      typeof key === 'string' ? getConfigEntryIdentity(segments, key) : null,
    ]);
  /** A keyed change of a whole entry addresses what an entry change of that key does. */
  if (entry) {
    return entry.rest.length === 0
      ? toEntry(entry.key)
      : JSON.stringify([
          'entry',
          segments,
          getConfigEntryIdentity(segments, entry.key),
          entry.rest,
        ]);
  }
  if (!isEntryOp(op)) {
    return JSON.stringify(['path', segments]);
  }
  if (op === 'rename') {
    return toEntry(raw.from);
  }
  if (op === 'removeEntry') {
    return toEntry(raw.key);
  }
  const keyField = getConfigArrayMergeKey(segments);
  return toEntry(keyField ? getConfigEntryKey(raw.entry, keyField) : null);
}

/**
 * Reads and checks one change of a batch without touching the stored document. A change
 * refused outright fails the whole batch (400, by `opIndex`); one the API never stores
 * (decision #2: base-only, deployment-owned, dedicated, interface permission) is reported as
 * skipped and the rest of the batch still applies.
 */
function prepareChange(raw: unknown, index: number): PreparedRead {
  if (!isPlainRecord(raw) || typeof raw.op !== 'string' || !CHANGE_OPS.has(raw.op)) {
    return changeFailure(
      index,
      'Each change needs an op: set, unset, tombstone, upsertEntry, removeEntry or rename',
      'INVALID_CHANGE',
    );
  }
  const op = raw.op as ChangeOpKind;
  const read = readFieldTarget(raw.fieldPath, raw.segments);
  if (!read.ok) {
    return changeFailure(
      index,
      read.error,
      read.reason ? 'CONFIG_PATH_INVALID' : 'INVALID_FIELD_PATH',
      read.reason,
    );
  }
  const { target } = read;
  const base = { index, op, target };
  const section = target.segments[0];
  /** Unsetting what an older server stored outside configSchema is cleanup, as DELETE allows. */
  if (op !== 'unset' && !isAcceptedOverrideSection(section)) {
    return changeFailure(index, 'Unknown config section', 'UNKNOWN_SECTION');
  }
  if (target.entry && op !== 'unset' && op !== 'tombstone') {
    return changeFailure(index, KEYED_WRITE_ERROR, 'CONFIG_PATH_INVALID', 'keyed_path');
  }
  const sectionSkip = getFieldSkipReason(target.fieldPath);

  let prepared:
    | PreparedRead
    | { ok: true; change: PreparedChange | null; skipped: SkippedChange[] };
  if (op === 'set') {
    prepared = prepareSet(raw, base, sectionSkip ?? getHeldPathSkipReason(target.segments));
  } else if (isEntryOp(op)) {
    prepared = prepareEntryChange(raw, base, sectionSkip);
  } else {
    if (op === 'tombstone' && !target.dotFree) {
      return changeFailure(
        index,
        'A tombstone cannot name a key that contains a dot',
        'CONFIG_PATH_INVALID',
        'dotted_segment',
      );
    }
    const keyedError = getKeyedTargetError(target, op === 'tombstone');
    if (keyedError) {
      return changeFailure(index, keyedError.error, keyedError.code, keyedError.reason);
    }
    if (op === 'tombstone' && !target.entry && isConfigArrayItemPath(target.segments)) {
      return changeFailure(
        index,
        INSIDE_ARRAY_TOMBSTONE_ERROR,
        'CONFIG_PATH_INVALID',
        'inside_array',
      );
    }
    const removalError =
      target.dotFree && !target.entry ? getFieldRemovalError(target.fieldPath) : null;
    if (removalError) {
      return changeFailure(index, removalError.error, removalError.code);
    }
    /** Unsetting a stored held or derived field is cleanup: only a tombstone is skipped. */
    const skipReason =
      sectionSkip ?? (op === 'tombstone' ? getHeldPathSkipReason(target.segments) : null);
    const change: PreparedChange = {
      ...base,
      key: target.entry?.key,
      paths: getRemovalPaths(target),
    };
    prepared = skipReason
      ? { ok: true, change: null, skipped: [{ ...toChangeRef(change), reason: skipReason }] }
      : { ok: true, change, skipped: [] };
  }
  if (!prepared.ok) {
    return prepared;
  }
  return {
    ok: true,
    identity: getChangeIdentity(raw, op, target),
    section,
    change: prepared.change,
    skipped: prepared.skipped,
  };
}

/** The changes a prepared change applies, resolved against the document as it stands. */
function expandChange(change: PreparedChange, overrides: unknown): ConfigChange[] {
  const { segments } = change.target;
  switch (change.op) {
    case 'set': {
      if (change.paths) {
        return change.paths.map((path) => ({ op: 'unset', segments: path.segments }));
      }
      if (!change.fields) {
        return [{ op: 'set', segments, value: change.value }];
      }
      /** Secrets an object omits are kept from the document before this change. */
      const fields = preservePatchedConfigSecretFields(change.fields, overrides);
      return toOrderedWrites([{ target: change.target, value: change.value }], fields).map(
        (write) => ({ op: 'set', segments: write.segments, value: write.value }),
      );
    }
    case 'unset':
    case 'tombstone':
      return (change.paths ?? [{ segments }]).map(
        (path) => ({ op: change.op, segments: path.segments, entry: path.entry }) as ConfigChange,
      );
    case 'upsertEntry': {
      /** An entry that omits its secret keeps the one stored on the entry of the same key. */
      const [entry] = preserveConfigSecrets(
        [change.entry ?? {}],
        overrides,
        change.target.fieldPath,
      );
      return [{ op: 'upsertEntry', segments, entry }];
    }
    case 'removeEntry':
      return [{ op: 'removeEntry', segments, key: change.key ?? '' }];
    case 'rename':
      return [{ op: 'rename', segments, from: change.key ?? '', to: change.to ?? '' }];
  }
}

/**
 * Whether `librechat.yaml` itself defines entry `name` of the collection a change addresses:
 * an entry of a merged-by-key array by its identity, so `ollama` names the YAML `Ollama`.
 */
function isYamlEntry(base: unknown, change: PreparedChange, name: string): boolean {
  const node = getAtPath(base, change.target.segments);
  const keyField = getConfigArrayMergeKey(change.target.segments);
  if (keyField) {
    return (
      Array.isArray(node) &&
      node.some(getConfigEntryMatcher(change.target.segments, keyField, name))
    );
  }
  return isPlainRecord(node) && Object.prototype.hasOwnProperty.call(node, name);
}

/**
 * What `librechat.yaml` keeps whatever an override does: the MCP servers it runs as local
 * processes, and the base-only and deployment-only fields that have a value the merge puts back:
 * set in `base`, or in `resolved`, the AppConfig librechat.yaml resolves to (defaults included).
 */
interface YamlHeld {
  processServers: ReadonlySet<string>;
  heldPaths: readonly YamlHeldPath[];
}

function getYamlHeld(base: Partial<TCustomConfig>, resolved?: AppConfig): YamlHeld {
  return {
    processServers: getProcessServerNames(base),
    heldPaths: YAML_HELD_PATHS.filter(
      ({ segments }) =>
        getAtPath(base, segments) !== undefined || getAtPath(resolved, segments) !== undefined,
    ),
  };
}

type IgnoredPart = { segments: string[]; reason: AdminConfigIgnoreReason };

/**
 * The MCP servers librechat.yaml runs as local processes that a tombstone of the whole
 * `mcpServers` section leaves in place. A change inside one is refused before it applies, and a
 * whole-section value leaves them out, so this is the only change that reaches one.
 */
function getProcessServerParts(
  change: PreparedChange,
  processServers: ReadonlySet<string>,
): IgnoredPart[] {
  const { segments } = change.target;
  if (change.op !== 'tombstone' || segments.length !== 1 || segments[0] !== 'mcpServers') {
    return [];
  }
  return [...processServers].map((server) => ({
    segments: ['mcpServers', server],
    reason: 'process_mcp_server',
  }));
}

/**
 * The parts of an applied change the runtime merge drops: the YAML stdio MCP servers a tombstone
 * of the whole section leaves in place, and the base-only and deployment-only fields
 * librechat.yaml sets below a tombstone (a tombstone of one itself is skipped), which the merge
 * puts back so the tombstone hides only the rest.
 */
function getIgnoredParts(change: PreparedChange, held: YamlHeld): IgnoredPart[] {
  const parts = getProcessServerParts(change, held.processServers);
  if (change.op !== 'tombstone') {
    return parts;
  }
  const { segments } = change.target;
  const kept = held.heldPaths
    .filter((path) => path.segments.length > segments.length)
    .filter((path) => isSegmentPrefix(segments, path.segments))
    .map((path): IgnoredPart => ({ segments: [...path.segments], reason: path.reason }));
  return [...parts, ...kept];
}

const AZURE_GROUPS_SEGMENTS = ['endpoints', EModelEndpoint.azureOpenAI, 'groups'];

function isAzureGroupsTarget(segments: readonly string[]): boolean {
  return (
    segments.length === AZURE_GROUPS_SEGMENTS.length &&
    isSegmentPrefix(AZURE_GROUPS_SEGMENTS, segments)
  );
}

/**
 * The parts of an applied change the merge leaves inert where the deployment does not resolve
 * Azure groups (`CONFIG_REDERIVE_ENDPOINTS` off; `endpoint_rederive_off`): a `set` of the groups,
 * or of an object whose value holds them, an `upsertEntry` or `rename` of a group, and a tombstone
 * of the groups or of one of them (keyed). An `unset` or `removeEntry` only clears what is stored.
 */
function getInertGroupParts(change: PreparedChange): IgnoredPart[] {
  const { segments } = change.target;
  const whole: IgnoredPart[] = [{ segments: [...segments], reason: 'endpoint_rederive_off' }];
  if (change.op === 'tombstone' || change.op === 'upsertEntry' || change.op === 'rename') {
    return isAzureGroupsTarget(segments) ? whole : [];
  }
  if (change.op !== 'set' || change.paths) {
    return [];
  }
  if (isSegmentPrefix(AZURE_GROUPS_SEGMENTS, segments)) {
    return whole;
  }
  const inside = AZURE_GROUPS_SEGMENTS.slice(segments.length);
  return isSegmentPrefix(segments, AZURE_GROUPS_SEGMENTS) &&
    Array.isArray(getAtPath(change.value, inside))
    ? [{ segments: [...AZURE_GROUPS_SEGMENTS], reason: 'endpoint_rederive_off' }]
    : [];
}

/**
 * A `set` of a whole `mcpServers` value without the servers librechat.yaml runs as local
 * processes, re-encrypted, and the parts it left out; with nothing left, it resets the path. Any
 * other change is returned as is.
 */
function withoutProcessServers(
  change: PreparedChange,
  processServers: ReadonlySet<string>,
): { change: PreparedChange; skipped: SkippedChange[] } {
  if (change.op !== 'set' || change.paths) {
    return { change, skipped: [] };
  }
  const filtered = stripProcessServers(change.target.segments, change.value, processServers);
  if (filtered.skipped.length === 0) {
    return { change, skipped: [] };
  }
  const ref = toChangeRef(change);
  const skipped = filtered.skipped.map(({ segments, reason }) => ({ ...ref, segments, reason }));
  if (filtered.emptied) {
    return {
      change: {
        ...change,
        value: undefined,
        fields: undefined,
        paths: getRemovalPaths(change.target),
      },
      skipped,
    };
  }
  const fields = change.target.dotFree
    ? encryptConfigSecretFields({ [change.target.fieldPath]: filtered.value })
    : undefined;
  return { change: { ...change, value: filtered.value, fields }, skipped };
}

/** How an applied change is named in audit metadata: its path, plus the entry it addressed. */
function describeChange(change: PreparedChange): string {
  const path = describeFieldTarget(change.target);
  if (change.target.entry) {
    return path;
  }
  if (change.op === 'rename') {
    return `${path}[${JSON.stringify(change.key)}->${JSON.stringify(change.to)}]`;
  }
  return change.key !== undefined ? `${path}[${JSON.stringify(change.key)}]` : path;
}

/**
 * Where the value an applied change sends sits in the document it leaves (`next`): a set's path,
 * or an upserted entry at its position in its collection. `null` for a change that sends none.
 */
function getSentLocation(change: PreparedChange, next: ConfigOverrideState): string[] | null {
  const { segments } = change.target;
  if (change.op === 'set' && !change.paths) {
    return [...segments];
  }
  if (change.op !== 'upsertEntry') {
    return null;
  }
  const keyField = getConfigArrayMergeKey(segments);
  const entries = getAtPath(next.overrides, segments);
  const index =
    keyField && Array.isArray(entries)
      ? entries.findIndex(getConfigEntryMatcher(segments, keyField, change.key ?? ''))
      : -1;
  return index >= 0 ? [...segments, String(index)] : null;
}

/**
 * Env reference issues in the value an applied change sent, by identity
 * (`toConfigIdentityPath`): each location is named in the document the change left, with every
 * entry of a merged-by-key array by its key, so the issue still names that entry however later
 * changes of the batch move, add or remove other entries.
 */
function getSentEnvIssuePaths(
  change: PreparedChange,
  next: ConfigOverrideState,
  policy: EnvReferencePolicy,
): ConfigIdentityStep[][] {
  const location = getSentLocation(change, next);
  if (!location) {
    return [];
  }
  return getEnvReferenceIssues(change.value, policy, location).map(({ segments }) =>
    toConfigIdentityPath(next.overrides, segments),
  );
}

/**
 * Env reference issues for the values a batch's changes sent, judged on the document the batch
 * leaves as its other issues are. Each is held by identity (`getSentEnvIssuePaths`), carried
 * through the batch's later renames, and named where the batch leaves the value; it counts only
 * when the end state still holds a disallowed reference there (as stored, ciphertext by its
 * plaintext) at a location the batch changed (`written`). A reference a later change removed or
 * replaced, or one that leaves the stored value as it was, does not.
 */
function getBatchEnvIssues(
  sent: ReadonlyArray<readonly ConfigIdentityStep[]>,
  state: ConfigOverrideState,
  written: ReadonlyArray<readonly string[]>,
  policy: EnvReferencePolicy,
): ConfigOverrideIssue[] {
  const reported = new Set<string>();
  return sent.flatMap((path): ConfigOverrideIssue[] => {
    const segments = resolveConfigIdentityPath(state.overrides, path);
    if (!segments) {
      return [];
    }
    const kept = getAtPath(state.overrides, segments);
    const key = segments.join('\u0000');
    if (
      reported.has(key) ||
      typeof kept !== 'string' ||
      !hasDisallowedStoredReference(kept, policy, segments) ||
      !written.some((writtenPath) => isSegmentPrefix(writtenPath, segments))
    ) {
      return [];
    }
    reported.add(key);
    return [{ path: segments.join('.'), segments, code: ENV_REFERENCE_NOT_ALLOWED }];
  });
}

/**
 * The secret values a batch's changes entered, encrypted, before secret preservation fills in
 * what they omit (see `getEnteredConfigSecrets`).
 */
function getEnteredChangeSecrets(changes: readonly PreparedChange[]): Set<string> {
  return getEnteredConfigSecrets(
    changes.flatMap((change): ConfigFieldWrite[] => {
      if (change.op === 'upsertEntry' && change.entry) {
        return [{ segments: change.target.segments, value: [change.entry] }];
      }
      if (change.op !== 'set' || !change.fields) {
        return [];
      }
      return Object.entries(change.fields).map(([fieldPath, value]) => ({
        segments: parseFieldPath(fieldPath),
        value,
      }));
    }),
  );
}

// ── Handler factory ──────────────────────────────────────────────────

export function createAdminConfigHandlers(deps: AdminConfigDeps): {
  listConfigs: (req: ServerRequest, res: Response) => Promise<Response>;
  getConfigMeta: (req: ServerRequest, res: Response) => Promise<Response>;
  getBaseConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  getConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  upsertConfigOverrides: (req: ServerRequest, res: Response) => Promise<Response>;
  patchConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  tombstoneConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteConfigField: (req: ServerRequest, res: Response) => Promise<Response>;
  applyConfigChanges: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteConfigOverrides: (req: ServerRequest, res: Response) => Promise<Response>;
  toggleConfig: (req: ServerRequest, res: Response) => Promise<Response>;
  updateConfigPriority: (req: ServerRequest, res: Response) => Promise<Response>;
  reloadConfig: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    listAllConfigs,
    findConfigByPrincipal,
    writeConfigDocument,
    unsetConfigField,
    deleteConfig,
    toggleConfigActiveTracked,
    setConfigPriority,
    principalExists,
    hasConfigCapability,
    hasAnyConfigReadAccess = async () => false,
    getReadableConfigSections = async (u, sections) => {
      if (await hasConfigCapability(u, null, 'read')) {
        return { broad: true, sections: new Set(sections) };
      }
      const held = await Promise.all(
        sections.map((section) => hasConfigCapability(u, section, 'read')),
      );
      return { broad: false, sections: new Set(sections.filter((_, i) => held[i])) };
    },
    hasCapability = async () => false,
    getAppConfig,
    invalidateConfigCaches,
    reloadConfigCaches,
    recordAuditEntry,
    auditFailClosed,
    overrideCacheTtlMs = DEFAULT_OVERRIDE_CACHE_TTL,
    overrideEnvAllowlist,
    rederiveEndpoints = false,
  } = deps;

  const envAllowlist = parseEnvAllowlist(overrideEnvAllowlist);

  const emitAudit = createAdminAuditEmitter({
    recordAuditEntry,
    failClosed: auditFailClosed,
    logPrefix: '[adminConfig]',
  });

  function readStoredConfig(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<ConfigRecord | null> {
    return findConfigByPrincipal(principalType, principalId, { includeInactive: true });
  }

  /**
   * The partitions a write to the principal's document involves (`WriteScope`). A caller inside
   * a tenant reaches only that tenant's documents, and a role's document is always the one in
   * the caller's partition. A caller without a tenant addresses group and user documents by id,
   * whichever tenant holds them, so the stored document names the partition the write is
   * judged in: a profile merges over the Base of its own partition, not the caller's.
   */
  async function resolveWriteScope(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<WriteScope> {
    const activeTenantId = getActivePartition();
    if (activeTenantId || principalType === PrincipalType.ROLE) {
      return { tenantId: activeTenantId, activeTenantId };
    }
    const stored = await readStoredConfig(principalType, principalId);
    return { tenantId: stored ? getConfigPartition(stored) : undefined, activeTenantId };
  }

  /** The write's scope and librechat.yaml as the partition it is judged in resolves it. */
  async function loadWriteScope(
    principalType: PrincipalType,
    principalId: string,
  ): Promise<{ scope: WriteScope; baseConfig: AppConfig | undefined }> {
    const scope = await resolveWriteScope(principalType, principalId);
    return { scope, baseConfig: await getBaseAppConfig(scope.tenantId) };
  }

  /**
   * Reads the document a write plans from, in the partition the write is judged in: the stored
   * document's own, or the caller's for a document the write would create. A document that no
   * longer lands there (removed and created again in another partition since the scope was
   * resolved) answers a revision conflict rather than being judged on another partition's Base.
   */
  async function readScopedConfig(
    principalType: PrincipalType,
    principalId: string,
    scope: WriteScope,
  ): Promise<ConfigRecord | null> {
    const stored = await readStoredConfig(principalType, principalId);
    const partition = stored ? getConfigPartition(stored) : scope.activeTenantId;
    if (partition !== scope.tenantId) {
      throw new ConfigRevisionConflictError(stored ? getConfigRevision(stored) : null);
    }
    return stored;
  }

  /**
   * Clears the caches a write affects before the response goes out, so the caller's next read
   * sees the write. A failure is logged, not surfaced: the write itself has committed.
   */
  async function invalidateCaches(tenantId: string | undefined, operation: string): Promise<void> {
    try {
      await invalidateConfigCaches?.(tenantId);
    } catch (error) {
      logger.error(
        `[adminConfig] Cache invalidation failed after ${operation}:`,
        getSafeErrorMetadata(error),
      );
    }
  }

  /**
   * 200 for a write with nothing to apply, reporting the stored revision and, for a field write,
   * the parts it skipped and the stored document as a read under `access` shows it (`null` when
   * there is none). The precondition still holds: a document that is not at `expectedRevision`
   * answers 409, as the write would.
   */
  async function noopResponse(
    res: Response,
    message: string,
    principalType: PrincipalType,
    principalId: string,
    expectedRevision: ConfigRevision | undefined,
    report?: { skipped: readonly SkippedPart[]; access: ReadableSections },
  ): Promise<Response> {
    const stored = await readStoredConfig(principalType, principalId);
    const revision = stored ? getConfigRevision(stored) : null;
    if (expectedRevision && expectedRevision !== getExpectedRevision(stored)) {
      return conflictResponse(res, revision, principalType, principalId);
    }
    return res.status(200).json({
      message,
      revision,
      ...(report && {
        config: stored ? toWrittenConfig(stored, report.access) : null,
        ...toWriteReport([], report.skipped),
      }),
    });
  }

  async function conflictResponse(
    res: Response,
    knownRevision: ConfigRevision | null | undefined,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<Response> {
    let currentRevision = knownRevision;
    if (currentRevision === undefined) {
      const stored = await readStoredConfig(principalType, principalId);
      currentRevision = stored ? getConfigRevision(stored) : null;
    }
    return res.status(409).json({
      error: 'Config was modified by another request',
      code: 'CONFIG_VERSION_CONFLICT',
      currentRevision,
    });
  }

  /**
   * Maps the expected failures of a write to their responses; anything else is rethrown. A
   * conflict that does not carry the current revision rereads it from the document the write
   * addressed (for a role, in the caller's tenant partition).
   */
  async function writeFailureResponse(
    res: Response,
    error: unknown,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<Response> {
    if (isConfigRevisionConflict(error)) {
      return conflictResponse(res, error.currentRevision, principalType, principalId);
    }
    if (isConfigPathError(error)) {
      return invalidPathResponse(res, error);
    }
    throw error;
  }

  /**
   * Unsets or tombstones a path (a dot-free secret together with its preview) in a write
   * planned from the document it replaces, so each check judges exactly the revision the write
   * lands on: a tombstone that creates the principal's first document needs the principal
   * (`canCreateFor`), and a removal that changes where a stored credential is sent needs it
   * entered again, as a write would: a web search URL beside a stored key, an Azure group's
   * destination beside its stored key, or a field of an MCP server that keeps a stored credential
   * (judged over librechat.yaml as the document's partition resolves it, as on every write). A
   * write that lands in between is re-read and re-checked, or answers 409 under
   * `expectedRevision`. An unset stops when there is no document. `loadedBase` is the base config
   * the caller already read, if any.
   */
  async function removeConfigPath(
    principalType: PrincipalType,
    principalId: string,
    target: FieldTarget,
    removal: { tombstone: true; priority?: number } | { tombstone: false },
    expectedRevision: ConfigRevision | undefined,
    scope: WriteScope,
    loadedBase?: AppConfig,
  ): Promise<ConfigMutationOutcome<RemovalStop>> {
    const paths = getRemovalPaths(target);
    const needsBase =
      MCP_SECTIONS.has(target.segments[0]) ||
      isAzureGroupPath(target.segments) ||
      isBoundKeyPath(target.segments);
    const baseConfig = needsBase
      ? (loadedBase ?? (await getBaseAppConfig(scope.tenantId)))
      : undefined;
    const base: Partial<TCustomConfig> = baseConfig?.config ?? {};
    return runConfigMutation<RemovalStop>(
      {
        read: () => readScopedConfig(principalType, principalId, scope),
        write: (draft, revision) =>
          writeConfigDocument(principalType, principalId, draft, revision),
      },
      async (stored) => {
        if (!stored && !removal.tombstone) {
          return { draft: null, result: { status: 404, missing: 'config' } };
        }
        if (!stored && !(await canCreateFor(principalType, principalId))) {
          return { draft: null, result: { status: 404, missing: 'principal' } };
        }
        const current = toConfigOverrideState(stored);
        const state = removal.tombstone
          ? tombstoneConfigPaths(current, paths)
          : unsetConfigPaths(current, paths);
        const reentry = getKeptKeyReentryIssues(stored, state, NO_ENTERED_SECRETS, baseConfig);
        if (reentry.length > 0) {
          return { draft: null, result: { status: 400, reentry } };
        }
        const mcpReentry = findSecretReentry({
          stored,
          candidate: state,
          base,
          entered: NO_ENTERED_SECRETS,
        });
        if (mcpReentry) {
          return { draft: null, result: { status: 400, mcpReentry } };
        }
        const bound = bindSecretDestinations({
          stored,
          candidate: state,
          entered: NO_ENTERED_SECRETS,
        });
        return {
          draft: {
            principalModel: stored?.principalModel ?? principalModel(principalType),
            priority:
              (removal.tombstone ? removal.priority : undefined) ??
              stored?.priority ??
              getDefaultConfigPriority({ principalType, principalId }),
            overrides: bound.overrides,
            tombstones: bound.tombstones,
            isActive: stored?.isActive ?? true,
          },
        };
      },
      { expectedRevision },
    );
  }

  /**
   * The deployment's resolved `librechat.yaml` config. Its raw `config` is what overrides are
   * validated on top of, and what decides which env names they may reference.
   */
  async function getBaseAppConfig(tenantId?: string): Promise<AppConfig | undefined> {
    if (!getAppConfig) {
      return undefined;
    }
    return getAppConfig({ tenantId, baseOnly: true });
  }

  function getEnvPolicy(baseYaml: Partial<TCustomConfig>): EnvReferencePolicy {
    return createEnvReferencePolicy({ config: baseYaml, allowlist: envAllowlist });
  }

  /**
   * The secrets the written document's layer drops at merge (`app/rebinding.ts`): inherited ones
   * it sends somewhere new, and its own whose destination a layer below changed. Judged on the
   * Base floor: librechat.yaml, then the active Base profile (for any other principal; Base
   * always merges first), then this document. A user or group can have other profiles in
   * between, so this is what the document does over the floor. PUT, PATCH and change batches
   * report it (a dry run for the document it plans) on the Base their write was last judged on
   * (`base`), and field removals and tombstones in a section with bound secrets read it, in the
   * partition the document merges in (`tenantId`); the base config is loaded only when the
   * document overrides or tombstones such a section. A failure is logged and reports nothing:
   * the write itself has committed.
   */
  async function reportIgnored(
    written: ConfigOverrideLayer,
    tenantId: string | undefined,
    loaded?: {
      baseConfig: AppConfig | undefined;
      envPolicy: EnvReferencePolicy;
      base?: ConfigRecord | null;
    },
  ): Promise<AdminConfigIgnoredSecret[]> {
    if (!touchesBoundSecretSections(written)) {
      return [];
    }
    try {
      const baseConfig = loaded ? loaded.baseConfig : await getBaseAppConfig(tenantId);
      if (!baseConfig) {
        return [];
      }
      const envPolicy = loaded?.envPolicy ?? getEnvPolicy(baseConfig.config ?? {});
      const writtenId = written.principalId?.toString();
      const isBase = isBaseConfigPrincipal(written);
      let floor: ConfigRecord | null = null;
      if (!isBase) {
        floor = loaded?.base !== undefined ? loaded.base : await readActiveBase(tenantId);
      }
      const ignored: AdminConfigIgnoredSecret[] = [];
      mergeOverrideLayers(baseConfig, floor ? [floor, written] : [written], {
        envPolicy,
        rederiveEndpoints,
        onRebinding: (rebinding) => {
          if (
            rebinding.layer.principalType === written.principalType &&
            rebinding.layer.principalId?.toString() === writtenId
          ) {
            ignored.push(toIgnoredSecretOverride(rebinding));
          }
        },
      });
      return ignored;
    } catch (error) {
      logger.error(
        '[adminConfig] Failed to report ignored overrides:',
        getSafeErrorMetadata(error),
      );
      return [];
    }
  }

  /**
   * librechat.yaml and, for any principal but Base, the active Base document of one partition,
   * to judge a stored document on (`reportStoredIgnored`). A read that fails is logged and comes
   * back `undefined`, so the document reads without the report rather than with a wrong one.
   */
  function loadJudgement(
    tenantId: string | undefined,
    isBase: boolean,
  ): Promise<[AppConfig | undefined, ConfigRecord | null | undefined]> {
    return Promise.all([
      getBaseAppConfig(tenantId).catch((error: unknown) => {
        logger.error(
          '[adminConfig] getConfig could not load the base config to judge the document:',
          getSafeErrorMetadata(error),
        );
        return undefined;
      }),
      isBase
        ? null
        : readActiveBase(tenantId).catch((error: unknown) => {
            logger.error(
              '[adminConfig] getConfig could not read the Base document to judge the document:',
              getSafeErrorMetadata(error),
            );
            return undefined;
          }),
    ]);
  }

  /**
   * What the merge leaves out of a stored document's layer (`getIgnoredConfigOverrides`): parts
   * no merge applies, values set back to librechat.yaml's, values invalid where the merge applies
   * them, and the credentials it drops (`reportIgnored`), judged over librechat.yaml and, for any
   * principal but Base, the active Base document (`base`). `null` when there is no base config to
   * judge on or the judgement fails, which a read reports by leaving `ignored` out rather than
   * claiming nothing is ignored.
   */
  async function reportStoredIgnored(
    stored: ConfigRecord,
    tenantId: string | undefined,
    baseConfig: AppConfig | undefined,
    base: ConfigRecord | null,
  ): Promise<Array<AdminConfigIgnoredOverride | AdminConfigIgnoredSecret> | null> {
    if (!baseConfig) {
      return null;
    }
    try {
      const baseYaml: Partial<TCustomConfig> = baseConfig.config ?? {};
      const overrides = getIgnoredConfigOverrides(
        baseYaml,
        stored,
        base ? [base] : [],
        baseConfig,
        { expandCustomEndpoint, rederiveEndpoints },
      );
      const secrets = await reportIgnored(stored, tenantId, {
        baseConfig,
        envPolicy: getEnvPolicy(baseYaml),
        base,
      });
      return [...overrides, ...secrets];
    } catch (error) {
      logger.error(
        '[adminConfig] Failed to judge what a stored config leaves out:',
        getSafeErrorMetadata(error),
      );
      return null;
    }
  }

  /**
   * Binds the keys a planned document holds to the destinations they were entered for
   * (`bindSecretDestinations`): a key the request entered, to where the merge sends it over the
   * active Base when that is not where librechat.yaml and the document alone send it, as the
   * rebinding guard reports it (`SecretRebinding.binding`); a key it kept, to what is stored
   * beside it. A profile can then enter its own key for an endpoint, server or service Base
   * defines without restating the destination, and the key is dropped again once Base, or any
   * layer below the profile, moves that destination. Base merges first, so nothing moves its
   * keys from below. Destinations are judged as with `CONFIG_REDERIVE_ENDPOINTS` on, whatever
   * this deployment runs with, so a key entered for an Azure group while the groups are inert
   * keeps its destination once they apply.
   */
  function bindPlannedSecrets(params: {
    principalType: PrincipalType;
    principalId: string;
    stored: ConfigRecord | null;
    candidate: ConfigOverrideState;
    entered: ReadonlySet<string>;
    base: ConfigRecord | null;
    baseConfig: AppConfig | undefined;
    envPolicy: EnvReferencePolicy;
  }): ConfigOverrideState {
    const { principalType, principalId, stored, candidate, entered, base } = params;
    const kept = bindSecretDestinations({ stored, candidate, entered });
    if (
      base == null ||
      isBaseConfigPrincipal({ principalType, principalId }) ||
      !entersBoundSecret(kept, entered)
    ) {
      return kept;
    }
    const destinations = new Map<string, string>();
    const layer: ConfigOverrideLayer = {
      principalType,
      principalId,
      priority: getDefaultConfigPriority({ principalType, principalId }),
      overrides: kept.overrides,
      tombstones: kept.tombstones,
    };
    mergeOverrideLayers(params.baseConfig ?? ({} as AppConfig), [base, layer], {
      envPolicy: params.envPolicy,
      rederiveEndpoints: true,
      onRebinding: (rebinding) => {
        if (
          rebinding.binding != null &&
          rebinding.layer.principalType === principalType &&
          rebinding.layer.principalId?.toString() === principalId
        ) {
          destinations.set(getRebindingIdentity(rebinding.segments), rebinding.binding);
        }
      },
    });
    if (destinations.size === 0) {
      return kept;
    }
    return bindSecretDestinations({ stored, candidate: kept, entered, destinations });
  }

  /**
   * The active Base document of one tenant partition (`undefined`: the deployment's own). The
   * config store addresses every role document in the active partition, so another tenant's
   * Base is read in that tenant's context; the partition rules themselves stay the store's.
   */
  function readActiveBase(tenantId: string | undefined): Promise<ConfigRecord | null> {
    return runInPartition(tenantId, () =>
      findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID),
    );
  }

  /**
   * Takes back a write this request made, only while the document is still at the revision the
   * write produced: the document it replaced is written back, or the one it created removed. A
   * write that landed since throws a revision conflict, and is left as it is.
   */
  async function withdrawWrite(
    principalType: PrincipalType,
    principalId: string,
    written: ConfigRecord,
    previous: ConfigRecord | null,
  ): Promise<ConfigRecord | null> {
    const revision = getConfigRevision(written);
    if (previous) {
      return writeConfigDocument(principalType, principalId, toConfigDraft(previous), revision);
    }
    await deleteConfig(principalType, principalId, undefined, { expectedRevision: revision });
    return null;
  }

  /**
   * Reads Base again after a profile write committed and, when it is no longer `read` (the Base
   * the write was planned on), judges the request on it. `null` when Base did not move, or when
   * that cannot be told: the committed write then stands, as it would had Base moved just after
   * it, and is never turned into a failure.
   */
  async function judgeOnLandedBase<T>(
    tenantId: string | undefined,
    read: ConfigRecord | null,
    judge: (landed: ConfigRecord | null) => Promise<ConfigMutationPlan<T>>,
  ): Promise<ConfigMutationPlan<T> | null> {
    try {
      const landed = await readActiveBase(tenantId);
      if ((landed && getConfigRevision(landed)) === (read && getConfigRevision(read))) {
        return null;
      }
      return await judge(landed);
    } catch (error) {
      logger.warn(
        '[adminConfig] A profile write could not be checked on the Base it landed over; it stands',
        getSafeErrorMetadata(error),
      );
      return null;
    }
  }

  /**
   * Runs a write that validates on the config the principal's overrides land on, before its own
   * tombstones (the floor): `librechat.yaml` with the active Base document resolved over it,
   * exactly as the merge layers Base under every profile (Base always merges first), or
   * `librechat.yaml` alone for Base itself. The principal's other profiles vary per user and
   * are left to the merge. Base is read from the partition the document merges in
   * (`scope.tenantId`): the caller's for a role, and for a group or user document a caller
   * without a tenant addresses by id, the tenant that holds it, whose Base that profile merges
   * over; each attempt reads the document in that partition only (`readScopedConfig`). `yaml` is
   * librechat.yaml as that partition resolves it. With `yaml` `null`
   * the write does not validate on the floor, and `plan` gets an empty one. `plan` also gets the
   * Base document itself (`null` for Base, or when none is active), which binds the keys the
   * write enters to the destinations they are sent to over it (`bindPlannedSecrets`).
   *
   * Base is its own document, which the profile's compare-and-swap does not cover. So each
   * attempt reads Base beside the profile (a retry never reuses a Base a concurrent write has
   * replaced), and once the write commits Base is read again. When it moved meanwhile, the
   * request is judged once more, `plan` on the document the write replaced, on the Base the
   * write landed over (`judgeOnLandedBase`): a write still valid there stands, and one that is
   * not is withdrawn (`withdrawWrite`) and answered with that judgement.
   *
   * The outcome carries the Base it was last judged on (`base`, `undefined` when none was
   * read), so what the written or planned document drops at merge (`reportIgnored`) is judged
   * on the same Base without reading it again.
   */
  async function runOnValidationFloor<T>(
    principalType: PrincipalType,
    principalId: string,
    scope: WriteScope,
    yaml: Partial<TCustomConfig> | null,
    plan: (
      stored: ConfigRecord | null,
      floor: Partial<TCustomConfig>,
      base: ConfigRecord | null,
    ) => Promise<ConfigMutationPlan<T>>,
    expectedRevision: ConfigRevision | undefined,
  ): Promise<FloorOutcome<T>> {
    const readsBase = yaml != null && !isBaseConfigPrincipal({ principalType, principalId });
    const attempt: { base: ConfigRecord | null } = { base: null };
    const floorOver = (base: ConfigRecord | null): Partial<TCustomConfig> => {
      if (yaml == null) {
        return {};
      }
      return base ? resolveRawConfig(yaml, [base], getWriteDerivation(yaml)) : yaml;
    };
    const outcome = await runConfigMutation<T>(
      {
        read: async () => {
          const [stored, base] = await Promise.all([
            readScopedConfig(principalType, principalId, scope),
            readsBase ? readActiveBase(scope.tenantId) : null,
          ]);
          attempt.base = base;
          return stored;
        },
        write: (draft, revision) =>
          writeConfigDocument(principalType, principalId, draft, revision),
      },
      (stored) => plan(stored, floorOver(attempt.base), attempt.base),
      { expectedRevision },
    );
    if (!readsBase) {
      return outcome;
    }
    if (!outcome.written) {
      return { ...outcome, base: attempt.base };
    }
    const judged = await judgeOnLandedBase(scope.tenantId, attempt.base, (landed) => {
      attempt.base = landed;
      return plan(outcome.previous, floorOver(landed), landed);
    });
    if (judged == null || judged.draft != null) {
      return { ...outcome, base: attempt.base };
    }
    const current = await withdrawWrite(
      principalType,
      principalId,
      outcome.record,
      outcome.previous,
    );
    await invalidateCaches(scope.activeTenantId, 'withdrawn write');
    return { written: false, current, result: judged.result, base: attempt.base };
  }

  /**
   * Whether a write may create the principal's first document: it must exist in the caller's
   * tenant partition. Base always may, and nothing is checked without `principalExists`.
   */
  async function canCreateFor(principalType: PrincipalType, principalId: string): Promise<boolean> {
    if (!principalExists || isBaseConfigPrincipal({ principalType, principalId })) {
      return true;
    }
    return principalExists(principalType, principalId);
  }

  /**
   * Resolves which sections a write's response may show: the ones the caller can read. Those
   * already include each section it manages, because the grant layer resolves
   * `read:configs:<section>` from the same section's `manage:configs:<section>`, so a GET shows a
   * section manager that whole section. The written sections are added anyway, so the reply
   * always carries what was stored. It covers every schema section in one batched lookup, so it
   * runs alongside the write's other pre-reads, and a failed lookup fails the request before
   * anything is stored instead of turning a committed write into a 500. Broad managers can read
   * every section and skip it.
   */
  async function resolveWriteReadAccess(
    user: CapabilityUser,
    hasBroadManage: boolean,
    managedSections: readonly string[],
  ): Promise<ReadableSections> {
    if (hasBroadManage) {
      return FULL_READ_ACCESS;
    }
    const readable = await getReadableConfigSections(user, CONFIG_SCHEMA_SECTIONS);
    return {
      broad: readable.broad,
      sections: new Set([...readable.sections, ...managedSections]),
    };
  }

  /**
   * GET / — List all active config overrides.
   */
  async function listConfigs(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }

      const configs = await listAllConfigs();
      const sections = [...new Set(configs.flatMap(collectConfigSections))] as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filtered = configs.map((config) => filterConfigDocForReadAccess(config, readable));

      const safeConfigs = filtered.map(redactConfigForResponse);
      return res.status(200).json({ configs: safeConfigs });
    } catch (error) {
      logger.error('[adminConfig] listConfigs error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to list configs' });
    }
  }

  /**
   * GET /meta — The contract this server applies to config writes: feature flags, limits,
   * versions and the rules a client mirrors. An older server answers 404, which a client reads
   * as every feature off.
   */
  async function getConfigMeta(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }

      const baseConfig = await getBaseAppConfig(user.tenantId);
      const meta = buildAdminConfigMeta(
        {
          maxPatchEntries: MAX_PATCH_ENTRIES,
          maxChangeOps: MAX_CONFIG_CHANGE_OPS,
          maxEntryKeyLength: MAX_CONFIG_ENTRY_KEY_LENGTH,
          overrideCacheTtlMs,
          catalogModelsTtlMs: getCatalogModelsTtlMs(baseConfig),
        },
        { rederiveEndpoints },
      );
      return res.status(200).json(meta);
    } catch (error) {
      logger.error('[adminConfig] getConfigMeta error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to get config meta' });
    }
  }

  /**
   * GET /base — Return the raw AppConfig (YAML + DB base merged).
   * This is the full config structure admins can edit, NOT the startup payload.
   */
  async function getBaseConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (!getAppConfig) {
        return res.status(501).json({ error: 'Base config endpoint not configured' });
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }

      const baseOnly = (req.query as Record<string, unknown>).baseOnly === 'true';
      const [appConfig, yamlConfig] = await Promise.all([
        getAppConfig({ tenantId: user.tenantId, baseOnly, bypassOverrideCache: true }),
        baseOnly ? undefined : getAppConfig({ tenantId: user.tenantId, baseOnly: true }),
      ]);
      const sections = collectAppConfigSections(appConfig) as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filteredAppConfig = filterAppConfigForReadAccess(appConfig, readable);

      return res
        .status(200)
        .json({ config: redactAppConfigForResponse(filteredAppConfig, yamlConfig) });
    } catch (error) {
      logger.error('[adminConfig] getBaseConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to get base config' });
    }
  }

  /**
   * GET /:principalType/:principalId — Get config for a specific principal.
   */
  async function getConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (!(await hasAnyConfigReadAccess(user))) {
        return forbiddenResponse(res);
      }

      const isBase = isBaseConfigPrincipal({ principalType, principalId });
      /**
       * The document is judged in the partition it merges in, as writes judge it: the caller's,
       * read beside the document, or, for a group or user document a caller without a tenant
       * reads from a tenant, that tenant's, read once the document names it.
       */
      const activePartition = getActivePartition();
      const [config, judgedInActive] = await Promise.all([
        findConfigByPrincipal(principalType, principalId, { includeInactive: true }),
        loadJudgement(activePartition, isBase),
      ]);
      if (!config) {
        return configNotFoundResponse(res);
      }
      const partition = getConfigPartition(config);
      const [baseConfig, base] =
        partition === activePartition ? judgedInActive : await loadJudgement(partition, isBase);

      const sections = collectConfigSections(config) as ConfigSection[];
      const readable = await getReadableConfigSections(user, sections);
      const filteredConfig = filterConfigDocForReadAccess(config, readable);
      const ignored =
        base === undefined ? null : await reportStoredIgnored(config, partition, baseConfig, base);

      return res.status(200).json({
        config: redactConfigForResponse(filteredConfig),
        ...(ignored && {
          ignored: ignored.filter(({ segments }) => canReadSection(readable, segments[0] ?? '')),
          ignoredBasis: isBase ? 'yaml' : 'base',
        }),
      });
    } catch (error) {
      logger.error('[adminConfig] getConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to get config' });
    }
  }

  /**
   * PUT /:principalType/:principalId — Replace entire overrides for a principal.
   */
  async function upsertConfigOverrides(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const { overrides, priority } = req.body as {
        overrides?: Partial<TCustomConfig>;
        priority?: number;
      };

      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
        return errorResponse(res, 400, 'INVALID_OVERRIDES', 'overrides must be a plain object');
      }

      const expected = readExpectedRevision(
        (req.body as { expectedRevision?: unknown }).expectedRevision,
      );
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const renames = readRenames((req.body as { renames?: unknown }).renames);
      if (!renames.ok) {
        return invalidRenameResponse(res, renames.reason);
      }

      const rawOverrides = overrides as Record<string, unknown>;
      if (hasProcessMCPServerConfig(rawOverrides.mcpServers)) {
        return errorResponse(res, 400, 'PROCESS_MCP_CONFIG', PROCESS_MCP_CONFIG_ERROR);
      }

      if (hasLangfuseHeadersOverride(rawOverrides)) {
        return errorResponse(res, 400, 'LANGFUSE_HEADERS_CONFIG', LANGFUSE_HEADERS_CONFIG_ERROR);
      }

      if (priority != null && !isValidPriority(priority)) {
        return invalidPriorityResponse(res);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const hasAssignConfigs =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));

      if (!hasAssignConfigs) {
        return forbiddenResponse(res);
      }

      /**
       * Checked before any section rule or secret encryption reads a dotted key as a path. A
       * dotted key is a section write, which only broad manage may make.
       */
      const dottedSectionIssues = getDottedSectionIssues(rawOverrides);
      if (dottedSectionIssues.length > 0) {
        return hasBroadManage
          ? invalidOverrideResponse(res, dottedSectionIssues)
          : forbiddenResponse(res);
      }

      /** What the API never stores is cut out section by section, and reported as skipped. */
      const skipped: SkippedPart[] = [];
      const filteredOverrides: Record<string, unknown> = {};
      for (const [section, value] of Object.entries(rawOverrides)) {
        const skipReason = getFieldSkipReason(section) ?? getHeldPathSkipReason([section]);
        if (skipReason) {
          skipped.push({ segments: [section], reason: skipReason });
          continue;
        }
        const filtered = filterWrittenValue([section], value);
        skipped.push(...filtered.skipped);
        if (!filtered.emptied) {
          defineKey(filteredOverrides, section, filtered.value);
        }
      }

      /** A create-only request is a lifecycle write even when it carries nothing. */
      const createOnly = expected.value === ABSENT_CONFIG_REVISION;
      const noopReport = {
        skipped,
        access: hasBroadManage ? FULL_READ_ACCESS : NO_READ_ACCESS,
      };

      if (Object.keys(filteredOverrides).length === 0 && priority == null && !createOnly) {
        logSkippedParts('Stripping', skipped);
        return noopResponse(
          res,
          'No actionable override sections provided',
          principalType,
          principalId,
          expected.value,
          noopReport,
        );
      }

      if (Object.keys(filteredOverrides).length > 0 && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on assign-only scope lifecycle upsert to ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }

      const scope = await resolveWriteScope(principalType, principalId);
      const baseConfig =
        Object.keys(filteredOverrides).length > 0
          ? await getBaseAppConfig(scope.tenantId)
          : undefined;
      const baseYaml: Partial<TCustomConfig> = baseConfig?.config ?? {};

      /** A stdio server librechat.yaml runs is left out, so a read written back still succeeds. */
      const processes = stripProcessServers(
        ['mcpServers'],
        filteredOverrides.mcpServers,
        getProcessServerNames(baseYaml),
      );
      if (processes.skipped.length > 0) {
        skipped.push(...processes.skipped);
        if (processes.emptied) {
          delete filteredOverrides.mcpServers;
        } else {
          filteredOverrides.mcpServers = processes.value;
        }
      }
      logSkippedParts('Stripping', skipped);

      const overrideSections = Object.keys(filteredOverrides);
      if (overrideSections.length === 0 && priority == null && !createOnly) {
        return noopResponse(
          res,
          'No actionable override sections provided',
          principalType,
          principalId,
          expected.value,
          noopReport,
        );
      }

      for (const section of getConfigSecretSections()) {
        const secretInputError = getConfigSecretInputError(section, filteredOverrides[section]);
        if (secretInputError) {
          return errorResponse(res, 400, 'SECRET_PATH', secretInputError);
        }
      }

      const envPolicy = getEnvPolicy(baseYaml);
      const envIssues = getEnvReferenceIssues(filteredOverrides, envPolicy);
      if (envIssues.length > 0) {
        return invalidOverrideResponse(res, envIssues);
      }

      const encryptedOverrides = encryptConfigSecrets(filteredOverrides);
      /** What the request itself supplies, before secret preservation fills in what it omits. */
      const requestWrites: ConfigFieldWrite[] = [{ segments: [], value: encryptedOverrides }];
      const entered = getEnteredConfigSecrets(requestWrites);
      /** A write without override sections (create-only or priority-only) validates nothing. */
      const yaml = overrideSections.length > 0 ? baseYaml : null;

      type PutStop =
        | { status: 403 }
        | { status: 404 }
        | { status: 400; issues: ConfigOverrideIssue[] }
        | { status: 400; renameIssue: string }
        | { status: 400; reentry: SecretReentryIssue[] }
        | { status: 400; mcpReentry: SecretReentry };
      let outcome;
      try {
        outcome = await runOnValidationFloor<PutStop>(
          principalType,
          principalId,
          scope,
          yaml,
          async (stored, floor, base) => {
            if (!stored && !(await canCreateFor(principalType, principalId))) {
              return { draft: null, result: { status: 404 } };
            }
            /** Assign-only callers manage the profile's lifecycle, never its contents. */
            if (
              !hasBroadManage &&
              stored &&
              !isConfigOverrideStateEmpty(toConfigOverrideState(stored))
            ) {
              return { draft: null, result: { status: 403 } };
            }
            const renameIssue = getRenameIssue(renames.renames, stored, requestWrites, baseYaml);
            if (renameIssue) {
              return { draft: null, result: { status: 400, renameIssue } };
            }
            /** Secrets an object omits are kept before validation sees the document. */
            const preserved = preserveConfigSecrets(encryptedOverrides, stored?.overrides);
            carryRenamedConfigSecrets(preserved, stored?.overrides, renames.renames);
            /** A full replace keeps the principal's tombstones (a renamed entry's move with it). */
            const storedState = renameConfigEntriesTombstones(
              toConfigOverrideState(stored),
              toEntryRenames(renames.renames),
            );
            const issues = getConfigOverrideIssues(
              preserved,
              applyConfigTombstones(floor, storedState.tombstones),
              getWriteDerivation(yaml),
            );
            if (issues.length > 0) {
              return { draft: null, result: { status: 400, issues } };
            }
            /** A changed URL beside a stored key that stays needs that key entered again. */
            const candidate = replaceConfigOverrides(storedState, preserved);
            const reentry = getKeptKeyReentryIssues(stored, candidate, entered, baseConfig);
            if (reentry.length > 0) {
              return { draft: null, result: { status: 400, reentry } };
            }
            const mcpReentry = findSecretReentry({ stored, candidate, base: baseYaml, entered });
            if (mcpReentry) {
              return { draft: null, result: { status: 400, mcpReentry } };
            }
            const next = { ...preserved } as Record<string, unknown>;
            if (principalId === BASE_CONFIG_PRINCIPAL_ID) {
              for (const section of BASE_PRINCIPAL_OVERRIDE_SECTIONS) {
                const storedSection = (stored?.overrides as Record<string, unknown> | undefined)?.[
                  section
                ];
                if (storedSection !== undefined) {
                  next[section] = storedSection;
                }
              }
            }
            const state = bindPlannedSecrets({
              principalType,
              principalId,
              stored,
              candidate: replaceConfigOverrides(storedState, next as Partial<TCustomConfig>),
              entered,
              base,
              baseConfig,
              envPolicy,
            });
            /** An omitted priority keeps the stored one, so a replace never reorders profiles. */
            const requestedPriority = hasBroadManage ? priority : undefined;
            return {
              draft: {
                principalModel: principalModel(principalType),
                priority:
                  requestedPriority ??
                  stored?.priority ??
                  getDefaultConfigPriority({ principalType, principalId }),
                overrides: state.overrides,
                tombstones: state.tombstones,
                isActive: true,
              },
            };
          },
          expected.value,
        );
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }

      if (!outcome.written) {
        const stop = outcome.result;
        if (stop.status === 403) {
          return forbiddenResponse(res);
        }
        if (stop.status === 404) {
          return principalNotFoundResponse(res);
        }
        if ('renameIssue' in stop) {
          return invalidRenameResponse(res, stop.renameIssue);
        }
        if ('reentry' in stop) {
          return secretReentryResponse(res, stop.reentry);
        }
        if ('mcpReentry' in stop) {
          return mcpReentryResponse(res, stop.mcpReentry);
        }
        return invalidOverrideResponse(res, stop.issues);
      }

      const { record: config, previous } = outcome;
      const created = previous == null;
      await invalidateCaches(user.tenantId, 'upsert');
      await emitAudit(req, {
        action: created ? 'config.created' : 'config.updated',
        target: configTarget(principalType, principalId),
        metadata: {
          operation: 'replace',
          sections: overrideSections.join(','),
          priority: config.priority,
          ...(renames.renames.length > 0 && { renames: describeRenames(renames.renames) }),
        },
      });
      return sendWrittenConfig(
        res,
        created ? 201 : 200,
        config,
        hasBroadManage ? FULL_READ_ACCESS : NO_READ_ACCESS,
        await reportIgnored(config, scope.tenantId, { baseConfig, envPolicy, base: outcome.base }),
        toWriteReport(
          overrideSections.map((section) => [section]),
          skipped,
        ),
      );
    } catch (error) {
      if (isFieldNameRejection(error)) {
        return unstorableKeyResponse(res, 'upsertConfigOverrides');
      }
      logger.error('[adminConfig] upsertConfigOverrides error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to upsert config' });
    }
  }

  /**
   * PATCH /:principalType/:principalId/fields — Set individual fields via dot-paths.
   *
   * A `fieldPath` (here, and for tombstones and unsets) is split on dots, so it cannot address
   * a record key that holds one, such as a Bedrock inference profile or a `gpt-4.1` model
   * entry: write that record whole at its own path (`endpoints.bedrock.inferenceProfiles`).
   */
  async function patchConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const { entries, priority } = req.body as {
        entries?: Array<{ fieldPath?: unknown; segments?: unknown; value: unknown } | null>;
        priority?: number;
      };

      if (priority != null && !isValidPriority(priority)) {
        return invalidPriorityResponse(res);
      }

      const expected = readExpectedRevision(
        (req.body as { expectedRevision?: unknown }).expectedRevision,
      );
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const renames = readRenames((req.body as { renames?: unknown }).renames);
      if (!renames.ok) {
        return invalidRenameResponse(res, renames.reason);
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        return errorResponse(
          res,
          400,
          'ENTRIES_REQUIRED',
          'entries array is required and must not be empty',
        );
      }

      if (entries.length > MAX_PATCH_ENTRIES) {
        return errorResponse(
          res,
          400,
          'PATCH_TOO_LARGE',
          `entries array exceeds maximum of ${MAX_PATCH_ENTRIES}`,
        );
      }

      const targets: Array<{ target: FieldTarget; value: unknown }> = [];
      /**
       * Every entry's section, a skipped entry's included: the caller must manage each section it
       * names, as on `/changes` and the tombstone route, and a write there that the API skips
       * answers 200 with the report.
       */
      const sections = new Set<string>();
      for (const entry of entries) {
        const read = readFieldTarget(entry?.fieldPath, entry?.segments);
        if (!read.ok) {
          return fieldTargetErrorResponse(res, read);
        }
        if (read.target.entry) {
          return fieldTargetErrorResponse(res, { error: KEYED_WRITE_ERROR, reason: 'keyed_path' });
        }
        const section = getTopLevelSection(read.target.fieldPath);
        if (!isAcceptedOverrideSection(section)) {
          return unknownSectionResponse(res);
        }
        const value = entry?.value;
        const guardError = getFieldWriteError(read.target.fieldPath, value);
        if (guardError) {
          return errorResponse(res, 400, guardError.code, guardError.error);
        }
        sections.add(section);
        targets.push({ target: read.target, value });
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      /**
       * What the API never stores is cut out entry by entry and reported as skipped. An entry
       * whose whole value is cut out resets its path (`reset`), as a whole value replaces what
       * is stored there; every entry applies in request order.
       */
      const skipped: SkippedPart[] = [];
      /** The entries that change the document, in request order. */
      let ordered: Array<{ target: FieldTarget; value: unknown; reset: boolean }> = [];
      for (const { target, value } of targets) {
        const skipReason =
          getFieldSkipReason(target.fieldPath) ?? getHeldPathSkipReason(target.segments);
        if (skipReason) {
          skipped.push({ segments: [...target.segments], reason: skipReason });
          continue;
        }
        const filtered = filterWrittenValue(
          target.segments,
          normalizeInterfaceFieldPatch(target.fieldPath, value),
        );
        skipped.push(...filtered.skipped);
        ordered.push({ target, value: filtered.value, reset: filtered.emptied });
      }
      const actionable = ordered.map(({ target }) => target);

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const managedSections = [...sections];
      if (!hasBroadManage) {
        const allowed = await Promise.all(
          managedSections.map((s) => hasConfigCapability(user, s as ConfigSection, 'manage')),
        );
        const denied = managedSections.find((_, i) => !allowed[i]);
        if (denied) {
          return forbiddenSectionResponse(res, denied);
        }
      }

      if (ordered.length === 0) {
        logSkippedParts('Stripping', skipped);
        return noopResponse(
          res,
          'No actionable field entries provided',
          principalType,
          principalId,
          expected.value,
          { skipped, access: await resolveWriteReadAccess(user, hasBroadManage, managedSections) },
        );
      }

      const seenTargets = new Set<string>();
      for (const target of actionable) {
        const key = target.dotFree ? target.fieldPath : JSON.stringify(target.segments);
        if (seenTargets.has(key)) {
          return errorResponse(
            res,
            400,
            'DUPLICATE_FIELD_PATH',
            target.dotFree
              ? `Duplicate fieldPath: ${target.fieldPath}`
              : 'Duplicate field path segments',
          );
        }
        seenTargets.add(key);
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on section-scoped patch to ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }
      const requestedPriority = hasBroadManage ? priority : undefined;

      const [{ scope, baseConfig }, access] = await Promise.all([
        loadWriteScope(principalType, principalId),
        resolveWriteReadAccess(user, hasBroadManage, managedSections),
      ]);
      const baseYaml: Partial<TCustomConfig> = baseConfig?.config ?? {};

      /**
       * librechat.yaml's stdio servers are shared processes no override changes: a write inside
       * one is refused, and one in a whole `mcpServers` value is left out (and reported).
       */
      const processServers = getProcessServerNames(baseYaml);
      if (actionable.some((target) => isProcessServerPath(target.segments, processServers))) {
        return processServerOverrideResponse(res);
      }
      ordered = ordered.map((entry) => {
        if (entry.reset) {
          return entry;
        }
        const filtered = stripProcessServers(entry.target.segments, entry.value, processServers);
        skipped.push(...filtered.skipped);
        return { target: entry.target, value: filtered.value, reset: filtered.emptied };
      });
      logSkippedParts('Stripping', skipped);

      const validEntries = ordered.filter(({ reset }) => !reset);
      const hasResets = validEntries.length < ordered.length;
      const fields: Record<string, unknown> = {};
      for (const { target, value } of validEntries) {
        if (target.dotFree) {
          fields[target.fieldPath] = value;
        }
      }

      const envPolicy = getEnvPolicy(baseYaml);
      const envIssues = validEntries.flatMap(({ target, value }) =>
        getEnvReferenceIssues(value, envPolicy, target.segments),
      );
      if (envIssues.length > 0) {
        return invalidOverrideResponse(res, envIssues);
      }

      const encryptedFields = encryptConfigSecretFields(fields);
      /** What the request itself supplies, before secret preservation fills in what it omits. */
      const requestWrites = toOrderedWrites(validEntries, encryptedFields);
      const entered = getEnteredConfigSecrets(requestWrites);

      type PatchStop =
        | { status: 404 }
        | { status: 400; issues: ConfigOverrideIssue[] }
        | { status: 400; renameIssue: string }
        | { status: 400; reentry: SecretReentryIssue[] }
        | { status: 400; mcpReentry: SecretReentry };
      let outcome;
      try {
        outcome = await runOnValidationFloor<PatchStop>(
          principalType,
          principalId,
          scope,
          baseYaml,
          async (stored, floor, base) => {
            if (!stored && !(await canCreateFor(principalType, principalId))) {
              return { draft: null, result: { status: 404 } };
            }
            const renameIssue = getRenameIssue(renames.renames, stored, requestWrites, baseYaml);
            if (renameIssue) {
              return { draft: null, result: { status: 400, renameIssue } };
            }
            /** Secrets an object omits are kept before validation sees the document. */
            const preservedFields = preservePatchedConfigSecretFields(
              encryptedFields,
              stored?.overrides,
            );
            for (const [fieldPath, value] of Object.entries(preservedFields)) {
              if (isConfigSecretPreservablePatch(fieldPath, value)) {
                carryRenamedConfigSecrets(value, stored?.overrides, renames.renames, fieldPath);
              }
            }
            const steps = toOrderedSteps(ordered, preservedFields);
            const writes = toStepWrites(steps);
            /** A renamed custom endpoint's keyed tombstones move to its new name. */
            const entryRenames = toEntryRenames(renames.renames);
            const fieldIssues = hasResets
              ? getPatchStepIssues(steps, floor, stored, entryRenames, getWriteDerivation(baseYaml))
              : getConfigFieldIssues(
                  writes,
                  floor,
                  stored,
                  entryRenames,
                  getWriteDerivation(baseYaml),
                );
            if (fieldIssues.length > 0) {
              return { draft: null, result: { status: 400, issues: fieldIssues } };
            }
            const state = renameConfigEntriesTombstones(
              applyPatchSteps(toConfigOverrideState(stored), steps),
              entryRenames,
            );
            /** A changed URL beside a stored key that stays needs that key entered again. */
            const reentry = getKeptKeyReentryIssues(stored, state, entered, baseConfig);
            if (reentry.length > 0) {
              return { draft: null, result: { status: 400, reentry } };
            }
            const mcpReentry = findSecretReentry({
              stored,
              candidate: state,
              base: baseYaml,
              entered,
            });
            if (mcpReentry) {
              return { draft: null, result: { status: 400, mcpReentry } };
            }
            const bound = bindPlannedSecrets({
              principalType,
              principalId,
              stored,
              candidate: state,
              entered,
              base,
              baseConfig,
              envPolicy,
            });
            return {
              draft: {
                principalModel: principalModel(principalType),
                priority:
                  requestedPriority ??
                  stored?.priority ??
                  getDefaultConfigPriority({ principalType, principalId }),
                overrides: bound.overrides,
                tombstones: bound.tombstones,
                isActive: stored?.isActive ?? true,
              },
            };
          },
          expected.value,
        );
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }

      if (!outcome.written) {
        const stop = outcome.result;
        if (stop.status === 404) {
          return principalNotFoundResponse(res);
        }
        if ('renameIssue' in stop) {
          return invalidRenameResponse(res, stop.renameIssue);
        }
        if ('reentry' in stop) {
          return secretReentryResponse(res, stop.reentry);
        }
        if ('mcpReentry' in stop) {
          return mcpReentryResponse(res, stop.mcpReentry);
        }
        return invalidOverrideResponse(res, stop.issues);
      }

      const { record: config, previous } = outcome;
      await invalidateCaches(user.tenantId, 'patch');
      await emitAudit(req, {
        action: previous == null ? 'config.created' : 'config.updated',
        target: configTarget(principalType, principalId),
        metadata: {
          operation: 'patch',
          fieldPaths: actionable.map(describeFieldTarget).join(','),
          ...(renames.renames.length > 0 && { renames: describeRenames(renames.renames) }),
        },
      });
      return sendWrittenConfig(
        res,
        200,
        config,
        access,
        await reportIgnored(config, scope.tenantId, { baseConfig, envPolicy, base: outcome.base }),
        toWriteReport(
          actionable.map((target) => target.segments),
          skipped,
        ),
      );
    } catch (error) {
      if (isFieldNameRejection(error)) {
        return unstorableKeyResponse(res, 'patchConfigField');
      }
      logger.error('[adminConfig] patchConfigField error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to patch config fields' });
    }
  }

  /**
   * POST /:principalType/:principalId/fields/tombstone — Suppress an inherited config path.
   *
   * An entry of an array merged by key is hidden by its key (`endpoints.custom["Name"]`, or a
   * path inside it); a path into an array by position is refused, since the merge removes
   * inherited values from objects only and would never apply it.
   */
  async function tombstoneConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const {
        fieldPath: rawFieldPath,
        segments,
        priority,
      } = req.body as {
        fieldPath?: unknown;
        segments?: unknown;
        priority?: number;
      };

      if (segments === undefined && (!rawFieldPath || typeof rawFieldPath !== 'string')) {
        return errorResponse(res, 400, 'INVALID_FIELD_PATH', 'fieldPath is required');
      }

      if (priority != null && !isValidPriority(priority)) {
        return invalidPriorityResponse(res);
      }

      const expected = readExpectedRevision(
        (req.body as { expectedRevision?: unknown }).expectedRevision,
      );
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const read = readFieldTarget(rawFieldPath, segments);
      if (!read.ok) {
        return fieldTargetErrorResponse(res, read);
      }
      /** Tombstones are stored as dotted paths, so they cannot name a key that contains a dot. */
      if (!read.target.dotFree) {
        return fieldTargetErrorResponse(res, {
          error: 'A tombstone cannot name a key that contains a dot',
          reason: 'dotted_segment',
        });
      }
      const { fieldPath } = read.target;
      const section = getTopLevelSection(fieldPath);
      if (!isAcceptedOverrideSection(section)) {
        return unknownSectionResponse(res);
      }
      const keyedError = getKeyedTargetError(read.target, true);
      if (keyedError) {
        return res.status(400).json(keyedError);
      }
      /** The merge hides inherited values in objects only: an entry is hidden by its key. */
      if (!read.target.entry && isConfigArrayItemPath(read.target.segments)) {
        return fieldTargetErrorResponse(res, {
          error: INSIDE_ARRAY_TOMBSTONE_ERROR,
          reason: 'inside_array',
        });
      }
      const removalError = read.target.entry ? null : getFieldRemovalError(fieldPath);
      if (removalError) {
        return errorResponse(res, 400, removalError.code, removalError.error);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const [canManageSection, access] = await Promise.all([
        hasBroadManage || hasConfigCapability(user, section as ConfigSection, 'manage'),
        resolveWriteReadAccess(user, hasBroadManage, [section]),
      ]);
      if (!canManageSection) {
        return forbiddenSectionResponse(res, section);
      }

      const skipReason =
        getFieldSkipReason(fieldPath) ?? getHeldPathSkipReason(read.target.segments);
      if (skipReason) {
        logSkippedField('Ignoring tombstone for', fieldPath, skipReason);
        return noopResponse(
          res,
          'No actionable field path provided',
          principalType,
          principalId,
          expected.value,
          { skipped: [{ segments: [...read.target.segments], reason: skipReason }], access },
        );
      }

      /** A stdio server librechat.yaml runs cannot be hidden, nor can its fields be removed. */
      const scope = await resolveWriteScope(principalType, principalId);
      const mcpBase = MCP_SECTIONS.has(section)
        ? await getBaseAppConfig(scope.tenantId)
        : undefined;
      if (isProcessServerPath(read.target.segments, getProcessServerNames(mcpBase?.config ?? {}))) {
        return processServerOverrideResponse(res);
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on section-scoped tombstone for ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }
      const requestedPriority = hasBroadManage ? priority : undefined;

      let outcome: ConfigMutationOutcome<RemovalStop>;
      try {
        outcome = await removeConfigPath(
          principalType,
          principalId,
          read.target,
          { tombstone: true, priority: requestedPriority },
          expected.value,
          scope,
          mcpBase,
        );
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }
      if (!outcome.written) {
        return removalStopResponse(res, outcome.result);
      }

      const { record: config, previous } = outcome;
      await invalidateCaches(user.tenantId, 'field tombstone');
      await emitAudit(req, {
        action: previous == null ? 'config.created' : 'config.updated',
        target: configTarget(principalType, principalId),
        metadata: { operation: 'tombstone', fieldPath },
      });
      const ignored = isBoundSecretSection(parseFieldPath(fieldPath)[0])
        ? await reportIgnored(config, getConfigPartition(config))
        : [];
      return sendWrittenConfig(res, 200, config, access, ignored, toTargetReport(read.target));
    } catch (error) {
      logger.error('[adminConfig] tombstoneConfigField error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to tombstone config field' });
    }
  }

  /**
   * DELETE /:principalType/:principalId/fields?fieldPath=dotted.path
   * (or `?segments=<JSON array>` for a path whose keys contain dots, or a keyed path such as
   * `endpoints.custom["Name"].headers`, which resets the principal's own entry or path and the
   * keyed tombstones of that entry at or below it)
   *
   * Unlike the writes, a path under an unknown section is accepted: removing it only clears
   * what an earlier write stored there (the merge ignores it either way), and it is the only
   * way to drop such a tombstone without deleting the whole document.
   */
  async function deleteConfigField(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };
      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const { fieldPath: rawFieldPath, segments: rawSegments } = req.query;

      if (rawSegments === undefined && (!rawFieldPath || typeof rawFieldPath !== 'string')) {
        return errorResponse(
          res,
          400,
          'INVALID_FIELD_PATH',
          'fieldPath query parameter is required',
        );
      }

      const expected = readExpectedRevision(req.query.expectedRevision);
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const read = readFieldTarget(
        rawFieldPath,
        rawSegments === undefined ? undefined : readSegmentsQuery(rawSegments),
      );
      if (!read.ok) {
        return fieldTargetErrorResponse(res, read);
      }
      const { target } = read;
      const { fieldPath } = target;
      const keyedError = getKeyedTargetError(target, false);
      if (keyedError) {
        return res.status(400).json(keyedError);
      }
      const removalError = target.entry ? null : getFieldRemovalError(fieldPath);
      if (removalError) {
        return errorResponse(res, 400, removalError.code, removalError.error);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const section = getTopLevelSection(fieldPath);

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const [canManageSection, access] = await Promise.all([
        hasBroadManage || hasConfigCapability(user, section as ConfigSection, 'manage'),
        resolveWriteReadAccess(user, hasBroadManage, [section]),
      ]);
      if (!canManageSection) {
        return forbiddenSectionResponse(res, section);
      }

      const skipReason = getFieldSkipReason(fieldPath);
      if (skipReason) {
        logSkippedField('Ignoring delete for', fieldPath, skipReason);
        return noopResponse(
          res,
          'No actionable field path provided',
          principalType,
          principalId,
          expected.value,
          { skipped: [{ segments: [...target.segments], reason: skipReason }], access },
        );
      }

      let config: ConfigRecord | null;
      try {
        if (target.entry || isBoundRemoval(target)) {
          const outcome = await removeConfigPath(
            principalType,
            principalId,
            target,
            { tombstone: false },
            expected.value,
            await resolveWriteScope(principalType, principalId),
          );
          if (!outcome.written) {
            return removalStopResponse(res, outcome.result);
          }
          config = outcome.record;
        } else {
          /**
           * A secret and its preview companion are removed together, in one write. Every path
           * goes by its segments: the store reads a dotted string holding `["` as a keyed path,
           * so a `segments` key such as `custom["Name"]` would otherwise reach an entry past the
           * guards of the branch above. By segments it names that key as written.
           */
          config = await unsetConfigField(
            principalType,
            principalId,
            getRemovalPaths(target),
            undefined,
            { expectedRevision: expected.value },
          );
        }
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }
      if (!config) {
        return configNotFoundResponse(res);
      }

      await invalidateCaches(user.tenantId, 'field delete');
      await emitAudit(req, {
        action: 'config.updated',
        target: configTarget(principalType, principalId),
        metadata: { operation: 'unset', fieldPath: describeFieldTarget(target) },
      });
      const ignored = isBoundSecretSection(target.segments[0])
        ? await reportIgnored(config, getConfigPartition(config))
        : [];
      return sendWrittenConfig(res, 200, config, access, ignored, toTargetReport(target));
    } catch (error) {
      logger.error('[adminConfig] deleteConfigField error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to delete config field' });
    }
  }

  /**
   * POST /:principalType/:principalId/changes — Apply a batch of changes atomically.
   *
   * Every change is checked before anything is read; then the stored document is read, the
   * changes are applied in order as pure transforms (secrets an object omits are kept from the
   * document as it stands before each change), the end state is validated on the deployment's
   * librechat.yaml without the principal's tombstones, and the result is written with one
   * compare-and-swap. Any failure leaves the document as it was.
   */
  async function applyChanges(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({
          error: `Invalid principalType: ${principalType}`,
          code: 'INVALID_PRINCIPAL_TYPE',
        });
      }

      const body = (req.body ?? {}) as {
        ops?: unknown;
        priority?: unknown;
        dryRun?: unknown;
        expectedRevision?: unknown;
      };
      const { ops, priority } = body;

      if (priority != null && !isValidPriority(priority)) {
        return invalidPriorityResponse(res);
      }

      if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
        return res.status(400).json({ error: 'dryRun must be a boolean', code: 'INVALID_DRY_RUN' });
      }
      const dryRun = body.dryRun === true;

      const expected = readExpectedRevision(body.expectedRevision);
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      if (!Array.isArray(ops) || ops.length === 0) {
        return res
          .status(400)
          .json({ error: 'ops array is required and must not be empty', code: 'OPS_REQUIRED' });
      }

      if (ops.length > MAX_CONFIG_CHANGE_OPS) {
        return res.status(400).json({
          error: `ops array exceeds maximum of ${MAX_CONFIG_CHANGE_OPS}`,
          code: 'TOO_MANY_OPS',
        });
      }

      const changes: PreparedChange[] = [];
      const skipped: SkippedChange[] = [];
      const identities = new Set<string>();
      const sections = new Set<string>();
      for (let index = 0; index < ops.length; index++) {
        const prepared = prepareChange(ops[index], index);
        if (!prepared.ok) {
          return res.status(400).json(prepared.failure);
        }
        if (identities.has(prepared.identity)) {
          return res.status(400).json({
            error: 'Two changes address the same path or entry',
            code: 'DUPLICATE_FIELD_PATH',
            opIndex: index,
          });
        }
        identities.add(prepared.identity);
        sections.add(prepared.section);
        skipped.push(...prepared.skipped);
        if (prepared.change) {
          changes.push(prepared.change);
        }
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const managedSections = [...sections];
      if (!hasBroadManage) {
        const allowed = await Promise.all(
          managedSections.map((section) =>
            hasConfigCapability(user, section as ConfigSection, 'manage'),
          ),
        );
        const denied = managedSections.find((_, i) => !allowed[i]);
        if (denied) {
          return forbiddenSectionResponse(res, denied);
        }
      }

      if (priority != null && !hasBroadManage) {
        logger.warn(
          `[adminConfig] Ignoring caller-supplied priority on section-scoped changes to ${principalType}/${principalId}: only broad manage:configs may modify document priority`,
        );
      }
      const requestedPriority = hasBroadManage ? (priority as number | undefined) : undefined;

      /** A dry run returns no document, so it resolves no read access: it shows only what it writes. */
      const [{ scope, baseConfig }, access] = await Promise.all([
        loadWriteScope(principalType, principalId),
        dryRun
          ? toWrittenSectionsAccess(hasBroadManage, managedSections)
          : resolveWriteReadAccess(user, hasBroadManage, managedSections),
      ]);
      const baseYaml: Partial<TCustomConfig> = baseConfig?.config ?? {};
      const envPolicy = getEnvPolicy(baseYaml);
      for (const change of changes) {
        if (
          change.op === 'rename' &&
          (isYamlEntry(baseYaml, change, change.key ?? '') ||
            isYamlEntry(baseYaml, change, change.to ?? ''))
        ) {
          return res.status(400).json({
            error:
              'An entry librechat.yaml defines cannot be renamed, and no entry can take its name',
            code: 'CONFIG_ENTRY_INVALID',
            reason: 'inherited_entry',
            opIndex: change.index,
          });
        }
      }
      const yamlHeld = getYamlHeld(baseYaml, baseConfig);
      /**
       * librechat.yaml's stdio servers are shared processes no override changes: a change inside
       * one is refused, and one in a whole `mcpServers` value is left out (and reported). An
       * `unset` there is cleanup, as DELETE `/fields` is.
       */
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index];
        if (
          SERVER_WRITE_OPS.has(change.op) &&
          isProcessServerPath(change.target.segments, yamlHeld.processServers)
        ) {
          return processServerOverrideResponse(res, { opIndex: change.index });
        }
        const stripped = withoutProcessServers(change, yamlHeld.processServers);
        changes[index] = stripped.change;
        skipped.push(...stripped.skipped);
      }

      interface ChangesReport {
        applied: AdminConfigChangeRef[];
        unchanged: AdminConfigChangeRef[];
        ignored: IgnoredChange[];
        appliedChanges: PreparedChange[];
        /** The document the batch plans, which a dry run reports dropped credentials for. */
        planned?: ConfigOverrideState;
      }
      type ChangesStop =
        | { kind: 'principal' }
        | { kind: 'issues'; issues: ConfigOverrideIssue[] }
        | { kind: 'reentry'; issues: SecretReentryIssue[] }
        | { kind: 'mcpReentry'; reentry: SecretReentry }
        | { kind: 'change'; failure: ChangeFailure };
      type ChangesResult = { report: ChangesReport; stop?: never } | { stop: ChangesStop };

      const plan = async (
        stored: ConfigRecord | null,
        floor: Partial<TCustomConfig>,
        base: ConfigRecord | null,
      ): Promise<ConfigMutationPlan<ChangesResult>> => {
        if (!stored && !(await canCreateFor(principalType, principalId))) {
          return { draft: null, result: { stop: { kind: 'principal' } } };
        }
        const report: ChangesReport = {
          applied: [],
          unchanged: [],
          ignored: [],
          appliedChanges: [],
        };
        const appliedSteps: ConfigChange[] = [];
        /** Env issues in the values the applied changes sent, by identity, followed through renames. */
        let sent: ConfigIdentityStep[][] = [];
        let state: ConfigOverrideState = toConfigOverrideState(stored);
        for (const change of changes) {
          const steps = expandChange(change, state.overrides);
          let next = state;
          try {
            for (const step of steps) {
              next = applyConfigChange(next, step);
            }
          } catch (error) {
            if (!isConfigPathError(error) && !isConfigEntryError(error)) {
              throw error;
            }
            const failure: ChangeFailure = {
              error: 'Config change cannot be applied to the stored config',
              code: (error as ConfigPathError | ConfigEntryError).code,
              reason: (error as ConfigPathError | ConfigEntryError).reason,
              opIndex: change.index,
            };
            return { draft: null, result: { stop: { kind: 'change', failure } } };
          }
          const ref = toChangeRef(change);
          if (next === state) {
            report.unchanged.push(ref);
            continue;
          }
          appliedSteps.push(...steps);
          report.applied.push(ref);
          report.appliedChanges.push(change);
          if (change.op === 'rename') {
            sent = sent.map((path) =>
              renameConfigIdentityPath(
                path,
                change.target.segments,
                change.key ?? '',
                change.to ?? '',
              ),
            );
          }
          sent.push(...getSentEnvIssuePaths(change, next, envPolicy));
          for (const part of getIgnoredParts(change, yamlHeld)) {
            report.ignored.push({ ...ref, ...part });
          }
          if (!rederiveEndpoints) {
            for (const part of getInertGroupParts(change)) {
              report.ignored.push({ ...ref, ...part });
            }
          }
          state = next;
        }

        const storedState = toConfigOverrideState(stored);
        const written = getConfigBatchWrittenPaths(appliedSteps, state, storedState);
        const envIssues = getBatchEnvIssues(sent, state, written, envPolicy);
        if (envIssues.length > 0) {
          return { draft: null, result: { stop: { kind: 'issues', issues: envIssues } } };
        }

        /** Entries of a merged-by-key array are named by key: a write, a removal or a record
         *  rename that reaches into one by position is refused, since the position can name
         *  another entry by the time the batch is applied. */
        const indexed = getIndexedMergeKeyIssues(
          changes
            .filter((change) => INDEXED_PATH_OPS.has(change.op))
            .map((change) => change.target.segments),
        );
        if (indexed.length > 0) {
          return { draft: null, result: { stop: { kind: 'issues', issues: indexed } } };
        }
        /** Changes that cancel out (a set, then an unset of its parent) leave nothing to write. */
        const documentChanged =
          report.applied.length > 0 &&
          !(
            isSameConfigValue(state.overrides, storedState.overrides) &&
            isSameConfigValue(state.tombstones, storedState.tombstones)
          );
        if (!documentChanged && report.applied.length > 0) {
          report.unchanged = [...report.applied, ...report.unchanged].sort(
            (left, right) => left.opIndex - right.opIndex,
          );
          report.applied = [];
          report.ignored = [];
          report.appliedChanges = [];
        }
        /** As on PUT, a priority for an existing principal without a document creates one that
         *  holds it. */
        const priorityChanged = requestedPriority != null && requestedPriority !== stored?.priority;
        if (!documentChanged && !priorityChanged) {
          return { draft: null, result: { report } };
        }
        let planned = state;
        if (documentChanged) {
          /**
           * Only an unset reaches a section configSchema does not define (`prepareChange` refuses
           * every other op there), and it only removes what an older server stored. What it leaves
           * of the section is the document's own `unknown_section` issue, which the merge ignores
           * and which must not be blamed on the removal.
           */
          const attributable = written.filter((segments) => isAcceptedOverrideSection(segments[0]));
          const issues = getConfigChangeIssues(
            state,
            floor,
            stored,
            attributable,
            [],
            getWriteDerivation(baseYaml),
          );
          if (issues.length > 0) {
            return { draft: null, result: { stop: { kind: 'issues', issues } } };
          }
          /** Judged on the values the batch ends up storing: a credential a change kept,
           *  carried or renamed from the stored document was not entered again. */
          const entered = getEnteredChangeSecrets(report.appliedChanges);
          const reentry = getKeptKeyReentryIssues(stored, state, entered, baseConfig);
          if (reentry.length > 0) {
            return { draft: null, result: { stop: { kind: 'reentry', issues: reentry } } };
          }
          const mcpReentry = findSecretReentry({
            stored,
            candidate: state,
            base: baseYaml,
            entered,
          });
          if (mcpReentry) {
            return { draft: null, result: { stop: { kind: 'mcpReentry', reentry: mcpReentry } } };
          }
          planned = bindPlannedSecrets({
            principalType,
            principalId,
            stored,
            candidate: state,
            entered,
            base,
            baseConfig,
            envPolicy,
          });
        }
        if (dryRun) {
          return { draft: null, result: { report: { ...report, planned } } };
        }
        return {
          draft: {
            principalModel: principalModel(principalType),
            priority:
              requestedPriority ??
              stored?.priority ??
              getDefaultConfigPriority({ principalType, principalId }),
            overrides: planned.overrides,
            tombstones: planned.tombstones,
            isActive: stored?.isActive ?? true,
          },
          result: { report },
        };
      };

      let outcome;
      try {
        outcome = await runOnValidationFloor<ChangesResult>(
          principalType,
          principalId,
          scope,
          baseYaml,
          plan,
          expected.value,
        );
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }

      const result = outcome.result as ChangesResult;
      if (result.stop?.kind === 'principal') {
        return principalNotFoundResponse(res);
      }
      if (result.stop?.kind === 'change') {
        return res.status(400).json(result.stop.failure);
      }
      if (result.stop?.kind === 'reentry') {
        return secretReentryResponse(res, result.stop.issues);
      }
      if (result.stop?.kind === 'mcpReentry') {
        return mcpReentryResponse(res, result.stop.reentry);
      }
      if (result.stop) {
        return invalidOverrideResponse(res, result.stop.issues, { skipped });
      }
      const { report } = result;
      const config = outcome.written ? outcome.record : outcome.current;
      /** What the written (or, on a dry run, planned) document sends somewhere new is dropped. */
      const rebound = outcome.written
        ? outcome.record
        : report.planned && {
            principalType,
            principalId,
            priority:
              requestedPriority ??
              config?.priority ??
              getDefaultConfigPriority({ principalType, principalId }),
            overrides: report.planned.overrides,
            tombstones: report.planned.tombstones,
          };
      const ignoredSecrets = rebound
        ? await reportIgnored(rebound, scope.tenantId, {
            baseConfig,
            envPolicy,
            base: outcome.base,
          })
        : [];

      if (outcome.written) {
        await invalidateCaches(user.tenantId, 'changes');
        const paths = new Map<string, string[]>();
        for (const change of report.appliedChanges) {
          paths.set(change.op, [...(paths.get(change.op) ?? []), describeChange(change)]);
        }
        await emitAudit(req, {
          action: outcome.previous == null ? 'config.created' : 'config.updated',
          target: configTarget(principalType, principalId),
          metadata: {
            operation: 'batch',
            changes: report.applied.length,
            priority: outcome.record.priority,
            ...Object.fromEntries([...paths].map(([op, described]) => [op, described.join(',')])),
          },
        });
      }

      return res.status(200).json({
        ...(dryRun
          ? {}
          : {
              config: config ? toWrittenConfig(config, access) : null,
            }),
        revision: config ? getConfigRevision(config) : null,
        written: outcome.written,
        dryRun,
        applied: report.applied,
        skipped,
        ignored: [...report.ignored, ...filterIgnoredForReadAccess(ignoredSecrets, access)],
        unchanged: report.unchanged,
      } satisfies Omit<AdminConfigChangesResponse, 'config'> & { config?: ConfigResponse | null });
    } catch (error) {
      logger.error('[adminConfig] applyConfigChanges error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to apply config changes' });
    }
  }

  /**
   * DELETE /:principalType/:principalId — Delete an entire config override.
   */
  async function deleteConfigOverrides(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const expected = readExpectedRevision(req.query.expectedRevision);
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const allowed =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));
      if (!allowed) {
        return forbiddenResponse(res);
      }

      let config: ConfigRecord | null;
      try {
        config = await deleteConfig(principalType, principalId, undefined, {
          expectEmpty: !hasBroadManage,
          expectedRevision: expected.value,
        });
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }
      if (!config) {
        if (!hasBroadManage) {
          const exists = await findConfigByPrincipal(principalType, principalId, {
            includeInactive: true,
          });
          if (exists) {
            return forbiddenResponse(res);
          }
        }
        return configNotFoundResponse(res);
      }

      await invalidateCaches(user.tenantId, 'config delete');
      await emitAudit(req, {
        action: 'config.deleted',
        severity: 'warning',
        target: configTarget(principalType, principalId),
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      logger.error('[adminConfig] deleteConfigOverrides error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to delete config' });
    }
  }

  /**
   * PATCH /:principalType/:principalId/priority — Set only the document's priority.
   *
   * Overrides, tombstones and `isActive` stay as stored, so a priority change never re-sends
   * (and so never risks clobbering) a profile's contents. Broad `manage:configs` only, like
   * every other priority change. An unchanged priority is not written or audited. Only the
   * caller's tenant partition is addressed, so a caller without a tenant reorders a
   * platform-level profile and gets 404 for one that only a tenant holds.
   */
  async function updateConfigPriority(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return res.status(400).json({
          error: `Invalid principalType: ${principalType}`,
          code: 'INVALID_PRINCIPAL_TYPE',
        });
      }

      const { priority } = req.body as { priority?: unknown };
      if (!isValidPriority(priority)) {
        return invalidPriorityResponse(res);
      }

      const expected = readExpectedRevision(
        (req.body as { expectedRevision?: unknown }).expectedRevision,
      );
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (!(await hasConfigCapability(user, null, 'manage'))) {
        return forbiddenResponse(res);
      }

      if (!setConfigPriority) {
        return res.status(501).json({ error: 'Priority updates are not configured' });
      }

      let updated: ConfigWriteOutcome | null;
      try {
        updated = await setConfigPriority(principalType, principalId, priority, {
          expectedRevision: expected.value,
        });
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }
      if (!updated) {
        return configNotFoundResponse(res);
      }

      const { config, changed } = updated;
      if (changed) {
        await invalidateCaches(user.tenantId, 'priority');
        await emitAudit(req, {
          action: 'config.updated',
          target: configTarget(principalType, principalId),
          metadata: { operation: 'priority', priority: config.priority },
        });
      }
      return res.status(200).json({ config: redactConfigForResponse(config) });
    } catch (error) {
      logger.error('[adminConfig] updateConfigPriority error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to update config priority' });
    }
  }

  /**
   * POST /reload — Reload librechat.yaml on every instance without a config write.
   *
   * Runs the clear every committed config write runs, for every tenant: this instance drops its
   * cached librechat.yaml, its merged configs and its MCP config-source servers. It then loads
   * the file again here before answering, so a file the loader refuses is reported (422, with
   * the issues' locations) instead of only logged; that instance keeps its last good config, as
   * any reload does, and the other instances are not told. Once the file loaded, the clear is
   * published to every other instance with Redis, which load the file on their next read. A
   * write only logs a failed clear or publish, having committed already; here the reload is the
   * whole operation, so the response reports it. An instance that misses the publish keeps its
   * cached librechat.yaml, which never expires, so a 503 tells the operator to retry rather than
   * wait. Only an admin without a tenant with broad `manage:configs` may reload: the file, the
   * MCP servers it defines and the caches dropped belong to every tenant, and a tenant admin
   * cannot edit the file.
   */
  async function reloadConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      if (user.tenantId) {
        return errorResponse(
          res,
          403,
          'FORBIDDEN',
          'Only an admin without a tenant can reload librechat.yaml',
        );
      }

      if (!(await hasConfigCapability(user, null, 'manage'))) {
        return forbiddenResponse(res);
      }

      if (!reloadConfigCaches) {
        return res.status(501).json({ error: 'Config reload is not configured' });
      }

      const report = await reloadConfigCaches();
      const failure = getReloadFailure(report);
      if (failure) {
        await emitAudit(req, {
          action: 'config.reloaded',
          outcome: 'failure',
          target: RELOAD_AUDIT_TARGET,
          metadata: { code: failure.body.code, broadcast: report.broadcast },
        });
        return res.status(failure.status).json(failure.body);
      }
      await emitAudit(req, {
        action: 'config.reloaded',
        target: RELOAD_AUDIT_TARGET,
        metadata: { broadcast: report.broadcast },
      });
      const body: AdminConfigReloadResponse = {
        success: true,
        broadcast: report.broadcast === 'sent',
      };
      return res.status(200).json(body);
    } catch (error) {
      logger.error('[adminConfig] reloadConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to reload config' });
    }
  }

  /**
   * PATCH /:principalType/:principalId/active — Toggle isActive.
   */
  async function toggleConfig(req: ServerRequest, res: Response): Promise<Response> {
    try {
      const { principalType, principalId } = req.params as {
        principalType: string;
        principalId: string;
      };

      if (!validatePrincipalType(principalType)) {
        return invalidPrincipalTypeResponse(res, principalType);
      }

      const { isActive } = req.body as { isActive?: boolean };
      if (typeof isActive !== 'boolean') {
        return errorResponse(res, 400, 'INVALID_IS_ACTIVE', 'isActive boolean is required');
      }

      const expected = readExpectedRevision(
        (req.body as { expectedRevision?: unknown }).expectedRevision,
      );
      if (!expected.ok) {
        return invalidExpectedRevisionResponse(res);
      }

      const user = getCapabilityUser(req);
      if (!user) {
        return authRequiredResponse(res);
      }

      const hasBroadManage = await hasConfigCapability(user, null, 'manage');

      if (principalId === BASE_CONFIG_PRINCIPAL_ID && !hasBroadManage) {
        return forbiddenResponse(res);
      }

      const allowed =
        hasBroadManage ||
        (await hasCapability(user, `assign:configs:${principalType}` as SystemCapability));
      if (!allowed) {
        return forbiddenResponse(res);
      }

      let toggled: { config: ConfigRecord; changed: boolean } | null;
      try {
        toggled = await toggleConfigActiveTracked(principalType, principalId, isActive, {
          expectEmpty: !hasBroadManage,
          expectedRevision: expected.value,
        });
      } catch (error) {
        return await writeFailureResponse(res, error, principalType, principalId);
      }
      if (!toggled) {
        if (!hasBroadManage) {
          const exists = await findConfigByPrincipal(principalType, principalId, {
            includeInactive: true,
          });
          if (exists) {
            return forbiddenResponse(res);
          }
        }
        return configNotFoundResponse(res);
      }

      const { config, changed } = toggled;
      await invalidateCaches(user.tenantId, 'toggle');
      /** A retry that finds the requested state already set changed nothing and is not recorded. */
      if (changed) {
        await emitAudit(req, {
          action: 'config.toggled',
          severity: 'warning',
          target: configTarget(principalType, principalId),
          metadata: { isActive },
        });
      }
      return sendWrittenConfig(
        res,
        200,
        config,
        hasBroadManage ? FULL_READ_ACCESS : NO_READ_ACCESS,
      );
    } catch (error) {
      logger.error('[adminConfig] toggleConfig error:', getSafeErrorMetadata(error));
      return res.status(500).json({ error: 'Failed to toggle config' });
    }
  }

  return {
    listConfigs,
    getConfigMeta,
    getBaseConfig,
    getConfig,
    upsertConfigOverrides,
    patchConfigField,
    tombstoneConfigField,
    deleteConfigField,
    applyConfigChanges: applyChanges,
    deleteConfigOverrides,
    toggleConfig,
    updateConfigPriority,
    reloadConfig,
  };
}
