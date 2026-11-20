import isPlainObject from 'lodash/isPlainObject';
import {
  getAtPath,
  setAtPath,
  isPlainRecord,
  webSearchPairedFields,
  getRebindingWebSearchKeys,
} from '@librechat/data-schemas';
import type { Config, ConfigOverrideIssue, ConfigOverrideState } from '@librechat/data-schemas';
import { getSecretBindingKey, getBoundSecretLocations } from '~/app/rebinding';
import { isEncryptedConfigSecret, isUserVariableTemplate } from './secrets';
import { isUserProvided } from '~/utils/common';

/** Issue code for a URL a write changed while the secret stored beside it stays. */
export const SECRET_REENTRY_REQUIRED = 'secret_reentry_required';

/** A URL whose stored secret must be entered again in the same write. */
export interface SecretReentryIssue extends ConfigOverrideIssue {
  /** Dot-path of the stored secret to enter again. */
  secretPath: string;
}

/** The parts of a stored config document a re-entry check reads. */
export type StoredConfigState = Pick<Config, 'overrides' | 'tombstones'> | null | undefined;

type ConfigFields = Record<string, unknown>;

const WEB_SEARCH = 'webSearch';
const WEB_SEARCH_PREFIX = `${WEB_SEARCH}.`;
const PAIRED_FIELDS: ReadonlySet<string> = new Set(webSearchPairedFields);

function getRecord(value: unknown): ConfigFields | undefined {
  return isPlainObject(value) ? (value as ConfigFields) : undefined;
}

function getWebSearch(overrides: unknown): ConfigFields | undefined {
  return getRecord(getRecord(overrides)?.[WEB_SEARCH]);
}

/** The paired web search field a dot-path names directly, such as `searxngInstanceUrl`. */
function getPairedField(fieldPath: string): string | undefined {
  if (!fieldPath.startsWith(WEB_SEARCH_PREFIX)) {
    return undefined;
  }
  const field = fieldPath.slice(WEB_SEARCH_PREFIX.length);
  return PAIRED_FIELDS.has(field) ? field : undefined;
}

/**
 * A document's own web search values as the re-entry rule compares them. A
 * paired field the document tombstones and does not set reads as `null`,
 * since the tombstone suppresses the inherited value as a `null` would.
 */
function getWebSearchView(
  webSearch: ConfigFields | undefined,
  tombstones: readonly string[] = [],
): ConfigFields | undefined {
  const suppressed: readonly string[] = tombstones.includes(WEB_SEARCH)
    ? webSearchPairedFields
    : tombstones.flatMap((path) => getPairedField(path) ?? []);
  if (suppressed.length === 0) {
    return webSearch;
  }
  const view: ConfigFields = {};
  for (const field of suppressed) {
    view[field] = null;
  }
  return { ...view, ...webSearch };
}

function toReentryIssues(
  stored: ConfigFields | undefined,
  next: ConfigFields | undefined,
  written: ReadonlySet<string>,
): SecretReentryIssue[] {
  return getRebindingWebSearchKeys(stored, next, written).map(({ url, apiKey }) => ({
    path: `${WEB_SEARCH_PREFIX}${url}`,
    segments: [WEB_SEARCH, url],
    code: SECRET_REENTRY_REQUIRED,
    secretPath: `${WEB_SEARCH_PREFIX}${apiKey}`,
  }));
}

/**
 * Whether writing, removing or tombstoning this path can change where a
 * stored web search key is sent. Such a write must apply to the document
 * version its re-entry check read.
 */
export function isWebSearchBindingPath(fieldPath: string): boolean {
  return fieldPath === WEB_SEARCH || getPairedField(fieldPath) != null;
}

/**
 * Re-entry issues for a write (a replace, a field patch, a batch of changes
 * or a field removal), judged on the document it would store: each stored
 * key the planned document keeps beside a paired URL the write set, changed,
 * blanked or removed.
 *
 * A key counts as entered again only when the planned document holds a value
 * the request itself entered (`getEnteredConfigSecrets`). Writes apply in
 * order, so a later write can put the stored key back over one an earlier
 * write supplied (a whole `webSearch` after one of its keys); judging by the
 * value the document ends up with, not by the paths the request wrote, keeps
 * that order from hiding a kept key.
 * @param stored - The document before the write.
 * @param next - The overrides and tombstones the write would store, omitted secrets preserved.
 * @param entered - The secret values the request itself entered, encrypted; none for a removal.
 */
export function getWebSearchReentryIssues(
  stored: StoredConfigState,
  next: StoredConfigState,
  entered: ReadonlySet<string>,
): SecretReentryIssue[] {
  const nextWebSearch = getWebSearch(next?.overrides);
  const written = new Set<string>();
  for (const [field, value] of Object.entries(nextWebSearch ?? {})) {
    if (typeof value === 'string' && entered.has(value)) {
      written.add(field);
    }
  }
  return toReentryIssues(
    getWebSearchView(getWebSearch(stored?.overrides), stored?.tombstones),
    getWebSearchView(nextWebSearch, next?.tombstones),
    written,
  );
}

/** A key the rebinding guard binds to a destination: set, and not a value each user enters. */
function isBindableKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed !== '' && !isUserProvided(trimmed) && !isUserVariableTemplate(trimmed);
}

/** A destination fingerprint a stored document holds beside one of its keys. */
interface StoredBinding {
  identity: string;
  value: string;
  fingerprint: string;
}

function getStoredBindings(overrides: unknown): StoredBinding[] {
  return getBoundSecretLocations(overrides).flatMap(({ owner, key, identity }) => {
    const record = getAtPath(overrides, owner);
    if (!isPlainRecord(record)) {
      return [];
    }
    const value = record[key];
    const fingerprint = record[getSecretBindingKey(key)];
    return typeof value === 'string' && typeof fingerprint === 'string'
      ? [{ identity, value, fingerprint }]
      : [];
  });
}

/**
 * The fingerprint a kept key brings from the stored document: the one beside the same value at
 * the same secret, or, for a ciphertext (which only the stored key it was carried from holds),
 * beside the same value anywhere, so a rename or copy keeps the destination it was entered for.
 */
function getKeptFingerprint(
  stored: readonly StoredBinding[],
  identity: string,
  value: string,
): string | undefined {
  const same = stored.find((binding) => binding.identity === identity && binding.value === value);
  if (same != null || !isEncryptedConfigSecret(value)) {
    return same?.fingerprint;
  }
  return stored.find((binding) => binding.value === value)?.fingerprint;
}

/**
 * Sets the destination fingerprint (`<key>Binding`) beside each bound key a planned document
 * holds, so the merge's rebinding guard keeps a key only where it was entered:
 * - a key the request entered gets the fingerprint of where the merge sends it over the floor
 *   (`destinations`, from the guard's report), when that is not where librechat.yaml and the
 *   document alone send it; otherwise none, since the guard then needs none;
 * - a key the request kept brings the fingerprint stored beside it;
 * - anything else, a fingerprint a client sent included, is removed.
 *
 * Only this server writes the fingerprints: whatever the request held there is replaced.
 * @param destinations - Fingerprints by secret identity (`getRebindingIdentity`); none for a
 *   write that enters nothing, or that binds nothing new.
 */
export function bindSecretDestinations(params: {
  stored: StoredConfigState;
  candidate: ConfigOverrideState;
  entered: ReadonlySet<string>;
  destinations?: ReadonlyMap<string, string>;
}): ConfigOverrideState {
  const { stored, candidate, entered, destinations } = params;
  const storedBindings = getStoredBindings(stored?.overrides);
  let overrides = candidate.overrides as ConfigFields;
  for (const { owner, key, identity } of getBoundSecretLocations(candidate.overrides)) {
    const record = getAtPath(overrides, owner);
    if (!isPlainRecord(record)) {
      continue;
    }
    const value = record[key];
    const companion = getSecretBindingKey(key);
    let fingerprint: string | undefined;
    if (isBindableKey(value)) {
      fingerprint = entered.has(value)
        ? destinations?.get(identity)
        : getKeptFingerprint(storedBindings, identity, value);
    }
    if (record[companion] === fingerprint) {
      continue;
    }
    const { [companion]: _previous, ...rest } = record;
    overrides = setAtPath(
      overrides,
      owner,
      fingerprint === undefined ? rest : { ...rest, [companion]: fingerprint },
    );
  }
  return overrides === candidate.overrides
    ? candidate
    : { ...candidate, overrides: overrides as ConfigOverrideState['overrides'] };
}

/**
 * Whether a planned document holds a key the request entered at a place the merge binds to a
 * destination, so its fingerprint must be worked out over the floor.
 */
export function entersBoundSecret(
  candidate: ConfigOverrideState,
  entered: ReadonlySet<string>,
): boolean {
  if (entered.size === 0) {
    return false;
  }
  return getBoundSecretLocations(candidate.overrides).some(({ owner, key }) => {
    const value = getAtPath(getAtPath(candidate.overrides, owner), [key]);
    return isBindableKey(value) && entered.has(value);
  });
}
