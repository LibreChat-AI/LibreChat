import { createHash } from 'crypto';
import { EModelEndpoint, envVarRegex } from 'librechat-data-provider';
import {
  getAtPath,
  setAtPath,
  foldConfigMergeKey,
  webSearchUrlApiKeys,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  ConfigMergeStep,
  ConfigOverrideLayer,
  AdminConfigIgnoredSecret,
} from '@librechat/data-schemas';
import type { CredentialBindingConfig } from '~/mcp/registry/binding';
import {
  diffApiKeyBinding,
  getApiKeyBindingFields,
  getOAuthSecretBindingFields,
  getChangedOAuthSecretBindingFields,
} from '~/mcp/registry/binding';
import { hasUserCredentialPlaceholder } from '~/utils/oidc';
import { isUserVariableTemplate } from '~/admin/secrets';
import { isUserProvided } from '~/utils/common';

type JsonRecord = Record<string, unknown>;

/**
 * What one override layer's merge left out because it would send a credential somewhere it was not
 * entered for: a secret it dropped, or a destination it set back (for a credential the reader takes
 * from the deployment when the config holds none, which dropping cannot stop).
 */
export interface SecretRebinding {
  layer: ConfigOverrideLayer;
  kind: 'secret' | 'destination';
  /** Where the value is, in YAML keys; an `endpoints.custom` entry is named by its `name`. */
  segments: string[];
  /** The same location as text: `endpoints.custom["Name"].apiKey`, `summarization.parameters.baseURL`. */
  path: string;
  /**
   * For a secret the layer supplies, dropped because a layer below it changed where it is sent:
   * the fingerprint of the destination the merge sends it to. A write that enters the secret
   * over that destination stores it beside the secret ({@link getSecretBindingKey}), which binds
   * the secret to it.
   */
  binding?: string;
}

/**
 * A secret and the settings beside it that decide where it is sent, in one object of the resolved
 * config (whose keys match librechat.yaml for these sections).
 */
export interface SecretBinding {
  path: readonly string[];
  secretKey: string;
  bindingKeys: readonly string[];
}

/** The scalar secrets bound to settings beside them: OCR's and each speech service's key. */
export const SECRET_BINDINGS: readonly SecretBinding[] = [
  { path: ['ocr'], secretKey: 'apiKey', bindingKeys: ['baseURL'] },
  { path: ['speech', 'tts', 'openai'], secretKey: 'apiKey', bindingKeys: ['url'] },
  { path: ['speech', 'tts', 'azureOpenAI'], secretKey: 'apiKey', bindingKeys: ['instanceName'] },
  {
    path: ['speech', 'tts', 'elevenlabs'],
    secretKey: 'apiKey',
    bindingKeys: ['url', 'websocketUrl'],
  },
  { path: ['speech', 'tts', 'localai'], secretKey: 'apiKey', bindingKeys: ['url'] },
  { path: ['speech', 'stt', 'openai'], secretKey: 'apiKey', bindingKeys: ['url'] },
  { path: ['speech', 'stt', 'azureOpenAI'], secretKey: 'apiKey', bindingKeys: ['instanceName'] },
];

/**
 * The librechat.yaml sections that hold a bound credential or its destination (`mcpConfig` is the
 * alias of `mcpServers`). Writes anywhere else cannot change where a credential is sent.
 */
export const REBINDING_SECTIONS: readonly string[] = [
  'mcpServers',
  'mcpConfig',
  'endpoints',
  'ocr',
  'speech',
  'webSearch',
  'summarization',
];

/**
 * A key a layer can enter for a destination it chooses, and the client that reads both. A key is
 * bound to that client as much as to the destination: another client reads other destination
 * settings, or authenticates some other way.
 */
interface DestinationSecret {
  /** Where the key is in the destination's object. */
  key: string;
  /** The setting that picks the client which reads the destination and the key. */
  client: (config: AppConfig) => unknown;
  /** Whether that client authenticates with the key, rather than a credential it finds itself. */
  isUsed: (config: AppConfig) => boolean;
}

/**
 * A destination whose credential the reader takes from the deployment when the config holds none,
 * so dropping a secret cannot keep it home; the destination is set back instead.
 */
interface DestinationBinding {
  /** The object in the resolved config that holds the destination (and the secret, if any). */
  path: readonly string[];
  /** Whether a key of that object chooses where requests, and the credential, go. */
  isDestination: (key: string) => boolean;
  /**
   * A key a layer can enter for a destination it chooses. Without one, only the deployment's
   * credential is ever sent, so only the destination librechat.yaml chose is used.
   */
  secret?: DestinationSecret;
  /**
   * What picks the deployment credential the reader uses when the config holds no key. A
   * destination librechat.yaml chose stays only while it picks the credential librechat.yaml's does.
   */
  fallback?: (config: AppConfig) => readonly unknown[];
}

/**
 * Names of client options that choose where requests, and the credential, go. Summarization's
 * `parameters` become the summarizer's client options: LibreChat reads `baseURL`, and the
 * provider clients read their own (`anthropicApiUrl`, `azureOpenAIBasePath`,
 * `azureOpenAIEndpoint`, `azureOpenAIApiInstanceName`, Google's `baseUrl`, Vertex's `endpoint` and
 * `location`, Bedrock's `endpointHost` and `region`, Mistral's `serverURL`). A custom endpoint's
 * `addParams` reach its client the same way: the native Anthropic client (`provider: anthropic`)
 * sends to an `anthropicApiUrl` there over the endpoint's `baseURL`. The pattern errs strict, so a
 * name a client adds later is covered before anyone lists it; the options it matches that only
 * shape requests are named in {@link REQUEST_OPTIONS}.
 */
const DESTINATION_OPTION = /(?:url|endpoint|host|path|instancename|proxy|location|region)$/i;

/**
 * Client options whose names match the destination pattern but which change how requests are
 * shaped, not where they go: `firstPartyEndpoint` turns on OpenAI's first-party request rules for
 * the host the client already uses.
 */
const REQUEST_OPTIONS: ReadonlySet<string> = new Set(['firstPartyEndpoint']);

function isDestinationOption(key: string): boolean {
  return DESTINATION_OPTION.test(key) && !REQUEST_OPTIONS.has(key);
}

function getSummarizationProvider(config: AppConfig): string | undefined {
  const provider = config.summarization?.provider;
  return isKeyString(provider) ? provider : undefined;
}

/**
 * Whether the summarizer authenticates with `parameters.apiKey`. Without a provider it runs on
 * each agent's own, which may not; Bedrock never does, and signs with the AWS credentials of the
 * agent or the environment.
 */
function summarizationUsesKey(config: AppConfig): boolean {
  const provider = getSummarizationProvider(config);
  return provider != null && provider.trim().toLowerCase() !== EModelEndpoint.bedrock;
}

/**
 * The deployment credential a summarizer without a key uses: its provider's, and for an Azure
 * model (named, or summarized on an Azure agent's own provider) the key of the group it maps to.
 */
function getSummarizationFallback(config: AppConfig): readonly unknown[] {
  const provider = getSummarizationProvider(config);
  const model = config.summarization?.model;
  const azure = provider == null || provider === EModelEndpoint.azureOpenAI;
  const group =
    azure && typeof model === 'string'
      ? getAt(config.endpoints?.azureOpenAI?.modelGroupMap, [model, 'group'])
      : undefined;
  return [provider, group];
}

const DESTINATION_BINDINGS: readonly DestinationBinding[] = [
  /**
   * Without a key it authenticates with, summarization uses its provider's own credential:
   * `OPENAI_API_KEY`, the Azure group's key, a custom endpoint's key, the agent's resolved client
   * options (when it summarizes on the agent's provider) or the provider SDK's env default. Only a
   * string `parameters.apiKey` replaces it, and only for a named provider other than Bedrock.
   */
  {
    path: ['summarization', 'parameters'],
    isDestination: isDestinationOption,
    secret: { key: 'apiKey', client: getSummarizationProvider, isUsed: summarizationUsesKey },
    fallback: getSummarizationFallback,
  },
];

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function getAt(root: unknown, segments: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    const record = asRecord(cursor);
    if (record == null) {
      return undefined;
    }
    cursor = record[segment];
  }
  return cursor;
}

/** A non-empty string: the only value a reader sends as a key. */
function isKeyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** `user_provided` or a whole `{{VAR}}` template: a value each user enters for themselves. */
function isUserEntered(value: string): boolean {
  const trimmed = value.trim();
  return isUserProvided(trimmed) || isUserVariableTemplate(trimmed);
}

/** A key the deployment or an admin entered, in the form a reader sends it. */
function isEnteredKey(value: unknown): boolean {
  return isKeyString(value) && !isUserEntered(value);
}

/**
 * Whether a value is a credential the deployment or an admin supplies, which a new destination
 * must not receive: any set value except `user_provided` and a whole `{{VAR}}` template. Anything
 * that is not a string counts too, so a value no reader expects is dropped rather than kept.
 */
function isBoundSecret(value: unknown): boolean {
  if (value == null) {
    return false;
  }
  return typeof value !== 'string' || isEnteredKey(value);
}

/** A URL in canonical form (fragment dropped), so a cosmetic respelling is not a change. */
function normalizeBindingValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value;
  }
}

function bindingChanged(
  reference: JsonRecord | null,
  merged: JsonRecord,
  keys: readonly string[],
): boolean {
  return keys.some(
    (key) => normalizeBindingValue(reference?.[key]) !== normalizeBindingValue(merged[key]),
  );
}

/**
 * Which of a scalar secret's binding keys differ between two objects that hold it, compared as
 * the guard compares them (a URL in canonical form).
 */
export function getChangedScalarBindingKeys(
  binding: SecretBinding,
  reference: JsonRecord | null,
  merged: JsonRecord,
): string[] {
  return binding.bindingKeys.filter((key) => bindingChanged(reference, merged, [key]));
}

/**
 * The key beside a secret a layer supplies that holds the fingerprint of the destination a write
 * entered it for, when that destination is not the one librechat.yaml and the layer alone define
 * (`<secret>Binding`, as `<secret>Preview` holds its preview). The admin config API writes it and
 * never returns it; the merge removes it ({@link withoutSecretBindings}).
 */
export function getSecretBindingKey(secretKey: string): string {
  return `${secretKey}Binding`;
}

/**
 * A destination's fingerprint, from what decides where a secret is sent. One-way, so the key it
 * is stored beside tells nothing of where it points.
 */
function toFingerprint(signature: unknown): string {
  return createHash('sha256').update(JSON.stringify(signature)).digest('hex');
}

/** Whether the object that holds a layer's secret binds it to the destination `fingerprint` names. */
function isBoundTo(owner: unknown, secretKey: string, fingerprint: string): boolean {
  return asRecord(owner)?.[getSecretBindingKey(secretKey)] === fingerprint;
}

/**
 * A binding's locations and values in one order, by code unit rather than locale, so equal
 * bindings serialize alike on every replica. Locations are unique, so none compare equal.
 */
function toSortedEntries(binding: Iterable<[string, unknown]>): Array<[string, unknown]> {
  return [...binding].sort(([left], [right]) => (left < right ? -1 : 1));
}

function getScalarSignature(bindingKeys: readonly string[], record: JsonRecord): unknown[] {
  return bindingKeys.map((key) => normalizeBindingValue(record[key]) ?? null);
}

/** The fingerprint of where a scalar secret in `record` is sent ({@link getSecretBindingKey}). */
export function getScalarBindingFingerprint(binding: SecretBinding, record: JsonRecord): string {
  return toFingerprint(getScalarSignature(binding.bindingKeys, record));
}

/**
 * Copies `root` along `segments` (array items by index) and sets the last one to `value`, so
 * objects the merge shares with lower layers and the base config are never mutated.
 */
function setAt(root: unknown, segments: readonly (string | number)[], value: unknown): unknown {
  if (segments.length === 0) {
    return value;
  }
  const [segment, ...rest] = segments;
  if (Array.isArray(root) && typeof segment === 'number') {
    const next = [...root];
    next[segment] = setAt(root[segment], rest, value);
    return next;
  }
  const record = asRecord(root) ?? {};
  return { ...record, [segment]: setAt(record[segment], rest, value) };
}

/** An inherited secret to drop: where it is in the merged config, and how a write names it. */
interface Drop {
  at: readonly (string | number)[];
  segments: string[];
  path: string;
  /** For the layer's own secret, the fingerprint of the destination it would be sent to. */
  binding?: string;
}

/**
 * Which config a merged secret's destination must match for the secret to stay:
 * - `below`: the layer inherited the secret, so the destination it inherited with it;
 * - `alone`: the layer supplied the secret, so the destination librechat.yaml and the layer
 *   itself define, whatever another layer below it changed, or the one a write bound it to
 *   (`<secret>Binding`, {@link getSecretBindingKey});
 * - `null`: nothing to check (no secret, or a value each user supplies).
 */
type BindingReference = 'below' | 'alone' | null;

function getBindingReference(below: unknown, merged: unknown, applied: unknown): BindingReference {
  if (!isBoundSecret(merged)) {
    return null;
  }
  if (applied === undefined) {
    return merged === below ? 'below' : null;
  }
  return merged === applied ? 'alone' : null;
}

/**
 * The fingerprint of where the merge sends a secret the layer supplies, when the layer did not
 * bind the secret to it (`null` when it did): the drop reports it, so a write that enters the
 * secret over this destination can bind it there.
 */
function getUnboundFingerprint(
  owner: unknown,
  secretKey: string,
  signature: unknown,
): string | null {
  const fingerprint = toFingerprint(signature);
  return isBoundTo(owner, secretKey, fingerprint) ? null : fingerprint;
}

function findScalarDrops(step: ConfigMergeStep): Drop[] {
  return SECRET_BINDINGS.flatMap(({ path, secretKey, bindingKeys }) => {
    const merged = asRecord(getAt(step.merged, path));
    if (merged == null) {
      return [];
    }
    const below = asRecord(getAt(step.below, path));
    const applied = asRecord(getAt(step.applied, path));
    const reference = getBindingReference(
      below?.[secretKey],
      merged[secretKey],
      applied?.[secretKey],
    );
    if (reference == null) {
      return [];
    }
    const expected = reference === 'below' ? below : asRecord(getAt(step.alone(), path));
    if (!bindingChanged(expected, merged, bindingKeys)) {
      return [];
    }
    const binding =
      reference === 'alone'
        ? getUnboundFingerprint(applied, secretKey, getScalarSignature(bindingKeys, merged))
        : undefined;
    if (binding === null) {
      return [];
    }
    const segments = [...path, secretKey];
    return [{ at: segments, segments, path: segments.join('.'), binding }];
  });
}

const CUSTOM_ENDPOINTS: readonly string[] = ['endpoints', 'custom'];
const CUSTOM_ENDPOINTS_PATH = CUSTOM_ENDPOINTS.join('.');

/**
 * Options a custom endpoint's `dropParams` can remove that hold a destination: the native
 * Anthropic client sends to `anthropicApiUrl`, else to `clientOptions.baseURL`, and without both
 * to its SDK's default host.
 */
const CLIENT_OPTION_GROUPS: ReadonlySet<string> = new Set(['clientOptions', 'configuration']);

/**
 * The identity a custom endpoint merges on and is served by: its name as the merge folds it
 * (`foldConfigMergeKey`), so `Ollama` and `ollama` are one endpoint.
 */
function getEndpointIdentity(name: string): string {
  return foldConfigMergeKey(CUSTOM_ENDPOINTS_PATH, name);
}

/** A custom endpoint list's entries by identity, in list order. */
function groupByIdentity(value: unknown): Map<string, JsonRecord[]> {
  const groups = new Map<string, JsonRecord[]>();
  if (!Array.isArray(value)) {
    return groups;
  }
  for (const item of value) {
    const entry = asRecord(item);
    if (entry == null || typeof entry.name !== 'string') {
      continue;
    }
    const identity = getEndpointIdentity(entry.name);
    const group = groups.get(identity);
    if (group == null) {
      groups.set(identity, [entry]);
    } else {
      group.push(entry);
    }
  }
  return groups;
}

/** A destination option's value in the form two spellings of one destination share. */
function toBindingValue(value: unknown): unknown {
  return asRecord(value) != null || Array.isArray(value)
    ? JSON.stringify(value)
    : normalizeBindingValue(value);
}

/**
 * Each option named like a destination in `options`, at any depth (array items included), keyed
 * by its location.
 */
function collectDestinationOptions(
  options: unknown,
  segments: readonly string[],
  into: Map<string, unknown>,
): void {
  const record: JsonRecord | null = Array.isArray(options) ? { ...options } : asRecord(options);
  if (record == null) {
    return;
  }
  for (const [key, value] of Object.entries(record)) {
    const location = [...segments, key];
    if (isDestinationOption(key)) {
      into.set(JSON.stringify(location), toBindingValue(value));
    } else {
      collectDestinationOptions(value, location, into);
    }
  }
}

/**
 * The settings of a custom endpoint that decide where its `apiKey` is sent, keyed by location:
 * - `baseURL`;
 * - `provider`, which picks the client that reads the rest;
 * - each option in `addParams` named like a destination ({@link isDestinationOption}), at any
 *   depth: the native Anthropic client sends to `addParams.anthropicApiUrl` over `baseURL`;
 * - each name in `dropParams` that removes such an option or the client options holding one
 *   ({@link CLIENT_OPTION_GROUPS}).
 */
function getCustomEndpointBinding(entry: JsonRecord | null): Map<string, unknown> {
  const binding = new Map<string, unknown>([
    [JSON.stringify(['baseURL']), normalizeBindingValue(entry?.baseURL)],
    [JSON.stringify(['provider']), entry?.provider],
  ]);
  return collectClientOptionBinding(entry, binding);
}

/**
 * The destination options of an entry whose `addParams` and `dropParams` reach its client's
 * options (a custom endpoint, an Azure group), added to `binding` by location: each option in
 * `addParams` named like a destination, at any depth, and each name in `dropParams` that removes
 * such an option or the client options holding one ({@link CLIENT_OPTION_GROUPS}).
 */
function collectClientOptionBinding(
  entry: JsonRecord | null,
  binding: Map<string, unknown>,
): Map<string, unknown> {
  collectDestinationOptions(entry?.addParams, ['addParams'], binding);
  const dropped = entry?.dropParams;
  if (!Array.isArray(dropped)) {
    return binding;
  }
  for (const name of dropped) {
    if (typeof name === 'string' && (isDestinationOption(name) || CLIENT_OPTION_GROUPS.has(name))) {
      binding.set(JSON.stringify(['dropParams', name]), true);
    }
  }
  return binding;
}

/** Whether two bindings ({@link getCustomEndpointBinding}) differ in any location. */
function bindingsDiffer(expected: Map<string, unknown>, actual: Map<string, unknown>): boolean {
  if (expected.size !== actual.size) {
    return true;
  }
  for (const [location, value] of actual) {
    if (!expected.has(location) || expected.get(location) !== value) {
      return true;
    }
  }
  return false;
}

function customEndpointBindingChanged(reference: JsonRecord | null, merged: JsonRecord): boolean {
  return bindingsDiffer(getCustomEndpointBinding(reference), getCustomEndpointBinding(merged));
}

/**
 * The locations of a custom endpoint's binding ({@link getCustomEndpointBinding}) that differ
 * between two definitions of it, each as segments within the entry (`['baseURL']`,
 * `['addParams', 'anthropicApiUrl']`, `['dropParams', 'clientOptions']`), in a stable order.
 */
export function getChangedCustomEndpointBinding(
  reference: JsonRecord | null,
  merged: JsonRecord,
): string[][] {
  const expected = getCustomEndpointBinding(reference);
  const actual = getCustomEndpointBinding(merged);
  return [...new Set([...expected.keys(), ...actual.keys()])]
    .filter(
      (location) =>
        !expected.has(location) ||
        !actual.has(location) ||
        expected.get(location) !== actual.get(location),
    )
    .sort()
    .map((location) => JSON.parse(location) as string[]);
}

function getCustomEndpointSignature(entry: JsonRecord): unknown {
  return toSortedEntries(getCustomEndpointBinding(entry));
}

/** The fingerprint of where a custom endpoint sends its key ({@link getSecretBindingKey}). */
export function getCustomEndpointFingerprint(entry: JsonRecord): string {
  return toFingerprint(getCustomEndpointSignature(entry));
}

/** A merged custom endpoint and the entry below it that the merge kept it from. */
interface EndpointPair {
  index: number;
  entry: JsonRecord;
  name: string;
  identity: string;
  /** Which entry of its identity it is: the merge keeps one merged entry per entry below, in order. */
  occurrence: number;
  below: JsonRecord | null;
}

function pairCustomEndpoints(merged: readonly unknown[], below: unknown): EndpointPair[] {
  const belowGroups = groupByIdentity(below);
  const occurrences = new Map<string, number>();
  const pairs: EndpointPair[] = [];
  merged.forEach((item, index) => {
    const entry = asRecord(item);
    const name = entry?.name;
    if (entry == null || typeof name !== 'string') {
      return;
    }
    const identity = getEndpointIdentity(name);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const belowEntry = belowGroups.get(identity)?.[occurrence] ?? null;
    pairs.push({ index, entry, name, identity, occurrence, below: belowEntry });
  });
  return pairs;
}

/**
 * Custom endpoints merge by name, folded as the merge folds it; each one's `apiKey` is bound to
 * the settings {@link getCustomEndpointBinding} lists. A merged entry is judged against the
 * entry of the layer that supplied it (the last of its identity, as the merge applies them) and
 * the entry it was merged onto: the merge keeps one merged entry per entry below, in order, so
 * the n-th merged entry of an identity comes from the n-th one below. An entry the layer's
 * overrides do not name is judged too, as inherited: whatever else changed it (a tombstone, say)
 * changed it without entering its key. A drop names the entry by the spelling the merge keeps,
 * the lower layer's. The layer's own key stays where its entry binds it
 * ({@link getSecretBindingKey}).
 */
function findCustomEndpointDrops(step: ConfigMergeStep): Drop[] {
  const merged = getAt(step.merged, CUSTOM_ENDPOINTS);
  const below = getAt(step.below, CUSTOM_ENDPOINTS);
  if (!Array.isArray(merged) || merged === below) {
    return [];
  }
  const appliedGroups = groupByIdentity(getAt(step.applied, CUSTOM_ENDPOINTS));
  let aloneGroups: Map<string, JsonRecord[]> | undefined;
  const drops: Drop[] = [];
  for (const { index, entry, name, identity, occurrence, below: belowEntry } of pairCustomEndpoints(
    merged,
    below,
  )) {
    const appliedGroup = appliedGroups.get(identity);
    const appliedEntry = appliedGroup?.[appliedGroup.length - 1];
    if (appliedEntry == null && entry === belowEntry) {
      continue;
    }
    const reference = getBindingReference(belowEntry?.apiKey, entry.apiKey, appliedEntry?.apiKey);
    if (reference == null) {
      continue;
    }
    if (reference === 'alone') {
      aloneGroups ??= groupByIdentity(getAt(step.alone(), CUSTOM_ENDPOINTS));
    }
    const expected =
      reference === 'below' ? belowEntry : (aloneGroups?.get(identity)?.[occurrence] ?? null);
    if (!customEndpointBindingChanged(expected, entry)) {
      continue;
    }
    const binding =
      reference === 'alone'
        ? getUnboundFingerprint(appliedEntry, 'apiKey', getCustomEndpointSignature(entry))
        : undefined;
    if (binding === null) {
      continue;
    }
    drops.push({
      at: [...CUSTOM_ENDPOINTS, index, 'apiKey'],
      segments: [...CUSTOM_ENDPOINTS, name, 'apiKey'],
      path: `endpoints.custom[${JSON.stringify(name)}].apiKey`,
      binding,
    });
  }
  return drops;
}

/** A secret inside each entry of a record keyed by entry name, and what decides where it goes. */
interface RecordSecret {
  /** Where the secret is inside an entry. */
  segments: readonly string[];
  /** The fields that decide where the secret is sent and differ between two entries. */
  changedFields: (reference: JsonRecord, merged: JsonRecord) => string[];
  /**
   * What decides where an entry sends the secret, for a secret its own layer supplies: equal for
   * two entries that send it alike, ignoring what {@link OWN_SECRET_IGNORED_FIELDS} names.
   */
  signature: (entry: JsonRecord) => unknown;
}

/** A record of entries, keyed by name, each with its own bound secrets. */
interface RecordBinding {
  /** The record in the resolved config. */
  path: readonly string[];
  /** The record as librechat.yaml and the admin API name it. */
  reportPath: readonly string[];
  secrets: readonly RecordSecret[];
}

/** Where an Azure group's key is sent: its own base URL, or its instance's Azure host. */
const AZURE_GROUP_BINDING_KEYS = ['baseURL', 'instanceName'];

/** The Azure client's base URL template a deployment name fills (`constructAzureURL`). */
const DEPLOYMENT_NAME_TEMPLATE = '${DEPLOYMENT_NAME}';

/** Whether a base URL's host, rather than its path, is filled from a deployment name. */
function isHostFromDeployment(baseURL: unknown): boolean {
  if (typeof baseURL !== 'string') {
    return false;
  }
  const authority = baseURL.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').split(/[/?#]/, 1)[0];
  return authority.includes(DEPLOYMENT_NAME_TEMPLATE);
}

/**
 * An Azure group's destination setting as the client reads it: blank is unset (resolved groups
 * spell an unset base URL and instance as `''`).
 */
function toAzureDestination(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === ''
    ? undefined
    : normalizeBindingValue(value);
}

/** Every deployment name a group's requests are built with: the group's and each model's. */
function getDeploymentNames(group: JsonRecord): string {
  const models = asRecord(group.models) ?? {};
  return JSON.stringify([
    group.deploymentName,
    ...Object.keys(models)
      .sort()
      .map((model) => asRecord(models[model])?.deploymentName),
  ]);
}

/**
 * What decides where an Azure group sends its `apiKey` ({@link diffAzureGroupBinding}), equal for
 * two groups that send it alike.
 */
function getAzureGroupSignature(group: JsonRecord): unknown {
  return [
    ...AZURE_GROUP_BINDING_KEYS.map((key) => toAzureDestination(group[key]) ?? null),
    isHostFromDeployment(group.baseURL) ? getDeploymentNames(group) : null,
    toSortedEntries(collectClientOptionBinding(group, new Map())),
  ];
}

/**
 * The settings of a resolved Azure group (a `groupMap` entry, or a `groups` item) that differ
 * between two definitions of it and decide where its `apiKey` is sent: `baseURL`, `instanceName`
 * (the Azure host, and the `${INSTANCE_NAME}` a base URL template holds), the deployment names
 * when a base URL takes its host from `${DEPLOYMENT_NAME}`, and the destination options of its
 * `addParams` and `dropParams`, which reach the client's options as a custom endpoint's do.
 */
export function diffAzureGroupBinding(reference: JsonRecord, merged: JsonRecord): string[] {
  const changed = AZURE_GROUP_BINDING_KEYS.filter(
    (key) => toAzureDestination(reference[key]) !== toAzureDestination(merged[key]),
  );
  const deploymentPicksHost =
    isHostFromDeployment(reference.baseURL) || isHostFromDeployment(merged.baseURL);
  if (deploymentPicksHost && getDeploymentNames(reference) !== getDeploymentNames(merged)) {
    changed.push('deploymentName');
  }
  const options = (group: JsonRecord) => collectClientOptionBinding(group, new Map());
  if (bindingsDiffer(options(reference), options(merged))) {
    changed.push('addParams');
  }
  return changed;
}

/**
 * Binding fields not compared for a secret the layer supplies: a transport `type` set below it
 * changes the protocol spoken to the same URL, not the host the secret reaches, so a profile that
 * sets a key and URL for a server another layer defines need not restate its type.
 */
const OWN_SECRET_IGNORED_FIELDS = new Set(['type']);

/** A credential's binding fields without those a secret the layer supplies ignores, in one order. */
function getOwnSecretSignature(fields: Record<string, string | undefined> | null): unknown {
  if (fields == null) {
    return null;
  }
  return toSortedEntries(
    Object.entries(fields).filter(([field]) => !OWN_SECRET_IGNORED_FIELDS.has(field)),
  );
}

/** What decides where a server sends `apiKey.key` or `oauth.client_secret`, for its own layer. */
function getServerSecretSignature(parent: 'apiKey' | 'oauth', server: JsonRecord): unknown {
  const config = server as CredentialBindingConfig;
  return getOwnSecretSignature(
    parent === 'apiKey' ? getApiKeyBindingFields(config) : getOAuthSecretBindingFields(config),
  );
}

/**
 * The fingerprint of where an MCP server sends `apiKey.key` or `oauth.client_secret`
 * ({@link getSecretBindingKey}).
 */
export function getServerSecretFingerprint(parent: 'apiKey' | 'oauth', server: JsonRecord): string {
  return toFingerprint(getServerSecretSignature(parent, server));
}

/** The fingerprint of where an Azure group sends its `apiKey` ({@link getSecretBindingKey}). */
export function getAzureGroupFingerprint(group: JsonRecord): string {
  return toFingerprint(getAzureGroupSignature(group));
}

const MCP_SERVERS_REPORT_PATH: readonly string[] = ['mcpServers'];
const AZURE_GROUP_MAP_PATH: readonly string[] = ['endpoints', 'azureOpenAI', 'groupMap'];

const RECORD_BINDINGS: readonly RecordBinding[] = [
  /**
   * MCP servers merge by name. `apiKey.key` and `oauth.client_secret` are bound by the same rules
   * the user-managed tier enforces when a stored key is kept (`mcp/registry/binding.ts`).
   */
  {
    path: ['mcpConfig'],
    reportPath: MCP_SERVERS_REPORT_PATH,
    secrets: [
      {
        segments: ['apiKey', 'key'],
        changedFields: (reference, merged) =>
          diffApiKeyBinding(
            reference as CredentialBindingConfig,
            merged as CredentialBindingConfig,
          ),
        signature: (entry) => getServerSecretSignature('apiKey', entry),
      },
      {
        segments: ['oauth', 'client_secret'],
        changedFields: (reference, merged) =>
          getChangedOAuthSecretBindingFields(
            reference as CredentialBindingConfig,
            merged as CredentialBindingConfig,
          ),
        signature: (entry) => getServerSecretSignature('oauth', entry),
      },
    ],
  },
  /**
   * `groupMap` is what Azure `groups` resolve to (librechat.yaml's, or a layer's, which the merge
   * resolves the same way) and what runtime readers use; an override can also write it directly,
   * so each group's key is bound to its own destination.
   */
  {
    path: AZURE_GROUP_MAP_PATH,
    reportPath: AZURE_GROUP_MAP_PATH,
    secrets: [
      {
        segments: ['apiKey'],
        changedFields: diffAzureGroupBinding,
        signature: getAzureGroupSignature,
      },
    ],
  },
];

/** Entries the merge left untouched (the same object as below) cannot have moved. */
function findRecordDrops(step: ConfigMergeStep, binding: RecordBinding): Drop[] {
  const merged = asRecord(getAt(step.merged, binding.path));
  const below = asRecord(getAt(step.below, binding.path));
  if (merged == null || merged === below) {
    return [];
  }
  const applied = asRecord(getAt(step.applied, binding.path));
  const drops: Drop[] = [];
  for (const [name, mergedEntry] of Object.entries(merged)) {
    const entry = asRecord(mergedEntry);
    const belowEntry = below?.[name];
    if (entry == null || mergedEntry === belowEntry) {
      continue;
    }
    const appliedEntry = applied?.[name];
    for (const { segments, changedFields, signature } of binding.secrets) {
      const reference = getBindingReference(
        getAt(belowEntry, segments),
        getAt(entry, segments),
        getAt(appliedEntry, segments),
      );
      if (reference == null) {
        continue;
      }
      const expected =
        reference === 'below' ? belowEntry : getAt(step.alone(), [...binding.path, name]);
      const changed = changedFields(asRecord(expected) ?? {}, entry);
      const moved =
        reference === 'below'
          ? changed
          : changed.filter((field) => !OWN_SECRET_IGNORED_FIELDS.has(field));
      if (moved.length === 0) {
        continue;
      }
      const owner = getAt(appliedEntry, segments.slice(0, -1));
      const secretKey = segments[segments.length - 1];
      const fingerprint =
        reference === 'alone'
          ? getUnboundFingerprint(owner, secretKey, signature(entry))
          : undefined;
      if (fingerprint === null) {
        continue;
      }
      const reported = [...binding.reportPath, name, ...segments];
      drops.push({
        at: [...binding.path, name, ...segments],
        segments: reported,
        path: reported.join('.'),
        binding: fingerprint,
      });
    }
  }
  return drops;
}

/** A destination set back to the one its credential belongs with. */
interface Restore {
  path: readonly string[];
  /** The object at `path` with its destination keys set back and its secret, if dropped, removed. */
  record: JsonRecord;
  /** The destination keys that changed. */
  keys: string[];
  /** The secret removed because the client that reads it is not the one it was entered for. */
  droppedSecret?: string;
}

function isSameSelection(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The destination the deployment's own credential may keep: librechat.yaml's, while
 * librechat.yaml sends that same credential there (it sets no key its client uses, and picks the
 * same fallback); otherwise the reader's default, which holds no destination keys.
 */
function getFallbackReference(step: ConfigMergeStep, binding: DestinationBinding): JsonRecord {
  const base = asRecord(getAt(step.base, binding.path)) ?? {};
  const { secret, fallback } = binding;
  const baseKeyed = secret != null && secret.isUsed(step.base) && isKeyString(base[secret.key]);
  const sameFallback =
    fallback == null || isSameSelection(fallback(step.base), fallback(step.merged));
  return !baseKeyed && sameFallback ? base : {};
}

/** How a merged destination is judged: the object it must match, and whether its secret goes. */
interface DestinationPlan {
  reference: JsonRecord;
  dropSecret: boolean;
}

/**
 * - A key the layer entered, which its client authenticates with: the destination librechat.yaml
 *   and the layer itself define (`alone`).
 * - An inherited key: the destination it was inherited with (`below`).
 * - Either one, under another client than the one it was entered for: the key is dropped, and
 *   the destination judged as without one.
 * - A key each user enters (`user_provided`, `{{VAR}}`): nothing to judge.
 * - No key the client uses (absent, empty, not a string, or a client that ignores it): the
 *   deployment's credential is sent, so {@link getFallbackReference}.
 */
function getDestinationPlan(
  step: ConfigMergeStep,
  binding: DestinationBinding,
  merged: JsonRecord,
): DestinationPlan | null {
  const { path, secret } = binding;
  if (secret != null && secret.isUsed(step.merged)) {
    const value = merged[secret.key];
    const own = isEnteredKey(getAt(step.applied, [...path, secret.key]));
    if (own || isEnteredKey(value)) {
      const keyedWith = own ? step.alone() : step.below;
      if (secret.client(keyedWith) === secret.client(step.merged)) {
        return { reference: asRecord(getAt(keyedWith, path)) ?? {}, dropSecret: false };
      }
      return { reference: getFallbackReference(step, binding), dropSecret: true };
    }
    if (isKeyString(value)) {
      return null;
    }
  }
  return { reference: getFallbackReference(step, binding), dropSecret: false };
}

/**
 * Whether a layer left the destination object, and everything that picks the client and
 * credential reading it, as it was below.
 */
function isUntouched(step: ConfigMergeStep, binding: DestinationBinding, merged: unknown): boolean {
  if (merged !== getAt(step.below, binding.path)) {
    return false;
  }
  const { secret, fallback } = binding;
  return (
    (secret == null || secret.client(step.below) === secret.client(step.merged)) &&
    (fallback == null || isSameSelection(fallback(step.below), fallback(step.merged)))
  );
}

/**
 * Destinations a layer left somewhere their credential was not entered for. One the merge left
 * untouched cannot have moved, and one the merge removed sends nothing.
 */
function findDestinationRestores(step: ConfigMergeStep): Restore[] {
  return DESTINATION_BINDINGS.flatMap((binding) => {
    const merged = asRecord(getAt(step.merged, binding.path));
    if (merged == null || isUntouched(step, binding, merged)) {
      return [];
    }
    const plan = getDestinationPlan(step, binding, merged);
    if (plan == null) {
      return [];
    }
    const { reference, dropSecret } = plan;
    const keys = [...new Set([...Object.keys(merged), ...Object.keys(reference)])].filter(
      (key) => binding.isDestination(key) && bindingChanged(reference, merged, [key]),
    );
    const droppedSecret = dropSecret ? binding.secret?.key : undefined;
    if (keys.length === 0 && droppedSecret == null) {
      return [];
    }
    const record = { ...merged };
    if (droppedSecret != null) {
      delete record[droppedSecret];
    }
    for (const key of keys) {
      if (reference[key] === undefined) {
        delete record[key];
      } else {
        record[key] = reference[key];
      }
    }
    return [{ path: binding.path, record, keys, droppedSecret }];
  });
}

/** A web search URL a layer pointed elsewhere, and the one it is set back to. */
interface WebSearchRestore {
  url: string;
  value: unknown;
}

/** A whole `${VAR}` reference, which web search's runtime treats as the deployment's own. */
function isEnvReference(value: unknown): value is string {
  return typeof value === 'string' && envVarRegex.test(value.trim());
}

function sameReference(a: unknown, b: unknown): boolean {
  return (typeof a === 'string' ? a.trim() : a) === (typeof b === 'string' ? b.trim() : b);
}

/**
 * Web search URLs a layer points at a `${VAR}` reference other than librechat.yaml's without
 * entering the key sent there. Web search's runtime counts every `${VAR}` URL as the
 * deployment's own: it sends the deployment's key there, and when the config holds no key (an
 * unset one, or one the merge withholds, `unbindWebSearchKeys`) the search client falls back to
 * its own environment default, so dropping a key cannot keep that URL from receiving one. The URL
 * is set back to the one below instead. A literal URL is left to that runtime, which never sends
 * an environment key to a URL stored in config.
 */
function findWebSearchRestores(step: ConfigMergeStep): WebSearchRestore[] {
  const applied = asRecord(step.applied.webSearch);
  if (applied == null) {
    return [];
  }
  const merged = asRecord(step.merged.webSearch) ?? {};
  const below = asRecord(step.below.webSearch) ?? {};
  const base = asRecord(step.base.webSearch) ?? {};
  const restores: WebSearchRestore[] = [];
  for (const [url, apiKey] of webSearchUrlApiKeys) {
    if (
      applied[url] === undefined ||
      isKeyString(applied[apiKey]) ||
      !isEnvReference(merged[url]) ||
      sameReference(merged[url], below[url]) ||
      sameReference(merged[url], base[url])
    ) {
      continue;
    }
    restores.push({ url, value: below[url] });
  }
  return restores;
}

function withWebSearchRestores(config: unknown, restores: readonly WebSearchRestore[]): unknown {
  const webSearch = { ...asRecord(asRecord(config)?.webSearch) };
  for (const { url, value } of restores) {
    if (value === undefined) {
      delete webSearch[url];
    } else {
      webSearch[url] = value;
    }
  }
  return { ...asRecord(config), webSearch };
}

/** A `{{NAME}}` that is none of LibreChat's own placeholders: one of the user's custom variables. */
const CUSTOM_VARIABLE_PLACEHOLDER = /\{\{(?!LIBRECHAT_)[^{}]+\}\}/;

/**
 * Whether a value sends a credential each user holds: a `{{...}}` LibreChat fills with their
 * OpenID or Graph token, or with one of their custom variables. Identity and request placeholders
 * (`{{LIBRECHAT_USER_ID}}`, `{{LIBRECHAT_BODY_*}}`) are not credentials: whoever chooses the
 * destination receives the conversation they belong to anyway.
 */
function sendsUserCredential(value: unknown): boolean {
  if (typeof value === 'string') {
    return hasUserCredentialPlaceholder(value) || CUSTOM_VARIABLE_PLACEHOLDER.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(sendsUserCredential);
  }
  const record = asRecord(value);
  return record != null && Object.values(record).some(sendsUserCredential);
}

/** Whether an entry declares `customUserVars`, which each user fills in for themselves. */
function declaresUserVars(entry: JsonRecord): boolean {
  const customUserVars = asRecord(entry.customUserVars);
  return customUserVars != null && Object.keys(customUserVars).length > 0;
}

/**
 * Whether a custom endpoint sends a credential each user enters or holds: their own key or URL
 * (`user_provided`, which LibreChat looks up by the endpoint's name alone, wherever it points),
 * the values of its `customUserVars`, or one {@link sendsUserCredential} finds in its key or
 * headers.
 */
function endpointSendsUserValues(entry: JsonRecord): boolean {
  const { apiKey, baseURL } = entry;
  return (
    (typeof apiKey === 'string' && isUserEntered(apiKey)) ||
    (typeof baseURL === 'string' && isUserProvided(baseURL.trim())) ||
    declaresUserVars(entry) ||
    sendsUserCredential(apiKey) ||
    sendsUserCredential(entry.headers)
  );
}

/**
 * Whether an MCP server sends a credential each user enters or holds: the values of its
 * `customUserVars`, a key each user provides (`apiKey.source: user`), or one
 * {@link sendsUserCredential} finds in its URL, headers or key. LibreChat keeps those per user
 * and server name, not per destination.
 */
function serverSendsUserValues(server: JsonRecord): boolean {
  const apiKey = asRecord(server.apiKey);
  return (
    declaresUserVars(server) ||
    apiKey?.source === 'user' ||
    sendsUserCredential(apiKey?.key) ||
    sendsUserCredential(server.url) ||
    sendsUserCredential(server.headers)
  );
}

/** Copies `root` along `location` and sets `value` there, or removes the key when `undefined`. */
function restoreAt(root: unknown, location: readonly string[], value: unknown): unknown {
  const [segment, ...rest] = location;
  if (Array.isArray(root)) {
    const index = Number(segment);
    const next = [...root];
    next[index] = rest.length === 0 ? value : restoreAt(root[index], rest, value);
    return next;
  }
  const record = { ...(asRecord(root) ?? {}) };
  if (rest.length > 0) {
    record[segment] = restoreAt(record[segment], rest, value);
  } else if (value === undefined) {
    delete record[segment];
  } else {
    record[segment] = value;
  }
  return record;
}

/**
 * `entry` with the binding locations {@link getChangedCustomEndpointBinding} names set back to
 * `below`'s: its base URL, provider and destination options, and the names of `dropParams` that
 * remove a destination, keeping the rest of what the layer set.
 */
function restoreEndpointBinding(
  entry: JsonRecord,
  below: JsonRecord,
  locations: readonly string[][],
): JsonRecord {
  let restored: unknown = entry;
  const dropped = new Set<string>();
  for (const location of locations) {
    if (location[0] === 'dropParams') {
      dropped.add(location[1]);
      continue;
    }
    restored = restoreAt(restored, location, getAtPath(below, location));
  }
  if (dropped.size === 0) {
    return restored as JsonRecord;
  }
  const names = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const record = asRecord(restored) ?? {};
  const dropParams = [
    ...names(record.dropParams).filter((name) => typeof name !== 'string' || !dropped.has(name)),
    ...names(below.dropParams).filter((name) => typeof name === 'string' && dropped.has(name)),
  ];
  return { ...record, dropParams };
}

/** A destination a layer moved, set back because what it sends there is each user's own. */
interface UserValueRestore {
  segments: string[];
  path: string;
}

/**
 * Custom endpoints whose destination a layer changed while what they send there is each user's
 * own ({@link endpointSendsUserValues}), below and merged: the binding is set back to the entry
 * below's. A user's key is stored under the endpoint's name, so the layer could otherwise collect
 * every key users entered for the destination it inherited, which no one can enter again for it.
 */
function restoreUserEndpoints(step: ConfigMergeStep): {
  merged: AppConfig;
  restores: UserValueRestore[];
} {
  const merged = getAt(step.merged, CUSTOM_ENDPOINTS);
  const below = getAt(step.below, CUSTOM_ENDPOINTS);
  if (!Array.isArray(merged) || merged === below) {
    return { merged: step.merged, restores: [] };
  }
  let entries: unknown[] | undefined;
  const restores: UserValueRestore[] = [];
  for (const { index, entry, name, below: belowEntry } of pairCustomEndpoints(merged, below)) {
    if (
      belowEntry == null ||
      entry === belowEntry ||
      !endpointSendsUserValues(belowEntry) ||
      !endpointSendsUserValues(entry)
    ) {
      continue;
    }
    const locations = getChangedCustomEndpointBinding(belowEntry, entry);
    if (locations.length === 0) {
      continue;
    }
    entries ??= [...merged];
    entries[index] = restoreEndpointBinding(entry, belowEntry, locations);
    const reported = new Set(
      locations.map((location) =>
        JSON.stringify(location[0] === 'dropParams' ? ['dropParams'] : location),
      ),
    );
    for (const location of reported) {
      const fields = JSON.parse(location) as string[];
      restores.push({
        segments: [...CUSTOM_ENDPOINTS, name, ...fields],
        path: `endpoints.custom[${JSON.stringify(name)}].${fields.join('.')}`,
      });
    }
  }
  if (entries == null) {
    return { merged: step.merged, restores };
  }
  return { merged: setAt(step.merged, CUSTOM_ENDPOINTS, entries) as AppConfig, restores };
}

/** The settings of an MCP server that decide where it connects, set back together. */
const SERVER_DESTINATION_KEYS = ['url', 'type', 'proxy'] as const;

/** Whether a server connects somewhere else: another URL or proxy (a fragment aside). */
function serverMoved(below: JsonRecord, merged: JsonRecord): boolean {
  return bindingChanged(below, merged, ['url', 'proxy']);
}

/**
 * MCP servers a layer points elsewhere while what they send is each user's own
 * ({@link serverSendsUserValues}), below and merged: the server's URL, transport and proxy are
 * set back to the ones below.
 */
function restoreUserServers(
  step: ConfigMergeStep,
  config: AppConfig,
): { merged: AppConfig; restores: UserValueRestore[] } {
  const merged = asRecord(getAt(config, ['mcpConfig']));
  const below = asRecord(getAt(step.below, ['mcpConfig']));
  if (merged == null || below == null || merged === below) {
    return { merged: config, restores: [] };
  }
  let result: unknown = config;
  const restores: UserValueRestore[] = [];
  for (const [name, value] of Object.entries(merged)) {
    const server = asRecord(value);
    const belowServer = asRecord(below[name]);
    if (
      server == null ||
      belowServer == null ||
      server === belowServer ||
      !serverSendsUserValues(belowServer) ||
      !serverSendsUserValues(server) ||
      !serverMoved(belowServer, server)
    ) {
      continue;
    }
    const keys = SERVER_DESTINATION_KEYS.filter((key) => server[key] !== belowServer[key]);
    let restored: unknown = server;
    for (const key of keys) {
      restored = restoreAt(restored, [key], belowServer[key]);
    }
    result = setAt(result, ['mcpConfig', name], restored);
    for (const key of keys) {
      const segments = [...MCP_SERVERS_REPORT_PATH, name, key];
      restores.push({ segments, path: segments.join('.') });
    }
  }
  return { merged: result as AppConfig, restores };
}

/** Where a bound secret sits in a config or override document. */
export interface BoundSecretLocation {
  /** The object that holds the secret and its {@link getSecretBindingKey} companion; array items by index. */
  owner: string[];
  /** The secret's key in it. */
  key: string;
  /** The secret's identity, as {@link getRebindingIdentity} names a rebinding of it. */
  identity: string;
}

const AZURE_GROUPS_PATH: readonly string[] = ['endpoints', 'azureOpenAI', 'groups'];
const MCP_SECRET_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['apiKey', 'key'],
  ['oauth', 'client_secret'],
];

/**
 * A secret's identity by its YAML location (`SecretRebinding.segments`): a custom endpoint is
 * named by its name as the merge folds it, so every spelling of one endpoint has one identity.
 */
export function getRebindingIdentity(segments: readonly string[]): string {
  const [section, field, name, ...rest] = segments;
  if (section === CUSTOM_ENDPOINTS[0] && field === CUSTOM_ENDPOINTS[1] && name != null) {
    return JSON.stringify([section, field, getEndpointIdentity(name), ...rest]);
  }
  return JSON.stringify(segments);
}

/** The entry a YAML location is in: a custom endpoint by its folded name, an MCP server by name. */
function getEntryKey(segments: readonly string[]): string {
  const [section, field, name] = segments;
  if (section === CUSTOM_ENDPOINTS[0] && field === CUSTOM_ENDPOINTS[1] && name != null) {
    return JSON.stringify([section, field, getEndpointIdentity(name)]);
  }
  return JSON.stringify(segments.slice(0, 2));
}

function collectBoundSecretLocations(
  root: unknown,
  mcpSections: readonly string[],
): BoundSecretLocation[] {
  const locations: BoundSecretLocation[] = [];
  const add = (owner: string[], key: string, reported: readonly string[]) =>
    locations.push({ owner, key, identity: getRebindingIdentity(reported) });
  for (const { path, secretKey } of SECRET_BINDINGS) {
    if (asRecord(getAt(root, path)) != null) {
      add([...path], secretKey, [...path, secretKey]);
    }
  }
  const endpoints = getAt(root, CUSTOM_ENDPOINTS);
  (Array.isArray(endpoints) ? endpoints : []).forEach((item, index) => {
    const name = asRecord(item)?.name;
    if (typeof name === 'string') {
      add([...CUSTOM_ENDPOINTS, String(index)], 'apiKey', [...CUSTOM_ENDPOINTS, name, 'apiKey']);
    }
  });
  /**
   * A group's key is served, and its rebinding reported, from the `groupMap` entry the group
   * resolves to, so an item is named by that entry; one without a `group` name by its position.
   */
  const groups = getAt(root, AZURE_GROUPS_PATH);
  (Array.isArray(groups) ? groups : []).forEach((item, index) => {
    const record = asRecord(item);
    if (record == null) {
      return;
    }
    const reported =
      typeof record.group === 'string'
        ? [...AZURE_GROUP_MAP_PATH, record.group, 'apiKey']
        : [...AZURE_GROUPS_PATH, String(index), 'apiKey'];
    add([...AZURE_GROUPS_PATH, String(index)], 'apiKey', reported);
  });
  for (const [group, value] of Object.entries(asRecord(getAt(root, AZURE_GROUP_MAP_PATH)) ?? {})) {
    if (asRecord(value) != null) {
      add([...AZURE_GROUP_MAP_PATH, group], 'apiKey', [...AZURE_GROUP_MAP_PATH, group, 'apiKey']);
    }
  }
  for (const section of mcpSections) {
    for (const [name, server] of Object.entries(asRecord(getAt(root, [section])) ?? {})) {
      for (const [parent, key] of MCP_SECRET_KEYS) {
        if (asRecord(asRecord(server)?.[parent]) != null) {
          add([section, name, parent], key, [...MCP_SERVERS_REPORT_PATH, name, parent, key]);
        }
      }
    }
  }
  return locations;
}

/**
 * Every place an override document can hold a secret bound to a destination, and so a
 * {@link getSecretBindingKey} companion: OCR's and each speech service's key, each custom
 * endpoint's and Azure group's (`groups` and `groupMap`), and each MCP server's credentials
 * under `mcpServers` and its alias `mcpConfig`.
 */
export function getBoundSecretLocations(overrides: unknown): BoundSecretLocation[] {
  return collectBoundSecretLocations(overrides, ['mcpServers', 'mcpConfig']);
}

/** `root` without the companions at `locations`; objects are copied only where one is removed. */
function withoutBindingsAt<T>(root: T, locations: readonly BoundSecretLocation[]): T {
  let result: unknown = root;
  for (const { owner, key } of locations) {
    const companion = getSecretBindingKey(key);
    const record = asRecord(getAtPath(result, owner));
    if (record == null || !Object.prototype.hasOwnProperty.call(record, companion)) {
      continue;
    }
    const { [companion]: _removed, ...rest } = record;
    result = setAtPath(result as JsonRecord, owner, rest);
  }
  return result as T;
}

/**
 * A merged config without the destination fingerprints layers store beside their secrets
 * ({@link getSecretBindingKey}): the guard reads them from each layer's own overrides, and no
 * runtime reader expects them.
 */
export function withoutSecretBindings(config: AppConfig): AppConfig {
  return withoutBindingsAt(config, collectBoundSecretLocations(config, ['mcpConfig']));
}

/** An override document's overrides without its destination fingerprints, as reads return them. */
export function withoutStoredSecretBindings<T>(overrides: T): T {
  return withoutBindingsAt(overrides, getBoundSecretLocations(overrides));
}

/**
 * The merge's `afterLayer` policy for credentials bound to a destination. A credential stays
 * only where it was entered:
 * - a layer that changes where an entry sends a secret it inherits (from librechat.yaml or a
 *   lower layer), without supplying the secret again, drops it;
 * - a secret a layer supplies is bound to the destination librechat.yaml and that layer define;
 *   when another layer below it changed that destination, the layer's secret is dropped;
 * - where a reader falls back to a deployment credential when the config holds no key it uses
 *   (summarization), the destination is set back instead: it may differ from
 *   librechat.yaml's only together with a key the layer enters and the reader authenticates
 *   with, and stays librechat.yaml's only while it receives the credential librechat.yaml sends
 *   there. A key that another client would read than the one it was entered for is removed.
 *
 * Those are all the places a destination in the config meets a credential, apart from web
 * search: MCP servers (URL, transport, proxy, auth header, OAuth endpoints), custom endpoints
 * (base URL, `provider`, and the destination options of `addParams` and `dropParams`, matched by
 * the name the merge folds), OCR, speech, summarization parameters, the resolved Azure groups
 * (`groupMap`, which a layer's `groups` resolve to, or which it writes directly). Vertex AI,
 * which sends the deployment's service account, is not among them: the merge derives its
 * `vertexConfig` from a layer's `vertex` on librechat.yaml's region and key file (base-only), and
 * never applies a layer's own `vertexConfig`, so no layer moves where that credential goes. Web
 * search keys follow the merge's own rule (`unbindWebSearchKeys`, which keeps a key over an
 * inherited `${VAR}` or default URL), and its drops are reported like these
 * (`mergeOverrideLayers`); a web search URL a layer points at another `${VAR}` without entering
 * its key is set back ({@link findWebSearchRestores}). The built-in endpoints, assistants and the memory agent take their
 * URLs from the environment, and Langfuse only reaches destinations the deployment configures.
 * Header maps are not covered: their values are not registered secrets.
 *
 * A secret a layer supplies whose destination a layer below defines is kept when the layer's
 * own object binds it to exactly the destination the merge sends it to: the admin config API
 * stores that fingerprint beside a key it encrypts (`<secret>Binding`, {@link
 * getSecretBindingKey}) when the destination over the active Base is not the layer's own, which
 * the drop reports (`SecretRebinding.binding`). A later move below drops the key again.
 *
 * A dropped bound secret is set to `''`, which those readers treat as missing. `user_provided`
 * and `{{VAR}}` name a value each user enters and are never dropped. LibreChat keeps those values
 * per user and entry name, not per destination, so an inherited custom endpoint or MCP server that
 * sends them ({@link restoreUserEndpoints}, {@link restoreUserServers}) keeps the destination it
 * inherited: a layer that moves it has the move set back. Each change is reported to
 * `onRebinding`.
 *
 * A secret a layer writes counts as entered by it, whatever it is. That includes a `${VAR}`
 * reference, which config reads return as written: restating the reference librechat.yaml or a
 * lower layer uses, beside a destination of the layer's own, sends that variable there. Which
 * names a layer may reference is the env allowlist's to decide (`allowlist.ts`), so this guard
 * binds encrypted admin-entered secrets and literals, and stops a layer from moving a reference
 * it does not restate.
 */
export function createSecretRebindingGuard(
  onRebinding?: (rebinding: SecretRebinding) => void,
): (step: ConfigMergeStep) => AppConfig {
  return (layerStep) => {
    const endpoints = restoreUserEndpoints(layerStep);
    const servers = restoreUserServers(layerStep, endpoints.merged);
    const step =
      servers.merged === layerStep.merged ? layerStep : { ...layerStep, merged: servers.merged };
    const userRestores = [...endpoints.restores, ...servers.restores];
    for (const { segments, path } of userRestores) {
      onRebinding?.({ layer: step.layer, kind: 'destination', segments, path });
    }
    /** A key is never bound to a destination the guard put back over the layer's own. */
    const restoredEntries = new Set(userRestores.map(({ segments }) => getEntryKey(segments)));
    const drops = [
      ...findScalarDrops(step),
      ...findCustomEndpointDrops(step),
      ...RECORD_BINDINGS.flatMap((binding) => findRecordDrops(step, binding)),
    ];
    const restores = findDestinationRestores(step);
    const webSearchRestores = findWebSearchRestores(step);
    let result: unknown = step.merged;
    for (const { at, segments, path, binding } of drops) {
      result = setAt(result, at, '');
      onRebinding?.({
        layer: step.layer,
        kind: 'secret',
        segments,
        path,
        ...(binding != null && !restoredEntries.has(getEntryKey(segments)) && { binding }),
      });
    }
    if (webSearchRestores.length > 0) {
      result = withWebSearchRestores(result, webSearchRestores);
      for (const { url } of webSearchRestores) {
        const segments = ['webSearch', url];
        onRebinding?.({
          layer: step.layer,
          kind: 'destination',
          segments,
          path: segments.join('.'),
        });
      }
    }
    for (const { path, record, keys, droppedSecret } of restores) {
      result = setAt(result, path, record);
      const changes = [
        ...(droppedSecret != null ? [{ kind: 'secret' as const, key: droppedSecret }] : []),
        ...keys.map((key) => ({ kind: 'destination' as const, key })),
      ];
      for (const { kind, key } of changes) {
        const segments = [...path, key];
        onRebinding?.({ layer: step.layer, kind, segments, path: segments.join('.') });
      }
    }
    return result as AppConfig;
  };
}

/** How a write reports a rebinding its own layer causes. */
export function toIgnoredSecretOverride(rebinding: SecretRebinding): AdminConfigIgnoredSecret {
  return { path: rebinding.path, segments: rebinding.segments, reason: 'secret_rebinding' };
}
