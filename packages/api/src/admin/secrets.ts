import isPlainObject from 'lodash/isPlainObject';
import { envVarRegex, extractEnvVariable } from 'librechat-data-provider';
import {
  logger,
  encryptV3,
  decryptV3,
  setAtPath,
  parseConfigPath,
  isKeyedConfigPath,
  foldConfigMergeKey,
  getConfigArrayMergeKey,
  combineFoldedConfigItems,
} from '@librechat/data-schemas';
import type { AdminConfigRules, ConfigFieldWrite, ConfigLocation } from '@librechat/data-schemas';
import { isUserProvided } from '~/utils/common';

const ENCRYPTED_PREFIX = 'v3:';
const ENCRYPTED_PAYLOAD_REGEX = /^v3:[0-9a-f]{32}:[0-9a-f]+$/;

interface ConfigSecretFieldInput {
  /** Dot-path of the secret value within config overrides */
  path: string;
  /** When true, `${ENV_VAR}` placeholder values are stored and returned as plain references instead of being encrypted */
  allowEnvPlaceholder?: boolean;
  /**
   * When true, every runtime reader uses the decrypted value as is (`resolveConfigSecret`,
   * `resolveStoredConfigSecret`, `decryptConfigSecret`) and never expands a `${...}` in it, so a
   * value stored encrypted is an opaque credential, not an env reference
   * ({@link isOpaqueSecretInput}, {@link isOpaqueStoredSecret}).
   */
  opaque?: boolean;
}

/** The key of the masked-preview companion stored beside the secret at `secretKey`. */
export function getSecretPreviewKey(secretKey: string): string {
  return `${secretKey}Preview`;
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
 * sensitive field is a one-line path addition, plus the `<field>Preview`
 * companion in the config schema and a runtime reader that decrypts the stored
 * value (`secrets.runtime.spec.ts` lists them).
 */
const CONFIG_SECRET_FIELDS: readonly ConfigSecretField[] = (
  [
    { path: 'langfuse.secretKey', opaque: true },
    { path: 'ocr.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.tts.openai.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.tts.azureOpenAI.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.tts.elevenlabs.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.tts.localai.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.stt.openai.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'speech.stt.azureOpenAI.apiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.serperApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.searxngApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.firecrawlApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.tavilyApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.keenableApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.jinaApiKey', allowEnvPlaceholder: true, opaque: true },
    { path: 'webSearch.cohereApiKey', allowEnvPlaceholder: true, opaque: true },
    /** No runtime reader yet (`secrets.runtime.spec.ts`), so not known to be read as is. */
    { path: 'endpoints.assistants.apiKey', allowEnvPlaceholder: true },
    { path: 'endpoints.azureAssistants.apiKey', allowEnvPlaceholder: true },
  ] satisfies ConfigSecretFieldInput[]
).map((field) => ({ ...field, previewPath: getSecretPreviewKey(field.path) }));

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
  /** Item field matched across writes for omit-to-keep round-trips, as the merge keys it. */
  identityKey: string;
  /** Reference values that must stay readable and never encrypt, e.g. `user_provided`, `${ENV_VAR}`. */
  isPassthroughValue: (value: string) => boolean;
}

/** `user_provided` and `${ENV_VAR}`: values that name where a credential comes from, not the credential. */
export function isCredentialReference(value: string): boolean {
  return isUserProvided(value) || envVarRegex.test(value);
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
    isPassthroughValue: isCredentialReference,
  },
  {
    arrayPath: 'endpoints.azureOpenAI.groups',
    secretKey: 'apiKey',
    previewKey: 'apiKeyPreview',
    identityKey: 'group',
    isPassthroughValue: isCredentialReference,
  },
];

/** A whole-value `{{VAR}}` template, which MCP fills from the user's own custom variables. */
const USER_VARIABLE_TEMPLATE = /^\{\{[^{}]+\}\}$/;

/** Whether a value is a whole `{{VAR}}` template: a value each user enters, not a credential. */
export function isUserVariableTemplate(value: string): boolean {
  return USER_VARIABLE_TEMPLATE.test(value);
}

/** `${ENV_VAR}` and `{{VAR}}`: references an MCP server resolves at connect time, not credentials. */
export function isMCPCredentialReference(value: string): boolean {
  return envVarRegex.test(value) || isUserVariableTemplate(value);
}

/**
 * A secret held by every entry of a record (a map keyed by entry name), such as each MCP
 * server's `apiKey.key`. Dot-path registry entries cannot name a dynamic key, so the record
 * traversals below walk the entries themselves, segment by segment: an entry name that contains
 * a dot is still one key.
 */
interface RecordSecretFieldInput {
  /** Dot-path of the record, whose segments contain no dots. */
  recordPath: string;
  /** Location of the secret inside each entry. */
  secretPath: readonly string[];
  /** Reference values that stay readable and never encrypt. */
  isPassthroughValue: (value: string) => boolean;
}

interface RecordSecretField extends RecordSecretFieldInput {
  /** `recordPath` as segments. */
  recordSegments: readonly string[];
  /** Masked-preview companion, always the sibling `<key>Preview` of the secret. */
  previewKey: string;
}

/** The YAML section holding MCP servers, the name override documents and admin clients use. */
const MCP_SERVERS_SECTION = 'mcpServers';

/** The name the resolved AppConfig gives `mcpServers`, which the merge also applies from an override. */
const MCP_CONFIG_ALIAS = 'mcpConfig';

/**
 * Registry of record secrets.
 * - MCP server credentials, under `mcpServers` and its AppConfig name `mcpConfig`: both are
 *   encrypted on write and redacted on read.
 * - Each Azure group's `apiKey` in `endpoints.azureOpenAI.groupMap`: what librechat.yaml's
 *   `groups` resolve to and what the Azure clients read. An override can write it directly, and
 *   it is the location an override's Azure key takes effect from.
 */
const RECORD_SECRET_FIELDS: readonly RecordSecretField[] = (
  [
    ...[MCP_SERVERS_SECTION, MCP_CONFIG_ALIAS].flatMap((recordPath) =>
      [
        ['oauth', 'client_secret'],
        ['apiKey', 'key'],
      ].map((secretPath) => ({
        recordPath,
        secretPath,
        isPassthroughValue: isMCPCredentialReference,
      })),
    ),
    {
      recordPath: 'endpoints.azureOpenAI.groupMap',
      secretPath: ['apiKey'],
      isPassthroughValue: isCredentialReference,
    },
  ] satisfies RecordSecretFieldInput[]
).map((field) => ({
  ...field,
  recordSegments: field.recordPath.split('.'),
  previewKey: getSecretPreviewKey(field.secretPath[field.secretPath.length - 1]),
}));

/** The record secret's location as a pattern, `*` standing for the entry name. */
function getRecordSecretLocation(field: RecordSecretField): string[] {
  return [...field.recordSegments, '*', ...field.secretPath];
}

/** The record secret's preview location as a pattern. */
function getRecordPreviewLocation(field: RecordSecretField): string[] {
  return [...field.recordSegments, '*', ...field.secretPath.slice(0, -1), field.previewKey];
}

/** The key holding the secret inside its parent object. */
function getRecordSecretKey(field: RecordSecretField): string {
  return field.secretPath[field.secretPath.length - 1];
}

/** A credential location in a resolved config; `*` matches every item of an array or value of a record. */
interface ResolvedSecretField {
  segments: readonly string[];
  isPassthroughValue: (value: string) => boolean;
}

/**
 * Credentials an admin read removes from the resolved config (AppService output, and the raw
 * `librechat.yaml` copy it carries as `config`) after {@link redactConfigSecrets}: the Vertex
 * service key, which `vertexConfigSetup` resolves from `${ENV_VAR}` into `vertexConfig` and
 * which the write registries above do not cover, and the Azure group keys (`groups`, and the
 * `groupMap` `azureConfigSetup` copies them into), which they do, so this pass alone never
 * returns one either.
 */
const RESOLVED_SECRET_FIELDS: readonly ResolvedSecretField[] = [
  { path: 'endpoints.azureOpenAI.groups.*.apiKey', isPassthroughValue: isCredentialReference },
  { path: 'endpoints.azureOpenAI.groupMap.*.apiKey', isPassthroughValue: isCredentialReference },
  { path: 'endpoints.anthropic.vertex.serviceKeyFile', isPassthroughValue: isEnvPlaceholder },
  {
    path: 'endpoints.anthropic.vertexConfig.serviceKeyFile',
    isPassthroughValue: isEnvPlaceholder,
  },
].map(({ path, isPassthroughValue }) => ({ segments: path.split('.'), isPassthroughValue }));

const SECRET_FIELDS_BY_PATH = new Map<string, ConfigSecretField>(
  CONFIG_SECRET_FIELDS.map((field) => [field.path, field]),
);

/** Joins segments so that a key containing a dot never spells another path. */
function segmentsKey(segments: readonly string[]): string {
  return segments.join('\u0000');
}

/** {@link ConfigSecretField.opaque} fields by their segments. */
const OPAQUE_SECRET_FIELDS = new Map<string, ConfigSecretField>(
  CONFIG_SECRET_FIELDS.filter((field) => field.opaque).map((field) => [
    segmentsKey(field.path.split('.')),
    field,
  ]),
);

const PREVIEW_PATHS = new Set<string>([
  ...CONFIG_SECRET_FIELDS.map((field) => field.previewPath),
  ...LEGACY_PREVIEW_PATHS.values(),
]);

/** One dynamic key in a secret location pattern, such as a record entry name. */
const ANY_SEGMENT = '*';

/**
 * Every proper ancestor of the given secret locations. A write of an object at one of them can
 * carry a secret, so the write path walks it for encryption, preservation and redaction. A
 * location may use `*` for a dynamic key (a record entry such as an MCP server name); its
 * ancestors keep the wildcard.
 */
export function getSecretAncestorPatterns(locations: readonly string[]): string[] {
  const ancestors = new Set<string>();
  for (const location of locations) {
    const segments = location.split('.');
    for (let length = 1; length < segments.length; length++) {
      ancestors.add(segments.slice(0, length).join('.'));
    }
  }
  return [...ancestors];
}

/**
 * Ancestors of every registered location: scalar secrets, the containers of array secrets (an
 * array container itself is matched by `ARRAY_SECRET_FIELDS`, since it must stay an array), and
 * record secrets (`mcpServers`, `mcpServers.*`, `mcpServers.*.oauth`, ...).
 */
const ANCESTOR_PATTERNS = getSecretAncestorPatterns([
  ...CONFIG_SECRET_FIELDS.map((field) => field.path),
  ...ARRAY_SECRET_FIELDS.map((field) => field.arrayPath),
  ...RECORD_SECRET_FIELDS.map((field) => getRecordSecretLocation(field).join('.')),
]);

const isWildcardPattern = (pattern: string): boolean => pattern.split('.').includes(ANY_SEGMENT);

const ANCESTOR_PATHS = new Set<string>(
  ANCESTOR_PATTERNS.filter((pattern) => !isWildcardPattern(pattern)),
);

const ANCESTOR_WILDCARDS: readonly string[] = ANCESTOR_PATTERNS.filter(isWildcardPattern);

/** Whether a dotted path matches a location pattern segment for segment. */
export function matchesSecretPattern(fieldPath: string, pattern: string): boolean {
  return matchesLocation(fieldPath.split('.'), pattern.split('.'));
}

function matchesLocation(segments: readonly string[], location: readonly string[]): boolean {
  return (
    segments.length === location.length &&
    location.every((segment, index) => segment === ANY_SEGMENT || segment === segments[index])
  );
}

function isBelowLocation(segments: readonly string[], location: readonly string[]): boolean {
  return (
    segments.length > location.length &&
    location.every((segment, index) => segment === ANY_SEGMENT || segment === segments[index])
  );
}

const RECORD_SECRET_LOCATIONS = RECORD_SECRET_FIELDS.map((field) => ({
  field,
  secret: getRecordSecretLocation(field),
  preview: getRecordPreviewLocation(field),
}));

/** The record secret a dotted path names exactly: the secret itself, or its preview. */
function findRecordSecretPath(
  fieldPath: string,
): { field: RecordSecretField; preview: boolean } | undefined {
  const segments = fieldPath.split('.');
  for (const { field, secret, preview } of RECORD_SECRET_LOCATIONS) {
    if (matchesLocation(segments, secret)) {
      return { field, preview: false };
    }
    if (matchesLocation(segments, preview)) {
      return { field, preview: true };
    }
  }
  return undefined;
}

/** Whether a dotted path lies inside a record secret or its preview. */
function isRecordSecretDescendantPath(fieldPath: string): boolean {
  const segments = fieldPath.split('.');
  return RECORD_SECRET_LOCATIONS.some(
    ({ secret, preview }) =>
      isBelowLocation(segments, secret) || isBelowLocation(segments, preview),
  );
}

/** The preview companion path of a record secret named by its dotted path. */
function getRecordPreviewPath(fieldPath: string, field: RecordSecretField): string {
  const segments = fieldPath.split('.');
  return [...segments.slice(0, -1), field.previewKey].join('.');
}

const SECRET_SECTIONS: readonly string[] = [
  ...new Set([
    ...CONFIG_SECRET_FIELDS.map((field) => field.path.split('.')[0]),
    ...ARRAY_SECRET_FIELDS.map((field) => field.arrayPath.split('.')[0]),
    ...RECORD_SECRET_FIELDS.map((field) => field.recordSegments[0]),
  ]),
];

/** Shortest secret that earns a hint; below this, even four characters reveal too much. */
const PREVIEW_MIN_LENGTH = 16;
const PREVIEW_VISIBLE = 4;

/**
 * The preview a read shows for a secret that has none stored: a literal from librechat.yaml, or
 * plaintext an older server stored. A fixed mask says a value is set without revealing its
 * length or any of its characters.
 */
export const UNPREVIEWED_SECRET_MASK = '********';

/** Whether a redacted value held something: anything but a missing or blank value. */
function isSetSecretValue(value: unknown): boolean {
  return value != null && !(typeof value === 'string' && value.trim() === '');
}

/** Gives a secret whose value a read just removed the fixed mask, unless a preview is stored. */
function maskUnpreviewedSecret(
  parent: Record<string, unknown>,
  previewKey: string,
  removed: unknown,
): void {
  const preview = parent[previewKey];
  if (isSetSecretValue(removed) && (typeof preview !== 'string' || preview === '')) {
    parent[previewKey] = UNPREVIEWED_SECRET_MASK;
  }
}

/** Masked hint for admin display: only the last four characters of a long secret, never a prefix. */
export function getSecretPreview(secret: string): string {
  if (secret.length < PREVIEW_MIN_LENGTH) {
    return '*'.repeat(secret.length);
  }
  return '...' + secret.slice(-PREVIEW_VISIBLE);
}

/**
 * Re-derives a stored preview under the current policy. Previews persisted by
 * earlier releases carry a fixed-width leading prefix (`sk-lf-...cret`) whatever
 * the secret length, so the original length cannot be established and they are
 * fully masked until the secret is next written. Anything unrecognised is also
 * fully masked.
 */
export function normalizeStoredPreview(preview: string): string {
  if (preview === '' || /^\*+$/.test(preview)) {
    return preview;
  }
  if (preview.startsWith('...') && preview.length <= 3 + PREVIEW_VISIBLE) {
    return preview;
  }
  return '*'.repeat(preview.length);
}

/** Top-level config sections containing registered secret fields. */
export function getConfigSecretSections(): readonly string[] {
  return SECRET_SECTIONS;
}

/** The secret registries as plain data, for admin clients that render secret inputs. */
export function getConfigSecretRules(): Pick<
  AdminConfigRules,
  'secretFields' | 'arraySecretFields' | 'recordSecretFields' | 'refusedMaps'
> {
  return {
    secretFields: CONFIG_SECRET_FIELDS.map(({ path, previewPath, allowEnvPlaceholder }) => ({
      path,
      previewPath,
      allowEnvPlaceholder: allowEnvPlaceholder === true,
    })),
    arraySecretFields: ARRAY_SECRET_FIELDS.map(
      ({ arrayPath, secretKey, previewKey, identityKey }) => ({
        arrayPath,
        secretKey,
        previewKey,
        identityKey,
      }),
    ),
    recordSecretFields: RECORD_SECRET_FIELDS.flatMap(({ recordPath, secretPath, previewKey }) =>
      recordPath !== MCP_CONFIG_ALIAS
        ? [
            {
              recordPath,
              secretPath: secretPath.join('.'),
              previewPath: [...secretPath.slice(0, -1), previewKey].join('.'),
            },
          ]
        : [],
    ),
    refusedMaps: [...CONFIG_SECRET_MAP_FIELDS],
  };
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
  if (findRecordSecretPath(fieldPath) != null) {
    return true;
  }
  if (
    ARRAY_SECRET_FIELDS.some(
      (field) => fieldPath === field.arrayPath || fieldPath.startsWith(`${field.arrayPath}.`),
    )
  ) {
    return true;
  }
  return isConfigSecretAncestorPath(fieldPath) || isConfigSecretDescendantPath(fieldPath);
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
 * Whether a value has the exact shape `encryptV3` produces
 * (`v3:<32-hex-iv>:<hex-ciphertext>`). Runtime resolution uses this strict
 * check so a legitimate literal credential that merely starts with `v3:`
 * (e.g. from a YAML config never touched by the admin write path) resolves
 * as a literal instead of failing decryption.
 */
export function isEncryptedSecretPayload(value: string): boolean {
  return ENCRYPTED_PAYLOAD_REGEX.test(value.trim());
}

/**
 * Resolves a config credential for runtime use: decrypts encrypted values and
 * resolves `${ENV_VAR}` placeholders, passing plain literals through unchanged.
 */
export function resolveConfigSecret(value?: string): string | undefined {
  if (value == null || value === '') {
    return value;
  }
  if (isEncryptedSecretPayload(value)) {
    return decryptConfigSecret(value);
  }
  return extractEnvVariable(value);
}

/**
 * Resolves a stored config credential without consulting the environment:
 * decrypts an encrypted value and returns any other value verbatim, so a
 * stored value never splices `${ENV_VAR}` references into a request. A failed
 * decryption yields undefined, never the ciphertext.
 */
export function resolveStoredConfigSecret(value: string): string | undefined {
  if (isEncryptedSecretPayload(value)) {
    return decryptConfigSecret(value);
  }
  return value;
}

/**
 * Whether a value a write sends to `segments` (override keys) is an opaque credential: a secret
 * every runtime reader uses as is once decrypted ({@link ConfigSecretField.opaque}), which the
 * write encrypts because the field does not pass it through as a `${VAR}` reference. A `${...}` in
 * it is part of the credential, not an env reference.
 */
export function isOpaqueSecretInput(segments: readonly string[], value: string): boolean {
  const field = OPAQUE_SECRET_FIELDS.get(segmentsKey(segments));
  return field != null && !(field.allowEnvPlaceholder && isEnvPlaceholder(value));
}

/**
 * Whether a value stored at `segments` (override keys) is an opaque credential: ciphertext of a
 * secret every runtime reader uses as is once decrypted ({@link ConfigSecretField.opaque}).
 * Plaintext there is not: it is a reference, a legacy value or librechat.yaml's, which
 * `resolveConfigSecret` expands.
 */
export function isOpaqueStoredSecret(segments: readonly string[], value: string): boolean {
  return OPAQUE_SECRET_FIELDS.has(segmentsKey(segments)) && isEncryptedSecretPayload(value);
}

export function getConfigSecretMutationPaths(fieldPath: string): string[] {
  const field = SECRET_FIELDS_BY_PATH.get(fieldPath);
  if (field?.previewPath) {
    return [field.path, field.previewPath];
  }
  const recordSecret = findRecordSecretPath(fieldPath);
  if (recordSecret && !recordSecret.preview) {
    return [fieldPath, getRecordPreviewPath(fieldPath, recordSecret.field)];
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
  return isRecordSecretDescendantPath(fieldPath);
}

export function isConfigSecretAncestorPath(fieldPath: string): boolean {
  if (ANCESTOR_PATHS.has(fieldPath)) {
    return true;
  }
  return ANCESTOR_WILDCARDS.some((pattern) => matchesSecretPattern(fieldPath, pattern));
}

/**
 * Every registered secret location as segments: scalar secrets with their previews (legacy
 * spellings included), and the secret and preview keys of any item of an array secret
 * container, where `*` stands for the item index.
 */
const SECRET_LOCATIONS: ReadonlyArray<readonly string[]> = [
  ...[
    ...CONFIG_SECRET_FIELDS.flatMap((field) => [field.path, field.previewPath]),
    ...LEGACY_PREVIEW_PATHS.values(),
  ].map((path) => path.split('.')),
  ...ARRAY_SECRET_FIELDS.flatMap((field) => {
    const container = field.arrayPath.split('.');
    return [
      [...container, ANY_SEGMENT, field.secretKey],
      [...container, ANY_SEGMENT, field.previewKey],
    ];
  }),
  ...RECORD_SECRET_LOCATIONS.flatMap(({ secret, preview }) => [secret, preview]),
];

/** Where each registered secret value itself is stored, `*` standing for an array item or entry. */
const SECRET_VALUE_LOCATIONS: ReadonlyArray<readonly string[]> = [
  ...CONFIG_SECRET_FIELDS.map((field) => field.path.split('.')),
  ...ARRAY_SECRET_FIELDS.map((field) => [
    ...field.arrayPath.split('.'),
    ANY_SEGMENT,
    field.secretKey,
  ]),
  ...RECORD_SECRET_LOCATIONS.map(({ secret }) => secret),
];

function collectStringsAt(value: unknown, rest: readonly string[], into: Set<string>): void {
  if (rest.length === 0) {
    if (typeof value === 'string') {
      into.add(value);
    }
    return;
  }
  const [segment, ...tail] = rest;
  if (segment === ANY_SEGMENT) {
    const children = Array.isArray(value) ? value : Object.values(getPlainRecord(value) ?? {});
    for (const child of children) {
      collectStringsAt(child, tail, into);
    }
    return;
  }
  const record = getPlainRecord(value);
  if (record && Object.prototype.hasOwnProperty.call(record, segment)) {
    collectStringsAt(record[segment], tail, into);
  }
}

/**
 * The secret values a request entered: what its own writes hold at registered secret locations,
 * after encryption and before secret preservation fills in what they omit. Each encryption draws
 * a fresh IV and a submitted ciphertext is refused or cleared, so a credential the write kept or
 * carried from the stored document is never among them, whichever write of the request put it
 * back. Re-entry rules count a key as entered again only when the planned document holds one of
 * these values.
 */
export function getEnteredConfigSecrets(writes: readonly ConfigFieldWrite[]): Set<string> {
  const entered = new Set<string>();
  for (const { segments, value } of writes) {
    for (const location of SECRET_VALUE_LOCATIONS) {
      if (
        segments.length <= location.length &&
        segments.every(
          (segment, index) => location[index] === ANY_SEGMENT || location[index] === segment,
        )
      ) {
        collectStringsAt(value, location.slice(segments.length), entered);
      }
    }
  }
  return entered;
}

/**
 * Whether `candidate`, a credential a write kept rather than entered, is the one `stored` holds:
 * the same ciphertext, or a legacy plaintext value that secret preservation encrypted on the way.
 */
export function isSameStoredSecret(stored: unknown, candidate: string): boolean {
  const normalized = normalizeSecretString(stored);
  if (normalized == null) {
    return false;
  }
  if (normalized === candidate) {
    return true;
  }
  return (
    !isEncryptedConfigSecret(normalized) &&
    isEncryptedConfigSecret(candidate) &&
    decryptConfigSecret(candidate) === normalized
  );
}

/**
 * Whether a write at `segments` touches a registered secret: the secret's own location or its
 * preview's, an ancestor that can carry it, or a path inside it. Segments are compared one by
 * one, so a key that contains a dot is never mistaken for the path its dots would spell.
 */
export function isConfigSecretRelatedSegments(segments: readonly string[]): boolean {
  return SECRET_LOCATIONS.some((location) => {
    const shared = Math.min(location.length, segments.length);
    for (let index = 0; index < shared; index++) {
      if (location[index] !== ANY_SEGMENT && location[index] !== segments[index]) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Whether renaming key `from` to `to` of the record at `segments` would carry a value onto or
 * off a registered secret location: the record lies at or inside one, or a location names
 * `from` or `to` literally at the renamed position. A location with a wildcard there (an entry
 * of a record of servers, say) moves with its entry and stays registered.
 */
export function isConfigSecretKeyRename(
  segments: readonly string[],
  from: string,
  to: string,
): boolean {
  const matches = (location: readonly string[], length: number): boolean =>
    segments
      .slice(0, length)
      .every((segment, index) => location[index] === ANY_SEGMENT || location[index] === segment);
  return SECRET_LOCATIONS.some((location) => {
    if (location.length <= segments.length) {
      return matches(location, location.length);
    }
    const key = location[segments.length];
    return (
      matches(location, segments.length) && key !== ANY_SEGMENT && (key === from || key === to)
    );
  });
}

export function getConfigSecretInputError(fieldPath: string, value: unknown): string | null {
  const entryPath = readEntryPath(fieldPath);
  if (entryPath) {
    return getKeyedSecretPathError(entryPath);
  }
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
  const recordError = getRecordSecretInputError(fieldPath, value);
  if (recordError) {
    return recordError;
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
 * Entry identity for preserve matching: the identity the runtime config merge keys entries
 * by (`foldConfigMergeKey`), so `Ollama` and `ollama` share one stored key. Deliberately
 * untrimmed: `"Prod"` and `" Prod "` are distinct endpoints with distinct credentials.
 */
function getEntryIdentity(
  entry: Record<string, unknown> | null,
  field: ArraySecretField,
): string | undefined {
  const value = entry?.[field.identityKey];
  return typeof value === 'string' && value !== ''
    ? foldConfigMergeKey(field.arrayPath, value)
    : undefined;
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

/**
 * Stored entries as the runtime merge reads them: a document stored before names were folded
 * may name one entry in two spellings, which the merge combines (`combineFoldedConfigItems`),
 * so the secret an omitted key keeps is the one the runtime uses.
 */
function getStoredSecretEntries(existing: unknown, field: ArraySecretField): unknown[] | null {
  const entries = getSecretArray(existing, field);
  return entries && combineFoldedConfigItems(field.arrayPath, entries);
}

function preserveArraySecrets(result: unknown, existing: unknown, basePath: string): void {
  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(result, field, basePath);
    const existingEntries = getStoredSecretEntries(existing, field);
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
          entry[field.previewKey] = normalizeStoredPreview(
            existingEntry[field.previewKey] as string,
          );
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
    return value != null;
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

/** The secret key each entry of the array at `arrayPath` holds (`apiKey`), or `undefined`. */
export function getArraySecretKey(arrayPath: string): string | undefined {
  return ARRAY_SECRET_FIELDS.find((field) => field.arrayPath === arrayPath)?.secretKey;
}

/**
 * A keyed path that names an entry of an array merged by key (`endpoints.custom["Name"].x`, see
 * `parseConfigPath`), or `null`. Any other path holding `["` (a malformed keyed path, or a record
 * key such as an MCP server named `a["b` joined from `segments`) is checked as a plain path.
 */
function readEntryPath(fieldPath: string): ConfigLocation | null {
  if (!isKeyedConfigPath(fieldPath)) {
    return null;
  }
  const location = parseConfigPath(fieldPath);
  return location?.entry && getConfigArrayMergeKey(location.segments) ? location : null;
}

/**
 * A keyed path (`endpoints.custom["Name"].apiKey`) naming an entry's registered secret or its
 * preview: an entry's secret is written, kept and removed with the entry, never by its key, so
 * the secret pipeline never meets a path it does not encrypt, preserve or redact.
 */
function getKeyedSecretPathError(location: ConfigLocation): string | null {
  const field = location.entry?.rest[0];
  if (field === undefined) {
    return null;
  }
  const arrayPath = location.segments.join('.');
  const secret = ARRAY_SECRET_FIELDS.find(
    (candidate) =>
      candidate.arrayPath === arrayPath &&
      (field === candidate.secretKey || field === candidate.previewKey),
  );
  return secret
    ? `Cannot address ${secret.arrayPath}[].${field} by entry key. Write the ${secret.arrayPath} entry instead`
    : null;
}

function getArraySecretPathError(fieldPath: string): string | null {
  const entryPath = readEntryPath(fieldPath);
  if (entryPath) {
    return getKeyedSecretPathError(entryPath);
  }
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
 * Walks `node` along `segments` and returns the object at the end. With `prune`, an array met on
 * the way is deleted from its parent: a secret inside an unexpected array-of-objects shape would
 * otherwise slip past encryption and redaction.
 */
function walkObjects(
  node: unknown,
  segments: readonly string[],
  prune: boolean,
): Record<string, unknown> | null {
  let cursor = getPlainRecord(node);
  for (const segment of segments) {
    if (cursor == null) {
      return null;
    }
    const next = cursor[segment];
    if (prune && Array.isArray(next)) {
      delete cursor[segment];
      return null;
    }
    cursor = getPlainRecord(next);
  }
  return cursor;
}

/** One entry's object that holds (or would hold) a record secret's key. */
interface RecordSecretParent {
  name: string;
  parent: Record<string, unknown>;
}

/**
 * The objects holding a record secret's key in `root`, by entry name, where `basePath` says what
 * `root` is: whole overrides (`''`), an object on the way to the record, the record, one entry,
 * or an object between an entry and its secret. A path elsewhere yields nothing. With `prune`,
 * arrays where the record, an object on the way to it, an entry or an object on the way to the
 * secret belongs are deleted.
 */
function collectRecordSecretParents(
  root: unknown,
  field: RecordSecretField,
  basePath: string,
  prune: boolean,
): RecordSecretParent[] {
  const base = basePath === '' ? [] : basePath.split('.');
  const { recordSegments } = field;
  const parentPath = field.secretPath.slice(0, -1);
  const shared = Math.min(base.length, recordSegments.length);
  if (base.slice(0, shared).some((segment, index) => segment !== recordSegments[index])) {
    return [];
  }
  if (base.length > recordSegments.length) {
    const name = base[recordSegments.length];
    const within = base.slice(recordSegments.length + 1);
    if (
      within.length > parentPath.length ||
      within.some((segment, index) => segment !== parentPath[index])
    ) {
      return [];
    }
    const parent = walkObjects(root, parentPath.slice(within.length), prune);
    return parent ? [{ name, parent }] : [];
  }
  const entries = walkObjects(root, recordSegments.slice(base.length), prune);
  if (!entries) {
    return [];
  }
  const parents: RecordSecretParent[] = [];
  for (const name of Object.keys(entries)) {
    if (prune && Array.isArray(entries[name])) {
      delete entries[name];
      continue;
    }
    const parent = walkObjects(entries[name], parentPath, prune);
    if (parent) {
      parents.push({ name, parent });
    }
  }
  return parents;
}

/** The stored object that holds a record secret's key for the named entry. */
function getStoredRecordSecretParent(
  existing: unknown,
  field: RecordSecretField,
  name: string,
): Record<string, unknown> | null {
  const record = walkObjects(existing, field.recordSegments, false);
  if (!record || !Object.prototype.hasOwnProperty.call(record, name)) {
    return null;
  }
  return walkObjects(record[name], field.secretPath.slice(0, -1), false);
}

function getRecordSecretInputError(fieldPath: string, value: unknown): string | null {
  const recordSecret = findRecordSecretPath(fieldPath);
  if (recordSecret?.preview) {
    return `Cannot write protected secret preview path: ${fieldPath}`;
  }
  if (recordSecret) {
    return isEncryptedConfigSecret(value)
      ? `Encrypted config secret values cannot be submitted: ${fieldPath}`
      : null;
  }
  for (const field of RECORD_SECRET_FIELDS) {
    const key = getRecordSecretKey(field);
    for (const { name, parent } of collectRecordSecretParents(value, field, fieldPath, false)) {
      if (isEncryptedConfigSecret(parent[key])) {
        return `Encrypted config secret values cannot be submitted: ${field.recordPath}.${name}.${field.secretPath.join('.')}`;
      }
    }
  }
  return null;
}

/**
 * Applies a write to one entry's secret in place, as for array entries: an absent secret drops
 * any submitted preview, an empty or non-string value clears both, a reference is kept readable,
 * and anything else is encrypted with a masked preview beside it.
 */
function applyRecordSecretWrite(parent: Record<string, unknown>, field: RecordSecretField): void {
  const key = getRecordSecretKey(field);
  if (!(key in parent)) {
    delete parent[field.previewKey];
    return;
  }
  const rawValue = parent[key];
  const value =
    typeof rawValue === 'string' && !rawValue.startsWith(ENCRYPTED_PREFIX)
      ? normalizeSecretString(rawValue)
      : undefined;
  if (!value) {
    parent[key] = '';
    parent[field.previewKey] = '';
    return;
  }
  if (field.isPassthroughValue(value)) {
    parent[key] = value;
    parent[field.previewKey] = '';
    return;
  }
  parent[key] = encryptV3(value);
  parent[field.previewKey] = getSecretPreview(value);
}

/**
 * Copies a stored record secret, with its preview, into a parent that omits it. Only values a
 * read hides are carried: ciphertext as is, and legacy plaintext encrypted on the way. A
 * reference the read returned is not, since a client that omits it removed it.
 */
function carryStoredRecordSecret(
  parent: Record<string, unknown>,
  storedParent: Record<string, unknown> | null,
  field: RecordSecretField,
): void {
  const key = getRecordSecretKey(field);
  const storedSecret = normalizeSecretString(storedParent?.[key]);
  if (!storedParent || !storedSecret || field.isPassthroughValue(storedSecret)) {
    return;
  }
  if (!isEncryptedConfigSecret(storedSecret)) {
    parent[key] = encryptV3(storedSecret);
    parent[field.previewKey] = getSecretPreview(storedSecret);
    return;
  }
  parent[key] = storedSecret;
  const storedPreview = storedParent[field.previewKey];
  if (typeof storedPreview === 'string') {
    parent[field.previewKey] = normalizeStoredPreview(storedPreview);
  } else {
    delete parent[field.previewKey];
  }
}

function preserveRecordSecrets(result: unknown, existing: unknown, basePath: string): void {
  for (const field of RECORD_SECRET_FIELDS) {
    const key = getRecordSecretKey(field);
    for (const { name, parent } of collectRecordSecretParents(result, field, basePath, false)) {
      if (!(key in parent)) {
        carryStoredRecordSecret(parent, getStoredRecordSecretParent(existing, field, name), field);
      }
    }
  }
}

function redactRecordSecrets(rootRecord: Record<string, unknown>): void {
  for (const field of RECORD_SECRET_FIELDS) {
    const key = getRecordSecretKey(field);
    for (const { parent } of collectRecordSecretParents(rootRecord, field, '', true)) {
      const preview = parent[field.previewKey];
      if (typeof preview === 'string') {
        parent[field.previewKey] = normalizeStoredPreview(preview);
      }
      if (!(key in parent)) {
        continue;
      }
      const value = parent[key];
      const normalized = normalizeSecretString(value);
      if (
        (typeof value === 'string' && normalized == null) ||
        (normalized != null && field.isPassthroughValue(normalized))
      ) {
        continue;
      }
      delete parent[key];
      maskUnpreviewedSecret(parent, field.previewKey, value);
    }
  }
}

/** Where a `renames` hint may name entries: MCP servers by name, custom endpoints by `name`. */
export const RENAME_HINT_PATHS = ['mcpServers', 'endpoints.custom'] as const;

/**
 * A secret carried across a rename: from the stored entry it had, to the new name. For
 * `mcpServers` the name is a server's record key, for `endpoints.custom` an endpoint's `name`.
 */
export interface ConfigSecretRename {
  path: (typeof RENAME_HINT_PATHS)[number];
  previousName: string;
  name: string;
}

/**
 * Copies a stored array entry's secret, with its preview, into an entry that omits it, as
 * {@link carryStoredRecordSecret} does for a record entry: ciphertext as is, legacy plaintext
 * encrypted on the way, a reference the read returned not at all.
 */
function carryStoredArraySecret(
  entry: Record<string, unknown>,
  stored: Record<string, unknown> | null,
  field: ArraySecretField,
): void {
  const storedSecret = normalizeSecretString(stored?.[field.secretKey]);
  if (!stored || !storedSecret || field.isPassthroughValue(storedSecret)) {
    return;
  }
  if (!isEncryptedConfigSecret(storedSecret)) {
    entry[field.secretKey] = encryptV3(storedSecret);
    entry[field.previewKey] = getSecretPreview(storedSecret);
    return;
  }
  entry[field.secretKey] = storedSecret;
  const storedPreview = stored[field.previewKey];
  if (typeof storedPreview === 'string') {
    entry[field.previewKey] = normalizeStoredPreview(storedPreview);
  } else {
    delete entry[field.previewKey];
  }
}

/** The stored entry of an array secret field whose key has the identity of `name`. */
function findStoredSecretEntry(
  existing: unknown,
  field: ArraySecretField,
  name: string,
): Record<string, unknown> | null {
  const identity = foldConfigMergeKey(field.arrayPath, name);
  for (const item of getStoredSecretEntries(existing, field) ?? []) {
    const entry = getPlainRecord(item);
    if (entry && getEntryIdentity(entry, field) === identity) {
      return entry;
    }
  }
  return null;
}

/** Fills the array entries named `name` that omit their secret from the stored entry `previousName`. */
function carryRenamedArraySecrets(
  next: unknown,
  existing: unknown,
  renames: readonly ConfigSecretRename[],
  basePath: string,
): void {
  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(next, field, basePath);
    if (!entries) {
      continue;
    }
    for (const { previousName, name, path } of renames) {
      if (path !== field.arrayPath) {
        continue;
      }
      const identity = foldConfigMergeKey(field.arrayPath, name);
      const stored = findStoredSecretEntry(existing, field, previousName);
      for (const item of entries) {
        const entry = getPlainRecord(item);
        if (entry && !(field.secretKey in entry) && getEntryIdentity(entry, field) === identity) {
          carryStoredArraySecret(entry, stored, field);
        }
      }
    }
  }
}

/**
 * Fills secrets a renamed entry omits from the stored entry it was renamed from: an MCP server's
 * credentials (by record key), or a custom endpoint's `apiKey` (by `name`, folded as the merge
 * folds it). Copy semantics: the stored entry keeps its own secret, so a client that renames by
 * writing the new entry and then deleting the old one loses nothing. Runs after
 * {@link preserveConfigSecrets}, which keeps a secret the entry already has under its own name.
 * A carried credential keeps its stored ciphertext (legacy plaintext is encrypted on the way), so
 * the re-entry rules (`reentry.ts`) find the server or endpoint it came from by value.
 */
export function carryRenamedConfigSecrets(
  next: unknown,
  existing: unknown,
  renames: readonly ConfigSecretRename[],
  basePath = '',
): void {
  if (renames.length === 0) {
    return;
  }
  carryRenamedArraySecrets(next, existing, renames, basePath);
  for (const field of RECORD_SECRET_FIELDS) {
    const key = getRecordSecretKey(field);
    const parents = collectRecordSecretParents(next, field, basePath, false);
    for (const { previousName, name, path } of renames) {
      if (path !== field.recordPath) {
        continue;
      }
      const target = parents.find((candidate) => candidate.name === name);
      if (!target || key in target.parent) {
        continue;
      }
      carryStoredRecordSecret(
        target.parent,
        getStoredRecordSecretParent(existing, field, previousName),
        field,
      );
    }
  }
}

/** Decrypts a stored secret for runtime use; a failure gives `''`, never the ciphertext. */
function decryptRuntimeSecret(value: string): string {
  return decryptConfigSecret(value) ?? '';
}

/**
 * Returns `parent` with its `key` decrypted when it holds ciphertext, copying only what changes;
 * anything else comes back as is.
 */
function withDecryptedKey<T>(parent: T, key: string): T {
  const record = getPlainRecord(parent);
  const value = record?.[key];
  if (record == null || typeof value !== 'string' || !isEncryptedSecretPayload(value)) {
    return parent;
  }
  return { ...record, [key]: decryptRuntimeSecret(value) } as T;
}

/** `node` with the value at `segments` decrypted, copied only along the path when it changes. */
function withDecryptedAt(node: unknown, segments: readonly string[]): unknown {
  const [segment, ...rest] = segments;
  if (rest.length === 0) {
    return withDecryptedKey(node, segment);
  }
  const record = getPlainRecord(node);
  if (record == null || !Object.prototype.hasOwnProperty.call(record, segment)) {
    return node;
  }
  const child = record[segment];
  const decrypted = withDecryptedAt(child, rest);
  return decrypted === child ? node : { ...record, [segment]: decrypted };
}

/**
 * The record secrets a resolved config carries: every one but those under `mcpServers`, which
 * the merge resolves into `mcpConfig`.
 */
const RESOLVED_RECORD_SECRET_FIELDS = RECORD_SECRET_FIELDS.filter(
  (field) => field.recordPath !== MCP_SERVERS_SECTION,
);

/** `root` with each entry's secret of `field` decrypted, copied only along what changes. */
function withDecryptedRecordSecrets(
  root: Record<string, unknown>,
  field: RecordSecretField,
): Record<string, unknown> {
  const entries = walkObjects(root, field.recordSegments, false);
  if (!entries) {
    return root;
  }
  let decrypted: Record<string, unknown> | undefined;
  for (const [name, entry] of Object.entries(entries)) {
    const next = withDecryptedAt(entry, field.secretPath);
    if (next !== entry) {
      decrypted ??= { ...entries };
      decrypted[name] = next;
    }
  }
  return decrypted ? setAtPath(root, field.recordSegments, decrypted) : root;
}

/**
 * Decrypts, for runtime readers, the credentials a resolved config carries as ciphertext from
 * admin-written overrides: every MCP server's `apiKey.key` and `oauth.client_secret`, each
 * resolved Azure group's `apiKey` (`groupMap`, which the Azure clients read) and each Azure
 * `groups` entry's. Runs once after the overrides merge, so the ~10 readers of `mcpConfig` and
 * the Azure clients receive plaintext, while the store and admin reads keep ciphertext or
 * redaction. A failed decrypt gives `''` (with a warning), never ciphertext, so a request fails
 * visibly instead of sending an encrypted blob as a credential. Preview companions stay for the
 * admin's merged view; `redactServerSecrets` keeps them from end users. Objects are copied only
 * along the paths that change; the input is never mutated.
 */
export function resolveRuntimeConfigSecrets<T extends object>(config: T): T {
  let result = RESOLVED_RECORD_SECRET_FIELDS.reduce(
    withDecryptedRecordSecrets,
    config as Record<string, unknown>,
  );

  const endpoints = getPlainRecord(result.endpoints);
  const azure = getPlainRecord(endpoints?.azureOpenAI);
  const groups = azure?.groups;
  if (endpoints && azure && Array.isArray(groups)) {
    const decryptedGroups = groups.map((group) => withDecryptedKey(group, 'apiKey'));
    if (decryptedGroups.some((group, index) => group !== groups[index])) {
      result = {
        ...result,
        endpoints: { ...endpoints, azureOpenAI: { ...azure, groups: decryptedGroups } },
      };
    }
  }
  return result as T;
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

  for (const key of Object.keys(result)) {
    const recordSecret = findRecordSecretPath(key);
    if (!recordSecret) {
      continue;
    }
    if (recordSecret.preview) {
      delete result[key];
      continue;
    }
    writeDottedRecordSecret(result, key, recordSecret.field);
  }

  return result;
}

/** Writes a record secret addressed by its full dotted path, with its preview path beside it. */
function writeDottedRecordSecret(
  result: Record<string, unknown>,
  fieldPath: string,
  field: RecordSecretField,
): void {
  const key = getRecordSecretKey(field);
  const container: Record<string, unknown> = { [key]: result[fieldPath] };
  applyRecordSecretWrite(container, field);
  result[fieldPath] = container[key];
  result[getRecordPreviewPath(fieldPath, field)] = container[field.previewKey];
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

  for (const field of RECORD_SECRET_FIELDS) {
    for (const { parent } of collectRecordSecretParents(result, field, basePath, true)) {
      applyRecordSecretWrite(parent, field);
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
        section[previewKey] = normalizeStoredPreview(existingPreview);
      } else if (!isAlreadyEncrypted && !isPlaceholder) {
        section[previewKey] = getSecretPreview(existingSecret);
      }
    }
  }

  preserveArraySecrets(result, existing, basePath);
  preserveRecordSecrets(result, existing, basePath);
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
 * Gives a plaintext secret without a preview the one its next save would
 * write. A value stored before its path joined the registry stays plaintext
 * until its section is saved again, and the runtime still reads it, so a read
 * must show it as set.
 */
function previewLegacyPlaintext(
  section: Record<string, unknown>,
  previewKey: string,
  value: unknown,
): void {
  const plaintext = normalizeSecretString(value);
  if (!plaintext || section[previewKey] || isEncryptedSecretPayload(plaintext)) {
    return;
  }
  section[previewKey] = getSecretPreview(plaintext);
}

interface RedactConfigSecretsOptions {
  /** Gives a plaintext secret without a preview the one its next save would write. */
  previewPlaintext?: boolean;
  /** The librechat.yaml config a merged `root` came from; plaintext values it supplies get no preview. */
  yamlConfig?: unknown;
}

/**
 * Deletes registered secret values from `root` in place so admin reads never
 * return them (encrypted or plaintext). Preview companions and plain
 * `${ENV_VAR}` references (for fields that allow them) are preserved. A value
 * removed without a stored preview (a librechat.yaml literal, or plaintext an
 * older server stored) gets the fixed {@link UNPREVIEWED_SECRET_MASK}, so the
 * read still says a secret is set without deriving anything from the value;
 * only `previewPlaintext` gives a scalar plaintext an override stored the
 * preview its next save writes instead. Secret *maps* are masked value-by-value.
 * The caller passes a cloned object.
 */
export function redactConfigSecrets<T>(
  root: T,
  { previewPlaintext = false, yamlConfig }: RedactConfigSecretsOptions = {},
): T {
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
    const previewKey = lastSegment(field.previewPath);
    if (typeof section[previewKey] === 'string') {
      section[previewKey] = normalizeStoredPreview(section[previewKey]);
    }
    const key = segments[segments.length - 1];
    if (!(key in section)) {
      continue;
    }
    const value = section[key];
    if (field.allowEnvPlaceholder && typeof value === 'string' && isEnvPlaceholder(value)) {
      continue;
    }
    if (previewPlaintext && walkToParent(yamlConfig, segments)?.[key] !== value) {
      previewLegacyPlaintext(section, previewKey, value);
    }
    delete section[key];
    maskUnpreviewedSecret(section, previewKey, value);
  }

  for (const field of ARRAY_SECRET_FIELDS) {
    const entries = getSecretArray(rootRecord, field);
    if (!entries) {
      continue;
    }
    for (const item of entries) {
      const entry = getPlainRecord(item);
      if (!entry) {
        continue;
      }
      if (typeof entry[field.previewKey] === 'string') {
        entry[field.previewKey] = normalizeStoredPreview(entry[field.previewKey] as string);
      }
      const value = entry[field.secretKey];
      if (shouldRedactArraySecretValue(value, field)) {
        delete entry[field.secretKey];
        maskUnpreviewedSecret(entry, field.previewKey, value);
      }
    }
  }

  redactRecordSecrets(rootRecord);
  return root;
}

/** Deletes the value at `segments` under `node` unless it is empty or a pass-through reference. */
function redactResolvedSecret(
  node: unknown,
  segments: readonly string[],
  field: ResolvedSecretField,
): void {
  const [segment, ...rest] = segments;
  if (segment === '*') {
    const children = Array.isArray(node) ? node : Object.values(getPlainRecord(node) ?? {});
    for (const child of children) {
      redactResolvedSecret(child, rest, field);
    }
    return;
  }
  const record = getPlainRecord(node);
  if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
    return;
  }
  if (rest.length > 0) {
    redactResolvedSecret(record[segment], rest, field);
    return;
  }
  const value = record[segment];
  if (typeof value === 'string') {
    const normalized = normalizeSecretString(value);
    if (normalized == null || field.isPassthroughValue(normalized)) {
      return;
    }
  }
  delete record[segment];
}

/**
 * Deletes, in place, the credentials a resolved config carries outside the write registry
 * (`RESOLVED_SECRET_FIELDS`), for admin reads of the AppConfig or its raw `config`. Empty
 * values and pass-through references stay readable; anything else that is not a string is
 * removed too. Stored override documents are left alone: their writes do not preserve an
 * omitted value at these paths yet, so redacting them would break a read-then-write round
 * trip. The caller passes a cloned object.
 */
export function redactResolvedConfigSecrets<T>(root: T): T {
  for (const field of RESOLVED_SECRET_FIELDS) {
    redactResolvedSecret(root, field.segments, field);
  }
  return root;
}
