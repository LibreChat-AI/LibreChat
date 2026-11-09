import { PrincipalType } from 'librechat-data-provider';
import {
  getAtPath,
  isPlainRecord,
  isSameConfigValue,
  resolveAzureGroups,
  foldConfigMergeKey,
  mergeConfigEntries,
  mergeConfigOverrides,
  applyConfigTombstones,
} from '@librechat/data-schemas';
import type { AppConfig, ConfigOverrideState } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { CredentialBindingConfig } from '~/mcp/registry/binding';
import type { SecretBinding } from '~/app/rebinding';
import type { SecretReentryIssue } from './binding';
import {
  SECRET_BINDINGS,
  getSecretBindingKey,
  diffAzureGroupBinding,
  getAzureGroupFingerprint,
  getServerSecretFingerprint,
  getChangedScalarBindingKeys,
  getScalarBindingFingerprint,
  getCustomEndpointFingerprint,
  getChangedCustomEndpointBinding,
} from '~/app/rebinding';
import {
  diffApiKeyBinding,
  preserveOmittedOAuthBindingFields,
  getChangedOAuthSecretBindingFields,
} from '~/mcp/registry/binding';
import { MCPApiKeyReentryRequiredError, MCPOAuthSecretReentryRequiredError } from '~/mcp/errors';
import { isSameStoredSecret, isCredentialReference, isMCPCredentialReference } from './secrets';
import { SECRET_REENTRY_REQUIRED } from './binding';

type JsonRecord = Record<string, unknown>;

/** A write that keeps a stored MCP credential while changing where it is sent. */
export interface SecretReentry {
  code: MCPApiKeyReentryRequiredError['code'] | MCPOAuthSecretReentryRequiredError['code'];
  message: string;
  /** The server whose credential must be entered again. */
  server: string;
  /** The binding fields the write changed. */
  fields: string[];
}

interface StoredDocument {
  overrides?: unknown;
  tombstones?: unknown[];
}

/** Whether a stored value is a credential a read hides: set, and not a `${VAR}`/`{{VAR}}` reference. */
function isHiddenSecret(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed !== '' && !isMCPCredentialReference(trimmed);
}

/**
 * The override sections that hold MCP servers: `mcpServers` and its AppConfig name `mcpConfig`,
 * which the merge also applies. A document's later section replaces the earlier one whole, so a
 * server's credential and destination are only ever combined within one section.
 */
export const MCP_SERVER_SECTIONS = ['mcpServers', 'mcpConfig'] as const;
type MCPServerSection = (typeof MCP_SERVER_SECTIONS)[number];

function getServers(overrides: unknown, section: MCPServerSection): JsonRecord {
  const servers = isPlainRecord(overrides) ? overrides[section] : undefined;
  return isPlainRecord(servers) ? servers : {};
}

/** Tombstones as librechat.yaml paths: one under `mcpConfig` removes the same `mcpServers` field. */
function toYamlTombstones(tombstones: unknown[] | undefined): unknown[] | undefined {
  return tombstones?.map((path) =>
    typeof path === 'string' && (path === 'mcpConfig' || path.startsWith('mcpConfig.'))
      ? `mcpServers${path.slice('mcpConfig'.length)}`
      : path,
  );
}

/** Layers `override` over `base` as the config merge does: objects merge, anything else replaces. */
function mergeLayer(base: unknown, override: unknown): unknown {
  if (override === undefined) {
    return base;
  }
  if (!isPlainRecord(base) || !isPlainRecord(override)) {
    return override;
  }
  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = mergeLayer(base[key], value);
  }
  return merged;
}

/**
 * A server as it resolves for this document: librechat.yaml under its tombstones, then the
 * override. Only its binding fields are read, each compared for equality.
 */
function getEffectiveServer(
  base: Partial<TCustomConfig>,
  tombstones: unknown[] | undefined,
  name: string,
  override: unknown,
): CredentialBindingConfig {
  const baseServer = getAtPath(applyConfigTombstones(base, toYamlTombstones(tombstones)), [
    'mcpServers',
    name,
  ]);
  const merged = mergeLayer(baseServer, override);
  return isPlainRecord(merged) ? (merged as CredentialBindingConfig) : {};
}

const MCP_SECRETS = [
  { parent: 'apiKey', key: 'key' },
  { parent: 'oauth', key: 'client_secret' },
] as const;

function getChangedBindingFields(
  parent: 'apiKey' | 'oauth',
  stored: CredentialBindingConfig,
  candidate: CredentialBindingConfig,
): string[] {
  if (parent === 'apiKey') {
    return diffApiKeyBinding(stored, candidate);
  }
  return getChangedOAuthSecretBindingFields(stored, {
    ...candidate,
    oauth: preserveOmittedOAuthBindingFields(stored.oauth ?? {}, candidate.oauth ?? {}),
  });
}

function toReentry(parent: 'apiKey' | 'oauth', server: string, fields: string[]): SecretReentry {
  const error =
    parent === 'apiKey'
      ? new MCPApiKeyReentryRequiredError(fields)
      : new MCPOAuthSecretReentryRequiredError(fields);
  return { code: error.code, message: error.message, server, fields };
}

type MCPSecret = (typeof MCP_SECRETS)[number];

/** A server of the stored document that holds a credential a read hides. */
interface StoredCredential {
  section: MCPServerSection;
  name: string;
  server: unknown;
  value: string;
}

function getStoredCredentials(
  stored: StoredDocument | null | undefined,
  { parent, key }: MCPSecret,
): StoredCredential[] {
  return MCP_SERVER_SECTIONS.flatMap((section) =>
    Object.entries(getServers(stored?.overrides, section)).flatMap(([name, server]) => {
      const value = getAtPath(server, [parent, key]);
      return isHiddenSecret(value) ? [{ section, name, server, value }] : [];
    }),
  );
}

/**
 * The stored servers a kept credential came from, the server of the same name first: those that
 * hold the same value, wherever the write moved it (a rename, a duplicate, a chain of either).
 * When none does, the stored server of the same name, so an unexpected value is still judged.
 */
function findOrigins(
  held: readonly StoredCredential[],
  value: string,
  section: MCPServerSection,
  name: string,
): StoredCredential[] {
  const isSameServer = (credential: StoredCredential) =>
    credential.section === section && credential.name === name;
  const matches = held.filter((credential) => isSameStoredSecret(credential.value, value));
  const origins = matches.length > 0 ? matches : held.filter(isSameServer);
  return [...origins.filter(isSameServer), ...origins.filter((origin) => !isSameServer(origin))];
}

/**
 * The admin config tier's version of the user-managed tier's key re-entry rule
 * (`mcp/registry/binding.ts`): a write that keeps a stored MCP credential (`apiKey.key`,
 * `oauth.client_secret`) while changing where the server sends it must enter the credential
 * again.
 *
 * - **Kept is judged by value.** A credential counts as entered again only when the planned
 *   document holds a value the request itself entered (`getEnteredConfigSecrets`). A key one
 *   write supplied and a later write of the same request replaced with the stored one was not,
 *   whatever paths the request wrote.
 * - **Compared with where it was.** A kept credential is compared with every stored server that
 *   held the same value, so a rename, a duplicate or a chain of them is followed, and a name
 *   swap that moves each key with its own server changes nothing. The write is refused unless
 *   one of them sends it where the candidate does.
 * - **As servers resolve.** Servers are compared as they resolve for this document:
 *   librechat.yaml under the document's tombstones, then its override.
 *
 * Only credentials a read hides count: a `${VAR}` or `{{VAR}}` reference is visible, so a client
 * can resend it. Both sections that hold MCP servers (`mcpServers` and its alias `mcpConfig`)
 * are checked. Rebinding across layers (a profile changing a server another layer holds the key
 * for) is the merge's to handle (`app/rebinding.ts`).
 */
export function findSecretReentry(params: {
  stored: StoredDocument | null | undefined;
  candidate: ConfigOverrideState;
  base: Partial<TCustomConfig>;
  /** The secret values the request itself entered, encrypted. */
  entered: ReadonlySet<string>;
}): SecretReentry | null {
  const { stored, candidate, base, entered } = params;
  const held = new Map<MCPSecret, StoredCredential[]>();
  for (const section of MCP_SERVER_SECTIONS) {
    for (const [name, server] of Object.entries(getServers(candidate.overrides, section))) {
      for (const secret of MCP_SECRETS) {
        const value = getAtPath(server, [secret.parent, secret.key]);
        if (!isHiddenSecret(value) || entered.has(value)) {
          continue;
        }
        const credentials = held.get(secret) ?? getStoredCredentials(stored, secret);
        held.set(secret, credentials);
        const origins = findOrigins(credentials, value, section, name);
        if (origins.length === 0) {
          continue;
        }
        const target = getEffectiveServer(base, candidate.tombstones, name, server);
        const fingerprint = getServerSecretFingerprint(secret.parent, target);
        const bindingKey = getSecretBindingKey(secret.key);
        const changes = origins.map((origin) =>
          getAtPath(origin.server, [secret.parent, bindingKey]) === fingerprint
            ? []
            : getChangedBindingFields(
                secret.parent,
                getEffectiveServer(base, stored?.tombstones, origin.name, origin.server),
                target,
              ),
        );
        if (changes.every((fields) => fields.length > 0)) {
          return toReentry(secret.parent, name, changes[0]);
        }
      }
    }
  }
  return null;
}

/** Where Azure groups sit, in an override document and in the resolved config alike. */
const AZURE_SEGMENTS = ['endpoints', 'azureOpenAI'] as const;

/** Whether an Azure group key is one a read hides: set, and not `${VAR}` or `user_provided`. */
function isHiddenGroupKey(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed !== '' && !isCredentialReference(trimmed);
}

function getAzureSection(overrides: unknown): JsonRecord {
  const azure = getAtPath(overrides, AZURE_SEGMENTS);
  return isPlainRecord(azure) ? azure : {};
}

function getGroupItems(azure: JsonRecord): JsonRecord[] {
  return Array.isArray(azure.groups) ? azure.groups.filter(isPlainRecord) : [];
}

function getGroupMap(azure: JsonRecord): JsonRecord {
  return isPlainRecord(azure.groupMap) ? azure.groupMap : {};
}

/** librechat.yaml's Azure groups: as written (`groups`), and as they resolve (`groupMap`). */
export interface BaseAzureGroups {
  groups: unknown;
  groupMap: unknown;
}

const GROUPS_SEGMENTS = [...AZURE_SEGMENTS, 'groups'];

/** librechat.yaml's Azure groups under a document's tombstones. */
function getBaseUnder(base: BaseAzureGroups, document: StoredDocument | null | undefined) {
  const azure = getAtPath(
    applyConfigTombstones(
      {
        endpoints: { azureOpenAI: { groups: base.groups, groupMap: base.groupMap } },
      } as Partial<TCustomConfig>,
      document?.tombstones,
    ),
    AZURE_SEGMENTS,
  );
  return {
    groups: isPlainRecord(azure) ? azure.groups : undefined,
    groupMap: isPlainRecord(azure) ? azure.groupMap : undefined,
  };
}

/**
 * The Azure groups a document resolves to on its own over librechat.yaml, by name, as the merge
 * resolves one layer: its `groups` merge by `group` over librechat.yaml's and resolve
 * (`resolveAzureGroups`), else librechat.yaml's resolved groups stay under its tombstones; its
 * `groupMap` entries merge over either.
 */
function getEffectiveAzureGroups(
  document: StoredDocument | null | undefined,
  base: BaseAzureGroups,
): Map<string, JsonRecord> {
  const azure = getAzureSection(document?.overrides);
  const under = getBaseUnder(base, document);
  const resolved = Array.isArray(azure.groups)
    ? resolveAzureGroups(mergeConfigEntries(GROUPS_SEGMENTS, under.groups, azure.groups))
    : undefined;
  const below = resolved?.isValid ? resolved.groupMap : under.groupMap;
  const merged = mergeLayer(below, getGroupMap(azure));
  return new Map(
    Object.entries(isPlainRecord(merged) ? merged : {}).flatMap(([name, group]) =>
      isPlainRecord(group) ? [[name, group]] : [],
    ),
  );
}

/**
 * Each `groups` item a document writes, merged over librechat.yaml's group of its name as the
 * merge merges them, by name: a group as it would be sent even while the document's groups do not
 * resolve as a whole.
 */
function getMergedGroupItems(
  document: StoredDocument | null | undefined,
  base: BaseAzureGroups,
): Array<[string, JsonRecord]> {
  const items = getGroupItems(getAzureSection(document?.overrides));
  const names = new Set(
    items.flatMap((item) => (typeof item.group === 'string' ? [item.group] : [])),
  );
  return mergeConfigEntries(GROUPS_SEGMENTS, getBaseUnder(base, document).groups, items).flatMap(
    (item): Array<[string, JsonRecord]> =>
      isPlainRecord(item) && typeof item.group === 'string' && names.has(item.group)
        ? [[item.group, item]]
        : [],
  );
}

/** Every hidden group key a document stores, in `groups` and in `groupMap`. */
function getStoredGroupKeys(azure: JsonRecord): string[] {
  return [...getGroupItems(azure), ...Object.values(getGroupMap(azure))].flatMap((group) => {
    const value = isPlainRecord(group) ? group.apiKey : undefined;
    return isHiddenGroupKey(value) ? [value] : [];
  });
}

/**
 * Where a document writes the group a key belongs to, in librechat.yaml keys: its `groupMap`
 * entry when that holds the field (or the key), else its `groups` item of that name.
 */
function locateGroupField(azure: JsonRecord, name: string, field: string): string[] {
  const mapped = getGroupMap(azure)[name];
  if (isPlainRecord(mapped) && field in mapped) {
    return [...AZURE_SEGMENTS, 'groupMap', name, field];
  }
  const index = getGroupItems(azure).findIndex((group) => group.group === name);
  if (index >= 0) {
    return [...AZURE_SEGMENTS, 'groups', String(index), field];
  }
  return [...AZURE_SEGMENTS, 'groupMap', name, field];
}

/**
 * The Azure form of the re-entry rule web search and MCP keys follow: a write that keeps a
 * stored group key (in `groups` or `groupMap`) while changing where the group sends it must enter
 * the key again. Groups are compared as the document resolves them on its own over
 * librechat.yaml ({@link getEffectiveAzureGroups}), and each `groups` item also merged over
 * librechat.yaml's group of its name ({@link getMergedGroupItems}), so groups that do not resolve
 * yet cannot carry a key to a new destination for a later write to put to use; destinations are
 * compared by `diffAzureGroupBinding`. A
 * key counts as entered again only when the planned document holds a value the request entered;
 * a kept one is compared with every stored group that held the same value, so the write is
 * refused unless one of them sent it where the candidate does. Only keys the stored document
 * holds are judged: librechat.yaml's own are the merge's to bind (`app/rebinding.ts`).
 */
export function getAzureGroupReentryIssues(params: {
  stored: StoredDocument | null | undefined;
  candidate: ConfigOverrideState;
  /** librechat.yaml's Azure groups, as written and as resolved in the base config. */
  base: BaseAzureGroups;
  /** The secret values the request itself entered, encrypted. */
  entered: ReadonlySet<string>;
}): SecretReentryIssue[] {
  const { stored, candidate, base, entered } = params;
  const storedAzure = getAzureSection(stored?.overrides);
  const held = getStoredGroupKeys(storedAzure);
  if (held.length === 0) {
    return [];
  }
  const candidateAzure = getAzureSection(candidate.overrides);
  /** As the document resolves, and each `groups` item merged alone, which may not resolve yet. */
  const candidates: Array<[string, JsonRecord]> = [
    ...getEffectiveAzureGroups(candidate, base),
    ...getMergedGroupItems(candidate, base),
  ];
  let origins: JsonRecord[] | undefined;
  const issues = new Map<string, SecretReentryIssue>();
  for (const [name, group] of candidates) {
    const value = group.apiKey;
    if (
      !isHiddenGroupKey(value) ||
      entered.has(value) ||
      !held.some((stored) => isSameStoredSecret(stored, value))
    ) {
      continue;
    }
    /** Every stored definition of a group: as it resolved, and each `groups` item merged alone. */
    origins ??= [
      ...getEffectiveAzureGroups(stored, base).values(),
      ...getMergedGroupItems(stored, base).map(([, item]) => item),
    ];
    const fingerprint = getAzureGroupFingerprint(group);
    const changes = origins
      .filter((origin) => isSameStoredSecret(origin.apiKey, value))
      .map((origin) =>
        origin[getSecretBindingKey('apiKey')] === fingerprint
          ? []
          : diffAzureGroupBinding(origin, group),
      );
    if (changes.length === 0 || changes.some((fields) => fields.length === 0)) {
      continue;
    }
    const segments = locateGroupField(candidateAzure, name, changes[0][0]);
    const path = segments.join('.');
    issues.set(path, {
      path,
      segments,
      code: SECRET_REENTRY_REQUIRED,
      secretPath: locateGroupField(candidateAzure, name, 'apiKey').join('.'),
    });
  }
  return [...issues.values()];
}

const CUSTOM_ENDPOINTS = ['endpoints', 'custom'] as const;
const CUSTOM_ENDPOINTS_PATH = CUSTOM_ENDPOINTS.join('.');

/** A principal no document belongs to, for merging one document alone. */
const ALONE_PRINCIPAL = '__reentry__';

/**
 * Where a document alone sends its secrets: librechat.yaml's resolved config with only this
 * document merged over it, as the merge's rebinding guard measures a layer's own destination
 * (`alone()`), tombstones, folded endpoint names and all.
 */
function resolveAlone(
  document: StoredDocument | ConfigOverrideState | null | undefined,
  baseConfig: AppConfig,
): AppConfig {
  return mergeConfigOverrides(baseConfig, [
    {
      principalType: PrincipalType.ROLE,
      principalId: ALONE_PRINCIPAL,
      priority: 0,
      overrides: (document?.overrides ?? {}) as Partial<TCustomConfig>,
      tombstones: document?.tombstones,
    },
  ]);
}

/** A custom endpoint of an override document, with its index there. */
interface EndpointItem {
  index: number;
  entry: JsonRecord;
  identity: string;
}

function getEndpointItems(overrides: unknown): EndpointItem[] {
  const items = getAtPath(overrides, CUSTOM_ENDPOINTS);
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((entry, index) =>
    isPlainRecord(entry) && typeof entry.name === 'string'
      ? [{ index, entry, identity: foldConfigMergeKey(CUSTOM_ENDPOINTS_PATH, entry.name) }]
      : [],
  );
}

/** A resolved config's custom endpoints by the identity the merge folds their names to, first one kept. */
function getResolvedEndpoints(config: AppConfig): Map<string, JsonRecord> {
  const resolved = new Map<string, JsonRecord>();
  for (const { entry, identity } of getEndpointItems(config)) {
    if (!resolved.has(identity)) {
      resolved.set(identity, entry);
    }
  }
  return resolved;
}

function toReentryIssue(segments: string[], secretSegments: string[]): SecretReentryIssue {
  return {
    path: segments.join('.'),
    segments,
    code: SECRET_REENTRY_REQUIRED,
    secretPath: secretSegments.join('.'),
  };
}

/** The resolved configs a document alone sends its secrets by, before and after a write. */
interface AloneConfigs {
  stored: AppConfig;
  candidate: AppConfig;
}

function getScalarReentryIssue(
  binding: SecretBinding,
  stored: StoredDocument | null | undefined,
  alone: AloneConfigs,
): SecretReentryIssue | null {
  const { path, secretKey } = binding;
  const origin = getAtPath(stored?.overrides, path);
  if (!isPlainRecord(origin) || !isHiddenGroupKey(origin[secretKey])) {
    return null;
  }
  const target = getAtPath(alone.candidate, path);
  const sent = isPlainRecord(target) ? target : {};
  const reference = getAtPath(alone.stored, path);
  const changed = getChangedScalarBindingKeys(
    binding,
    isPlainRecord(reference) ? reference : null,
    sent,
  );
  if (
    changed.length === 0 ||
    origin[getSecretBindingKey(secretKey)] === getScalarBindingFingerprint(binding, sent)
  ) {
    return null;
  }
  return toReentryIssue([...path, changed[0]], [...path, secretKey]);
}

/** The parts of a document that decide where its custom endpoint, OCR and speech keys go. */
function getBoundSections(document: StoredDocument | ConfigOverrideState | null | undefined) {
  const overrides = isPlainRecord(document?.overrides) ? document.overrides : {};
  const endpoints = isPlainRecord(overrides.endpoints) ? overrides.endpoints : {};
  return {
    custom: endpoints.custom,
    ocr: overrides.ocr,
    speech: overrides.speech,
    tombstones: document?.tombstones ?? [],
  };
}

/** Whether a write changed anything those keys or their destinations sit in. */
function movesBoundSections(
  stored: StoredDocument | null | undefined,
  candidate: ConfigOverrideState,
): boolean {
  return !isSameConfigValue(getBoundSections(stored), getBoundSections(candidate));
}

/** A changed binding location of an endpoint, as a write names it: `dropParams` whole. */
function toEndpointField(location: readonly string[]): string[] {
  return location[0] === 'dropParams' ? ['dropParams'] : [...location];
}

function getEndpointReentryIssue(
  item: EndpointItem,
  held: readonly EndpointItem[],
  alone: AloneConfigs & {
    storedEndpoints: Map<string, JsonRecord>;
    candidateEndpoints: Map<string, JsonRecord>;
  },
): SecretReentryIssue | null {
  const value = item.entry.apiKey as string;
  const matches = held.filter(({ entry }) => isSameStoredSecret(entry.apiKey, value));
  const origins =
    matches.length > 0 ? matches : held.filter(({ identity }) => identity === item.identity);
  if (origins.length === 0) {
    return null;
  }
  const target = alone.candidateEndpoints.get(item.identity) ?? item.entry;
  const fingerprint = getCustomEndpointFingerprint(target);
  const changes = origins.map(({ entry, identity }) => {
    const changed = getChangedCustomEndpointBinding(
      alone.storedEndpoints.get(identity) ?? entry,
      target,
    );
    return entry[getSecretBindingKey('apiKey')] === fingerprint ? [] : changed;
  });
  if (changes.some((changed) => changed.length === 0)) {
    return null;
  }
  const entry = [...CUSTOM_ENDPOINTS, String(item.index)];
  return toReentryIssue([...entry, ...toEndpointField(changes[0][0])], [...entry, 'apiKey']);
}

/**
 * The re-entry rule for the keys whose destination sits beside them: each custom endpoint's
 * `apiKey` (bound to its base URL, `provider` and destination options) and OCR's and each speech
 * service's key (bound to their URL or instance; `SECRET_BINDINGS`). A write that keeps one of
 * these stored keys while changing where the document sends it must enter the key again, as for
 * MCP credentials, web search keys and Azure group keys.
 *
 * - **Kept is judged by value.** A key counts as entered again only when the planned document
 *   holds a value the request itself entered.
 * - **Compared with where it was.** A kept endpoint key is compared with every stored endpoint
 *   that held the same value, so a rename or a copy is followed; a scalar key with the stored
 *   one at its own path.
 * - **As the document alone sends it.** Destinations are read from librechat.yaml's resolved
 *   config with only the document merged over it, as the merge's rebinding guard measures a
 *   layer's own keys, so restating librechat.yaml's destination changes nothing. A destination
 *   the stored key was bound to over a lower layer (its `<key>Binding` fingerprint) counts as
 *   where it was too, so restating that destination keeps the key as well.
 *
 * Only keys a read hides count: a `${VAR}` reference or `user_provided` is visible, so a client
 * can resend it.
 */
export function getBoundKeyReentryIssues(params: {
  stored: StoredDocument | null | undefined;
  candidate: ConfigOverrideState;
  /** librechat.yaml's resolved config; without one, the documents resolve over nothing. */
  baseConfig: AppConfig | undefined;
  /** The secret values the request itself entered, encrypted. */
  entered: ReadonlySet<string>;
}): SecretReentryIssue[] {
  const { stored, candidate, entered } = params;
  const isKept = (value: unknown): value is string =>
    isHiddenGroupKey(value) && !entered.has(value);
  const scalars = SECRET_BINDINGS.filter((binding) =>
    isKept(getAtPath(candidate.overrides, [...binding.path, binding.secretKey])),
  );
  const endpoints = getEndpointItems(candidate.overrides).filter(({ entry }) =>
    isKept(entry.apiKey),
  );
  if ((scalars.length === 0 && endpoints.length === 0) || !movesBoundSections(stored, candidate)) {
    return [];
  }
  const baseConfig = params.baseConfig ?? ({} as AppConfig);
  const alone = {
    stored: resolveAlone(stored, baseConfig),
    candidate: resolveAlone(candidate, baseConfig),
  };
  const scalarIssues = scalars.flatMap(
    (binding) => getScalarReentryIssue(binding, stored, alone) ?? [],
  );
  if (endpoints.length === 0) {
    return scalarIssues;
  }
  const held = getEndpointItems(stored?.overrides).filter(({ entry }) =>
    isHiddenGroupKey(entry.apiKey),
  );
  const resolved = {
    ...alone,
    storedEndpoints: getResolvedEndpoints(alone.stored),
    candidateEndpoints: getResolvedEndpoints(alone.candidate),
  };
  return [
    ...scalarIssues,
    ...endpoints.flatMap((item) => getEndpointReentryIssue(item, held, resolved) ?? []),
  ];
}
