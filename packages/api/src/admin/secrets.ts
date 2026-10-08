import isPlainObject from 'lodash/isPlainObject';
import { encryptV3, decryptV3, logger } from '@librechat/data-schemas';
import { envVarRegex, extractEnvVariable } from 'librechat-data-provider';
import { isUserProvided } from '~/utils/common';

const ENCRYPTED_PREFIX = 'v3:';
const ENCRYPTED_PAYLOAD_REGEX = /^v3:[0-9a-f]{32}:[0-9a-f]+$/;

interface ConfigSecretFieldInput {
  /** Dot-path of the secret value within config overrides */
  path: string;
  /** When true, `${ENV_VAR}` placeholder values are stored and returned as plain references instead of being encrypted */
  allowEnvPlaceholder?: boolean;
}

interface ConfigSecretField extends ConfigSecretFieldInput {
  /** Non-secret masked-preview companion, always the sibling `<field>Preview`. Written on encrypt, preserved by redaction. */
  previewPath: string;
}

/**
 * Registry of config fields that hold secret values. Writes through the admin
 * config API encrypt these at rest, reads redact them, and omitting them on a
 * subsequent write preserves the stored encrypted value. Each secret's
 * masked-preview companion is derived as `<path>Preview` — recognizing a new
 * sensitive field is a one-line path addition (plus the `<field>Preview`
 * companion in the config schema).
 */
const CONFIG_SECRET_FIELDS: readonly ConfigSecretField[] = (
  [
    { path: 'langfuse.secretKey' },
    { path: 'ocr.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.tts.openai.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.tts.azureOpenAI.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.tts.elevenlabs.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.tts.localai.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.stt.openai.apiKey', allowEnvPlaceholder: true },
    { path: 'speech.stt.azureOpenAI.apiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.serperApiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.searxngApiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.firecrawlApiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.tavilyApiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.jinaApiKey', allowEnvPlaceholder: true },
    { path: 'webSearch.cohereApiKey', allowEnvPlaceholder: true },
    { path: 'endpoints.assistants.apiKey', allowEnvPlaceholder: true },
    { path: 'endpoints.azureAssistants.apiKey', allowEnvPlaceholder: true },
  ] satisfies ConfigSecretFieldInput[]
).map((field) => ({ ...field, previewPath: `${field.path}Preview` }));

/**
 * Preview companions written under earlier naming conventions. Stripped from
 * writes and reads so stored documents self-clean; never written.
 */
const LEGACY_PREVIEW_PATHS: ReadonlyMap<string, string> = new Map([
  ['langfuse.secretKey', 'langfuse.displaySecretKey'],
]);

/**
 * A secret stored on every item of an array config field, which dot-path
 * registry entries cannot express.
 */
interface ArraySecretField {
  /** Dot-path of the array container within config overrides */
  arrayPath: string;
  secretKey: string;
  /** Masked-preview companion on each item, always the sibling `<secretKey>Preview`. */
  previewKey: string;
  /** Item field matched verbatim across writes for omit-to-keep round-trips. */
  identityKey: string;
  /** Reference values that must stay readable and never encrypt, e.g. `user_provided`, `${ENV_VAR}`. */
  isPassthroughValue: (value: string) => boolean;
}

/**
 * Registry of array-item secret locations, the sibling of
 * `CONFIG_SECRET_FIELDS` for secrets that live on entries of an array
 * (e.g. `endpoints.custom[*].apiKey`).
 */
const ARRAY_SECRET_FIELDS: readonly ArraySecretField[] = [
  {
    arrayPath: 'endpoints.custom',
    secretKey: 'apiKey',
    previewKey: 'apiKeyPreview',
    identityKey: 'name',
    isPassthroughValue: (value) => isUserProvided(value) || envVarRegex.test(value),
  },
];

const SECRET_FIELDS_BY_PATH = new Map<string, ConfigSecretField>(
  CONFIG_SECRET_FIELDS.map((field) => [field.path, field]),
);

const PREVIEW_PATHS = new Set<string>([
  ...CONFIG_SECRET_FIELDS.map((field) => field.previewPath),
  ...LEGACY_PREVIEW_PATHS.values(),
]);

const ANCESTOR_PATHS = new Set<string>(
  CONFIG_SECRET_FIELDS.flatMap((field) => {
    const segments = field.path.split('.');
    return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('.'));
  }),
);

const SECRET_SECTIONS: readonly string[] = [
  ...new Set([
    ...CONFIG_SECRET_FIELDS.map((field) => field.path.split('.')[0]),
    ...ARRAY_SECRET_FIELDS.map((field) => field.arrayPath.split('.')[0]),
  ]),
];

export function getSecretPreview(secret: string): string {
  if (secret.length <= 10) {
    return '*'.repeat(secret.length);
  }
  return secret.slice(0, 6) + '...' + secret.slice(-4);
}

/** Top-level config sections containing registered secret fields. */
export function getConfigSecretSections(): readonly string[] {
  return SECRET_SECTIONS;
}

function normalizeSecretString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function isEncryptedConfigSecret(value: unknown): boolean {
  return typeof value === 'string' && value.trim().startsWith(ENCRYPTED_PREFIX);
}

function isEnvPlaceholder(value: string): boolean {
  return envVarRegex.test(value.trim());
}

function getPlainRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? (value as Record<string, unknown>) : null;
}

function lastSegment(path: string): string {
  return path.split('.').slice(-1)[0];
}

/**
 * Returns the segments of `path` relative to `basePath`, or null when
 * `basePath` is not an ancestor of `path`. An empty `basePath` yields the
 * full segment list.
 */
function relativeSegments(path: string, basePath: string): string[] | null {
  if (basePath === '') {
    return path.split('.');
  }
  if (!path.startsWith(`${basePath}.`)) {
    return null;
  }
  return path.slice(basePath.length + 1).split('.');
}

/** Walks `root` along all but the last segment, returning the parent record of the final key. */
function walkToParent(root: unknown, segments: string[]): Record<string, unknown> | null {
  let cursor = getPlainRecord(root);
  for (let i = 0; cursor != null && i < segments.length - 1; i++) {
    cursor = getPlainRecord(cursor[segments[i]]);
  }
  return cursor;
}

/**
 * Deletes any array value found along a registered secret's ancestor chain
 * (relative to `basePath`), at any depth, not just the top level. `walkToParent`
 * silently stops and returns null at an array, which would otherwise let a
 * secret smuggled inside an unexpected array-of-objects shape (e.g.
 * `speech.tts.openai` submitted as an array) bypass both encryption and
 * redaction entirely instead of being stripped like a top-level array is.
 */
function pruneSecretAncestorArrays(root: Record<string, unknown>, basePath: string): void {
  for (const field of CONFIG_SECRET_FIELDS) {
    const segments = relativeSegments(field.path, basePath);
    if (!segments) {
      continue;
    }
    let cursor: Record<string, unknown> | null = root;
    for (let i = 0; cursor != null && i < segments.length - 1; i++) {
      const value = cursor[segments[i]];
      if (Array.isArray(value)) {
        delete cursor[segments[i]];
        cursor = null;
        continue;
      }
      cursor = getPlainRecord(value);
    }
  }
}

/** True when a dotted key equals, contains, or is contained by a registered secret or preview path. */
function isConfigSecretRelatedPath(fieldPath: string): boolean {
  if (SECRET_FIELDS_BY_PATH.has(fieldPath) || PREVIEW_PATHS.has(fieldPath)) {
    return true;
  }
  if (
    ARRAY_SECRET_FIELDS.some(
      (field) => fieldPath === field.arrayPath || fieldPath.startsWith(`${field.arrayPath}.`),
    )
  ) {
    return true;
  }
  return ANCESTOR_PATHS.has(fieldPath) || isConfigSecretDescendantPath(fieldPath);
}

export function decryptConfigSecret(value: unknown): string | undefined {
  const normalized = normalizeSecretString(value);
  if (!normalized || !normalized.startsWith(ENCRYPTED_PREFIX)) {
    return undefined;
  }
  try {
    return decryptV3(normalized);
  } catch (error) {
    logger.warn('[adminConfig] Failed to decrypt config secret', error);
    return undefined;
  }
}

/**
 * Resolves a config credential for runtime use: decrypts encrypted values and
 * resolves `${ENV_VAR}` placeholders, passing plain literals through unchanged.
 */
/**
 * Whether a value has the exact shape `encryptV3` produces
 * (`v3:<32-hex-iv>:<hex-ciphertext>`). Runtime resolution uses this strict
 * check so a legitimate literal credential that merely starts with `v3:`
 * (e.g. from a YAML config never touched by the admin write path) resolves
 * as a literal instead of failing decryption.
 */
export function isEncryptedSecretPayload(value: string): boolean {
  return ENCRYPTED_PAYLOAD_REGEX.test(value.trim());
}

export function resolveConfigSecret(value?: string): string | undefined {
  if (value == null || value === '') {
    return value;
  }
  if (isEncryptedSecretPayload(value)) {
    return decryptConfigSecret(value);
  }
  return extractEnvVariable(value);
}

export function getConfigSecretMutationPaths(fieldPath: string): string[] {
  const field = SECRET_FIELDS_BY_PATH.get(fieldPath);
  if (field?.previewPath) {
    return [field.path, field.previewPath];
  }
  return [fieldPath];
}

export function isConfigSecretDescendantPath(fieldPath: string): boolean {
  for (const field of CONFIG_SECRET_FIELDS) {
    if (fieldPath.startsWith(`${field.path}.`)) {
      return true;
    }
    if (field.previewPath && fieldPath.startsWith(`${field.previewPath}.`)) {
      return true;
    }
  }
  return false;
}

export function isConfigSecretAncestorPath(fieldPath: string): boolean {
  return ANCESTOR_PATHS.has(fieldPath);
}

export function getConfigSecretInputError(fieldPath: string, value: unknown): string | null {
  if (PREVIEW_PATHS.has(fieldPath)) {
    return `Cannot write protected secret preview path: ${fieldPath}`;
  }
  if (SECRET_FIELDS_BY_PATH.has(fieldPath) && isEncryptedConfigSecret(value)) {
    return `Encrypted config secret values cannot be submitted: ${fieldPath}`;
  }
  const arrayError = getArraySecretInputError(fieldPath, value);
  if (arrayError) {
    return arrayError;
  }
  if (!isConfigSecretAncestorPath(fieldPath)) {
    return null;
  }
  for (const field of CONFIG_SECRET_FIELDS) {
    const segments = relativeSegments(field.path, fieldPath);
    if (!segments) {
      continue;
    }
    const parent = walkToParent(value, segments);
    if (parent && isEncryptedConfigSecret(parent[segments[segments.length - 1]])) {
      return `Encrypted config secret values cannot be submitted: ${field.path}`;
    }
  }
  return null;
}

function deleteLegacyPreviewKey(section: Record<string, unknown>, field: ConfigSecretField): void {
  const legacyPath = LEGACY_PREVIEW_PATHS.get(field.path);
  if (legacyPath) {
    delete section[lastSegment(legacyPath)];
  }
}

/**
 * Translates a legacy preview companion to its `<field>Preview` name in place,
 * so reads of not-yet-migrated documents still indicate a configured secret.
 * The stored document migrates for real on its next write.
 */
function migrateLegacyPreviewKey(section: Record<string, unknown>, field: ConfigSecretField): void {
  const legacyPath = LEGACY_PREVIEW_PATHS.get(field.path);
  if (!legacyPath) {
    return;
  }
  const legacyValue = section[lastSegment(legacyPath)];
  const previewKey = lastSegment(field.previewPath);
  if (typeof legacyValue === 'string' && section[previewKey] === undefined) {
    section[previewKey] = legacyValue;
  }
  delete section[lastSegment(legacyPath)];
}

/**
 * Locates a registered secret array within `root`, where `basePath` identifies
 * what `root` is: `''` for a whole overrides/config object, the array's parent
 * section, or the array path itself.
 */
function getSecretArray(root: unknown, field: ArraySecretField, basePath = ''): unknown[] | null {
  if (basePath === field.arrayPath) {
    return Array.isArray(root) ? root : null;
  }
  const segments = relativeSegments(field.arrayPath, basePath);
  if (!segments) {
    return null;
  }
  const container = walkToParent(root, segments);
  const array = container?.[segments[segments.length - 1]];
  return Array.isArray(array) ? array : null;
}

/**
 * Exact-string entry identity for preserve matching. Deliberately untrimmed:
 * the runtime config merge keys entries by their verbatim name, so `"Prod"`
 * and `" Prod "` are distinct endpoints with distinct credentials.
 */
function getEntryIdentity(
  entry: Record<string, unknown> | null,
  field: ArraySecretField,
): string | undefined {
  const value = entry?.[field.identityKey];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Deletes a present non-array protected container (e.g. an object- or
 * null-valued `endpoints.custom`) so malformed input can never carry secrets
 * past the encryption and redaction traversals.
 */
function removeMalformedSecretContainers(root: unknown, basePath = ''): void {
  for (const field of ARRAY_SECRET_FIELDS) {
    const segments = relativeSegments(field.arrayPath, basePath);
    if (!segments) {
      continue;
    }
    const container = walkToParent(root, segments);
    const arrayKey = segments[segments.length - 1];
    if (container != null && arrayKey in container && !Array.isArray(container[arrayKey])) {
      delete container[arrayKey];
    }
  }
}

function applyArraySecretWrites(entries: unknown[], field: ArraySecretField): void {
  for (const item of entries) {
    const entry = getPlainRecord(item);
    if (!entry) {
      continue;
    }
    if (!(field.secretKey in entry)) {
      delete entry[field.previewKey];
      continue;
    }
    const rawValue = entry[field.secretKey];
    if (typeof rawValue !== 'string' || rawValue.startsWith(ENCRYPTED_PREFIX)) {
      entry[field.secretKey] = '';
      entry[field.previewKey] = '';
      continue;
    }
    const value = normalizeSecretString(rawValue);
    if (!value) {
      entry[field.secretKey] = '';
      entry[field.previewKey] = '';
      continue;
    }
    if (field.isPassthroughValue(value)) {
      entry[field.secretKey] = value;
      delete entry[field.previewKey];
      continue;
    }
    entry[field.secretKey] = encryptV3(value);
    entry[field.previewKey] = getSecretPreview(value);
  }
}

function preserveArraySecrets(result: unknown, existing: unknown, basePath: string): void {
  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(result, field, basePath);
    const existingEntries = getSecretArray(existing, field);
    if (!entries || !existingEntries) {
      continue;
    }

    const duplicateIdentities = new Set<string>();
    const existingByIdentity = new Map<string, Record<string, unknown>>();
    for (const item of existingEntries) {
      const entry = getPlainRecord(item);
      const identity = getEntryIdentity(entry, field);
      if (!entry || identity === undefined) {
        continue;
      }
      if (existingByIdentity.has(identity)) {
        duplicateIdentities.add(identity);
        continue;
      }
      existingByIdentity.set(identity, entry);
    }

    for (const item of entries) {
      const entry = getPlainRecord(item);
      if (!entry || field.secretKey in entry) {
        continue;
      }
      const identity = getEntryIdentity(entry, field);
      if (identity === undefined || duplicateIdentities.has(identity)) {
        continue;
      }
      const existingEntry = existingByIdentity.get(identity);
      const existingSecret = normalizeSecretString(existingEntry?.[field.secretKey]);
      if (!existingEntry || !existingSecret) {
        continue;
      }
      if (isEncryptedConfigSecret(existingSecret)) {
        entry[field.secretKey] = existingSecret;
        if (typeof existingEntry[field.previewKey] === 'string') {
          entry[field.previewKey] = existingEntry[field.previewKey];
        }
        continue;
      }
      if (field.isPassthroughValue(existingSecret)) {
        continue;
      }
      entry[field.secretKey] = encryptV3(existingSecret);
      entry[field.previewKey] = getSecretPreview(existingSecret);
    }
  }
}

function shouldRedactArraySecretValue(value: unknown, field: ArraySecretField): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  if (isEncryptedConfigSecret(value)) {
    return true;
  }
  const normalized = normalizeSecretString(value);
  return normalized != null && !field.isPassthroughValue(normalized);
}

/** Numeric indices plus MongoDB positional operators (`$`, `$[]`, `$[id]`). */
function isArrayIndexSegment(segment: string): boolean {
  return /^\d+$/.test(segment) || segment.includes('$');
}

function getArraySecretPathError(fieldPath: string): string | null {
  for (const field of ARRAY_SECRET_FIELDS) {
    const prefix = `${field.arrayPath}.`;
    if (!fieldPath.startsWith(prefix)) {
      continue;
    }
    const segments = fieldPath.slice(prefix.length).split('.');
    if (!isArrayIndexSegment(segments[0])) {
      return `${field.arrayPath} is an array and has no named fields: ${fieldPath}. Write the ${field.arrayPath} array instead`;
    }
    if (segments.length === 1) {
      return `Cannot replace ${field.arrayPath} entries by array index: ${fieldPath}. Write the ${field.arrayPath} array instead`;
    }
    if (segments[1] === field.secretKey || segments[1] === field.previewKey) {
      return `Cannot write secret fields by array index: ${fieldPath}. Write the ${field.arrayPath} array instead`;
    }
  }
  return null;
}

function getArraySecretInputError(fieldPath: string, value: unknown): string | null {
  const pathError = getArraySecretPathError(fieldPath);
  if (pathError) {
    return pathError;
  }
  for (const field of ARRAY_SECRET_FIELDS) {
    const basePath =
      fieldPath === field.arrayPath || relativeSegments(field.arrayPath, fieldPath) != null
        ? fieldPath
        : null;
    if (basePath == null) {
      continue;
    }
    if (fieldPath === field.arrayPath) {
      if (value !== undefined && !Array.isArray(value)) {
        return `Protected secret container must be an array: ${field.arrayPath}`;
      }
    } else {
      const segments = relativeSegments(field.arrayPath, fieldPath) ?? [];
      const container = walkToParent(value, segments);
      const arrayKey = segments[segments.length - 1];
      if (container != null && arrayKey in container && !Array.isArray(container[arrayKey])) {
        return `Protected secret container must be an array: ${field.arrayPath}`;
      }
    }
    const entries = getSecretArray(value, field, fieldPath);
    if (
      entries?.some((entry) => isEncryptedConfigSecret(getPlainRecord(entry)?.[field.secretKey]))
    ) {
      return `Encrypted config secret values cannot be submitted: ${field.arrayPath}[].${field.secretKey}`;
    }
  }
  return null;
}

/**
 * Returns a copy of a custom endpoint config with its stored `apiKey`
 * decrypted for runtime use; unencrypted configs return unchanged. Decryption
 * failures resolve to an empty string (never the ciphertext) so downstream
 * requests fail visibly instead of sending an encrypted blob as a credential.
 */
export function resolveCustomEndpointSecrets<T extends { apiKey?: string }>(endpointConfig: T): T {
  const apiKey = endpointConfig.apiKey;
  if (typeof apiKey !== 'string' || !isEncryptedSecretPayload(apiKey)) {
    return endpointConfig;
  }
  return { ...endpointConfig, apiKey: decryptConfigSecret(apiKey) ?? '' };
}

/**
 * Whether a patched value at `fieldPath` is shaped such that omitted secrets
 * should be preserved from the existing overrides: an object at a registered
 * ancestor path, or an array at a registered array-secret path.
 */
export function isConfigSecretPreservablePatch(fieldPath: string, value: unknown): boolean {
  if (isConfigSecretAncestorPath(fieldPath) && isPlainObject(value)) {
    return true;
  }
  return ARRAY_SECRET_FIELDS.some((field) => field.arrayPath === fieldPath && Array.isArray(value));
}

/**
 * Encrypts a secret value in place within its parent record. Empty and
 * non-string values reset the secret (and preview companion). Env placeholder
 * values are kept as plain references for fields that allow them.
 */
function writeSecretIntoSection(section: Record<string, unknown>, field: ConfigSecretField): void {
  const key = lastSegment(field.path);
  const previewKey = field.previewPath ? lastSegment(field.previewPath) : undefined;
  deleteLegacyPreviewKey(section, field);
  if (!(key in section)) {
    if (previewKey) {
      delete section[previewKey];
    }
    return;
  }

  const rawValue = section[key];
  if (typeof rawValue !== 'string' || rawValue.startsWith(ENCRYPTED_PREFIX)) {
    section[key] = '';
    if (previewKey) {
      section[previewKey] = '';
    }
    return;
  }
  const value = normalizeSecretString(rawValue);
  if (!value) {
    section[key] = '';
    if (previewKey) {
      section[previewKey] = '';
    }
    return;
  }
  if (field.allowEnvPlaceholder && isEnvPlaceholder(value)) {
    section[key] = value;
    if (previewKey) {
      section[previewKey] = '';
    }
    return;
  }

  section[key] = encryptV3(value);
  if (previewKey) {
    section[previewKey] = getSecretPreview(value);
  }
}

function writeDottedSecret(result: Record<string, unknown>, field: ConfigSecretField): void {
  const rawValue = result[field.path];
  if (typeof rawValue !== 'string' || rawValue.startsWith(ENCRYPTED_PREFIX)) {
    result[field.path] = '';
    if (field.previewPath) {
      result[field.previewPath] = '';
    }
    return;
  }
  const value = normalizeSecretString(rawValue);
  if (!value) {
    result[field.path] = '';
    if (field.previewPath) {
      result[field.previewPath] = '';
    }
    return;
  }
  if (field.allowEnvPlaceholder && isEnvPlaceholder(value)) {
    result[field.path] = value;
    if (field.previewPath) {
      result[field.previewPath] = '';
    }
    return;
  }
  result[field.path] = encryptV3(value);
  if (field.previewPath) {
    result[field.previewPath] = getSecretPreview(value);
  }
}

/**
 * Returns a new field map with registered secret entries encrypted (and preview
 * companions set where configured). Empty values reset the secret and its
 * preview companion. Handles both dotted secret paths and object-valued
 * ancestor entries.
 */
export function encryptConfigSecretFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...fields };

  for (const key of Object.keys(result)) {
    if (getArraySecretPathError(key) !== null) {
      delete result[key];
      continue;
    }
    if (ARRAY_SECRET_FIELDS.some((field) => field.arrayPath === key)) {
      if (Array.isArray(result[key])) {
        result[key] = encryptConfigSecrets(result[key], key);
      } else {
        delete result[key];
      }
      continue;
    }
    if (!isConfigSecretAncestorPath(key)) {
      continue;
    }
    if (Array.isArray(result[key])) {
      delete result[key];
    } else if (isPlainObject(result[key])) {
      result[key] = encryptConfigSecrets(result[key], key);
    }
  }

  for (const field of CONFIG_SECRET_FIELDS) {
    if (field.previewPath && !(field.path in result) && field.previewPath in result) {
      delete result[field.previewPath];
    }
    if (field.path in result) {
      writeDottedSecret(result, field);
    }
  }

  return result;
}

/**
 * Returns a cloned config object with registered secret values encrypted
 * before writes. Empty secrets reset their preview companions. `basePath`
 * locates `root` within the config tree ('' for whole-overrides writes).
 */
export function encryptConfigSecrets<T>(root: T, basePath = ''): T {
  if (root == null || typeof root !== 'object') {
    return root;
  }

  const result = structuredClone(root);
  const rootRecord = result as Record<string, unknown>;
  if (basePath === '') {
    for (const key of Object.keys(rootRecord)) {
      if (key.includes('.') && isConfigSecretRelatedPath(key)) {
        delete rootRecord[key];
      } else if (isConfigSecretAncestorPath(key) && Array.isArray(rootRecord[key])) {
        delete rootRecord[key];
      }
    }
  }
  pruneSecretAncestorArrays(rootRecord, basePath);
  removeMalformedSecretContainers(rootRecord, basePath);

  for (const field of CONFIG_SECRET_FIELDS) {
    const segments = relativeSegments(field.path, basePath);
    if (!segments) {
      continue;
    }
    const section = walkToParent(result, segments);
    if (section) {
      writeSecretIntoSection(section, field);
    }
  }

  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(result, field, basePath);
    if (entries) {
      applyArraySecretWrites(entries, field);
    }
  }
  return result;
}

/**
 * Preserves existing encrypted secrets when an object write omits them. This
 * lets redacted admin reads round-trip safely: omitting a secret keeps it,
 * while setting it to an empty value clears it. `basePath` locates `next`
 * within the config tree; `existing` is always the full overrides object.
 */
export function preserveConfigSecrets<T>(next: T, existing?: unknown, basePath = ''): T {
  if (
    next == null ||
    typeof next !== 'object' ||
    existing == null ||
    typeof existing !== 'object'
  ) {
    return next;
  }

  const result = structuredClone(next);
  for (const field of CONFIG_SECRET_FIELDS) {
    const segments = relativeSegments(field.path, basePath);
    if (!segments) {
      continue;
    }
    const section = walkToParent(result, segments);
    if (!section) {
      continue;
    }
    const key = segments[segments.length - 1];
    if (key in section) {
      continue;
    }

    const existingSection = walkToParent(existing, field.path.split('.'));
    if (!existingSection) {
      continue;
    }
    const existingSecret = normalizeSecretString(existingSection[key]);
    if (!existingSecret) {
      continue;
    }
    const isAlreadyEncrypted = isEncryptedConfigSecret(existingSecret);
    const isPlaceholder = field.allowEnvPlaceholder && isEnvPlaceholder(existingSecret);
    // A legacy plaintext secret stored before this field was registered has
    // no ciphertext to preserve verbatim — encrypt it now instead of
    // silently dropping it the first time an unrelated field is edited.
    section[key] = isAlreadyEncrypted || isPlaceholder ? existingSecret : encryptV3(existingSecret);
    if (field.previewPath) {
      const previewKey = lastSegment(field.previewPath);
      const legacyPath = LEGACY_PREVIEW_PATHS.get(field.path);
      const legacyPreview = legacyPath ? existingSection[lastSegment(legacyPath)] : undefined;
      const existingPreview = existingSection[previewKey] ?? legacyPreview;
      if (typeof existingPreview === 'string') {
        section[previewKey] = existingPreview;
      } else if (!isAlreadyEncrypted && !isPlaceholder) {
        section[previewKey] = getSecretPreview(existingSecret);
      }
    }
  }

  preserveArraySecrets(result, existing, basePath);
  return result;
}

/**
 * Config paths holding a *map* of sensitive values rather than one scalar.
 * `CONFIG_SECRET_FIELDS` cannot describe these — it keys off a single path and
 * a `<path>Preview` companion — so they are masked on read instead.
 *
 * These are yaml-only (admin writes are rejected), which is what makes masking
 * safe: a masked read can never be round-tripped back over the real values.
 */
const CONFIG_SECRET_MAP_FIELDS: readonly string[] = ['langfuse.headers'];
const MASKED_MAP_VALUE = '***';

/**
 * Replaces every value of a registered secret map with a fixed mask, keeping
 * the key names so an admin can still see *which* headers a deployment sets
 * without receiving the gateway credentials themselves.
 */
/**
 * Masks registered secret maps on a cloned config, for callers outside the
 * admin read path that also serialize configuration — notably the startup
 * "Custom config file loaded" log, which would otherwise copy every literal
 * gateway credential into application logs.
 *
 * Only handles map-valued secrets; scalar secrets keep whatever handling the
 * caller already applies.
 */
export function redactConfigSecretMaps<T>(root: T): T {
  const clone = JSON.parse(JSON.stringify(root)) as T;
  const rootRecord = getPlainRecord(clone);
  if (!rootRecord) {
    return clone;
  }
  redactSecretMapFields(rootRecord);
  return clone;
}

function redactSecretMapFields(rootRecord: Record<string, unknown>): void {
  for (const path of CONFIG_SECRET_MAP_FIELDS) {
    const segments = path.split('.');
    const parent = walkToParent(rootRecord, segments);
    const key = segments[segments.length - 1];
    const value = parent?.[key];
    const map = getPlainRecord(value);
    if (parent == null) {
      continue;
    }
    if (map == null) {
      /** A non-object here is malformed for this path; drop it rather than
       *  risk serializing a raw string credential. */
      if (value !== undefined) {
        delete parent[key];
      }
      continue;
    }
    parent[key] = Object.fromEntries(Object.keys(map).map((name) => [name, MASKED_MAP_VALUE]));
  }
}

/**
 * Deletes registered secret values from `root` in place so admin reads never
 * return them (encrypted or plaintext). Preview companions and plain
 * `${ENV_VAR}` references (for fields that allow them) are preserved.
 * Secret *maps* are masked value-by-value. The caller passes a cloned object.
 */
export function redactConfigSecrets<T>(root: T): T {
  const rootRecord = getPlainRecord(root);
  if (!rootRecord) {
    return root;
  }

  redactSecretMapFields(rootRecord);

  for (const key of Object.keys(rootRecord)) {
    if (key.includes('.') && isConfigSecretRelatedPath(key)) {
      delete rootRecord[key];
    } else if (isConfigSecretAncestorPath(key) && Array.isArray(rootRecord[key])) {
      delete rootRecord[key];
    }
  }
  pruneSecretAncestorArrays(rootRecord, '');
  removeMalformedSecretContainers(rootRecord);

  for (const field of CONFIG_SECRET_FIELDS) {
    const segments = field.path.split('.');
    const section = walkToParent(rootRecord, segments);
    if (!section) {
      continue;
    }
    migrateLegacyPreviewKey(section, field);
    const key = segments[segments.length - 1];
    if (!(key in section)) {
      continue;
    }
    const value = section[key];
    if (field.allowEnvPlaceholder && typeof value === 'string' && isEnvPlaceholder(value)) {
      continue;
    }
    delete section[key];
  }

  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(rootRecord, field);
    if (!entries) {
      continue;
    }
    for (const item of entries) {
      const entry = getPlainRecord(item);
      if (entry && shouldRedactArraySecretValue(entry[field.secretKey], field)) {
        delete entry[field.secretKey];
      }
    }
  }
  return root;
}
