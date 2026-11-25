import {
  EModelEndpoint,
  AgentCapabilities,
  BASE_ONLY_CONFIG_PATHS,
  normalizeEndpointName,
  materializeModelSpecEndpoints,
} from 'librechat-data-provider';
import type {
  TEndpoint,
  TCustomConfig,
  TAgentsEndpoint,
  TVertexAISchema,
  TVertexAIConfig,
} from 'librechat-data-provider';
import type { AppConfig } from '~/types';
import { readConfigEntryTombstone, getConfigTombstoneSegments } from './collections';
import { azureAssistantsDefaults, assistantsConfigSetup } from './assistants';
import { getAtPath, isPlainRecord, isSegmentPrefix } from './paths';
import { resolveServedAzureGroups } from './azure';
import { validateVertexConfig } from './vertex';
import { agentsConfigSetup } from './agents';
import { isMemoryEnabled } from './memory';
import logger from '~/config/winston';

type JsonRecord = Record<string, unknown>;

/**
 * What AppService derives from parts of librechat.yaml at startup, which the merge derives again
 * for the parts config overrides change, and which writes are checked against.
 */
export interface ConfigDerivation {
  /**
   * Expands a custom endpoint's `customParams` as startup does (each parameter definition
   * completed from the defaults of `defaultParamsEndpoint`, OpenRouter's defaults added) and
   * returns the expanded copy; throws when the definitions are invalid. Without it, custom
   * endpoints are served as merged and their parameter definitions are not checked.
   */
  expandCustomEndpoint?: (endpoint: TEndpoint) => TEndpoint;
  /**
   * Whether the merge derives the Azure endpoint (the `groupMap`, model lists and assistant
   * models a layer's `groups` resolve to), Vertex AI (`endpoints.anthropic.vertexConfig` and the
   * models it serves) and the Azure Assistants endpoint again from what the layers write
   * (`CONFIG_REDERIVE_ENDPOINTS`). Without it, those overrides stay inert. Writes are checked
   * either way.
   */
  rederiveEndpoints?: boolean;
  /**
   * Whether librechat.yaml configures Vertex AI (`endpoints.anthropic.vertex`, on or off;
   * {@link isVertexConfigured}). An override may turn Vertex AI on only where it does: the setup
   * runs on librechat.yaml's key file and region, and without them on the deployment's default
   * Google credentials. `false` makes an override that turns it on an `invalid_vertex_config`;
   * unset, that is not checked. The merge sets it from librechat.yaml itself.
   */
  vertexConfigured?: boolean;
}

/** Why a write leaves a derived part of the config unable to load. */
export type DerivedConfigIssueCode =
  | 'invalid_azure_groups'
  | 'invalid_vertex_config'
  | 'invalid_param_definitions'
  | 'unknown_spec_endpoint';

/** A derived check that fails, at its place in the merged librechat.yaml-shaped config. */
export interface DerivedConfigIssue {
  code: DerivedConfigIssueCode;
  path: string[];
}

/**
 * Derived issues only writes report: the merge does not strip the value they sit on. A model spec
 * whose endpoint is unknown is refused on write; at merge only that spec is left out
 * ({@link deriveServedSpecs}), not the layer's whole list.
 */
export const WRITE_ONLY_DERIVED_ISSUES: ReadonlySet<string> = new Set(['unknown_spec_endpoint']);

const ENDPOINTS = 'endpoints';
const AZURE_GROUPS = [ENDPOINTS, EModelEndpoint.azureOpenAI, 'groups'];
const ANTHROPIC = [ENDPOINTS, EModelEndpoint.anthropic];
const VERTEX = [...ANTHROPIC, 'vertex'];
const CUSTOM_ENDPOINTS = [ENDPOINTS, EModelEndpoint.custom];
const SPEC_LIST = ['modelSpecs', 'list'];

function asRecord(value: unknown): JsonRecord | undefined {
  return isPlainRecord(value) ? value : undefined;
}

function getEndpointIdentity(name: unknown): string | undefined {
  return typeof name === 'string' && name !== '' ? normalizeEndpointName(name) : undefined;
}

/** The custom endpoint identities a list names (as the merge folds them, `ollama` is `Ollama`). */
function getEndpointIdentities(items: unknown): Set<string> {
  const identities = new Set<string>();
  for (const item of Array.isArray(items) ? items : []) {
    const identity = getEndpointIdentity(asRecord(item)?.name);
    if (identity != null) {
      identities.add(identity);
    }
  }
  return identities;
}

/** The `group` names an Azure `groups` list holds. */
export function getGroupNames(groups: unknown): Set<string> {
  const names = new Set<string>();
  for (const item of Array.isArray(groups) ? groups : []) {
    const name = asRecord(item)?.group;
    if (typeof name === 'string') {
      names.add(name);
    }
  }
  return names;
}

/** Whether an override sets the value at `segments`. */
function sets(overrides: JsonRecord, segments: readonly string[]): boolean {
  return getAtPath(overrides, segments) !== undefined;
}

/** Whether a librechat.yaml-shaped config configures Vertex AI, on or off. */
export function isVertexConfigured(yaml: unknown): boolean {
  return asRecord(getAtPath(yaml, VERTEX)) != null;
}

function isUsableVertex(vertex: unknown): boolean {
  try {
    return validateVertexConfig(vertex as TVertexAISchema)?.isValid === true;
  } catch {
    return false;
  }
}

/** Whether a model spec's endpoint is one the runtime serves (`processModelSpecs`'s rule). */
function isKnownSpecEndpoint(endpoint: string, customEndpoints: ReadonlySet<string>): boolean {
  if (endpoint === EModelEndpoint.custom) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(EModelEndpoint, endpoint) ||
    customEndpoints.has(normalizeEndpointName(endpoint))
  );
}

/**
 * What a write breaks in the parts AppService derives from librechat.yaml, judged on `merged`
 * (the overrides over the config they land on): Azure `groups` that do not resolve once merged by
 * `group`, or whose written groups name an environment variable that is not set
 * (`invalid_azure_groups`); a Vertex AI setup that does not load, or that turns Vertex AI on
 * where librechat.yaml configures none (`vertexConfigured: false`; `invalid_vertex_config`);
 * custom endpoint parameter definitions startup would refuse (`invalid_param_definitions`, when
 * `expandCustomEndpoint` is given); and model specs naming an endpoint that is not configured
 * (`unknown_spec_endpoint`). Each family is checked only when the overrides write it. All but
 * Azure groups also need their section to pass its schema (`validSections`), so a schema issue is
 * not reported twice; groups are always checked, since groups a merge cannot resolve stay unread.
 * Issues come back in `merged`'s terms, for the caller to attribute.
 */
export function getDerivedConfigIssues(
  overrides: JsonRecord,
  merged: JsonRecord,
  validSections: ReadonlySet<string>,
  derivation: ConfigDerivation = {},
): DerivedConfigIssue[] {
  const issues: DerivedConfigIssue[] = [];
  const groups = getAtPath(overrides, AZURE_GROUPS);
  if (
    groups !== undefined &&
    !resolveServedAzureGroups(getAtPath(merged, AZURE_GROUPS), getGroupNames(groups)).isValid
  ) {
    issues.push({ code: 'invalid_azure_groups', path: AZURE_GROUPS });
  }
  if (validSections.has(ENDPOINTS)) {
    const vertex = asRecord(getAtPath(merged, VERTEX));
    if (
      sets(overrides, VERTEX) &&
      vertex != null &&
      vertex.enabled !== false &&
      (derivation.vertexConfigured === false || !isUsableVertex(vertex))
    ) {
      issues.push({ code: 'invalid_vertex_config', path: VERTEX });
    }
    issues.push(...getParamDefinitionIssues(overrides, merged, derivation));
  }
  if (validSections.has('modelSpecs') && Array.isArray(getAtPath(overrides, SPEC_LIST))) {
    issues.push(...getSpecEndpointIssues(merged));
  }
  return issues;
}

function getParamDefinitionIssues(
  overrides: JsonRecord,
  merged: JsonRecord,
  { expandCustomEndpoint }: ConfigDerivation,
): DerivedConfigIssue[] {
  const written = getEndpointIdentities(getAtPath(overrides, CUSTOM_ENDPOINTS));
  const entries = getAtPath(merged, CUSTOM_ENDPOINTS);
  if (expandCustomEndpoint == null || written.size === 0 || !Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry: unknown, index): DerivedConfigIssue[] => {
    const record = asRecord(entry);
    const identity = getEndpointIdentity(record?.name);
    if (record == null || identity == null || !written.has(identity)) {
      return [];
    }
    try {
      expandCustomEndpoint(record as TEndpoint);
      return [];
    } catch {
      return [
        {
          code: 'invalid_param_definitions',
          path: [...CUSTOM_ENDPOINTS, String(index), 'customParams'],
        },
      ];
    }
  });
}

function getSpecEndpointIssues(merged: JsonRecord): DerivedConfigIssue[] {
  const modelSpecs = materializeModelSpecEndpoints(
    asRecord(merged.modelSpecs) as TCustomConfig['modelSpecs'],
  );
  const customEndpoints = getEndpointIdentities(getAtPath(merged, CUSTOM_ENDPOINTS));
  return (modelSpecs?.list ?? []).flatMap((spec, index): DerivedConfigIssue[] => {
    const endpoint: unknown = asRecord(asRecord(spec)?.preset)?.endpoint;
    if (typeof endpoint !== 'string' || isKnownSpecEndpoint(endpoint, customEndpoints)) {
      return [];
    }
    return [
      { code: 'unknown_spec_endpoint', path: [...SPEC_LIST, String(index), 'preset', 'endpoint'] },
    ];
  });
}

/**
 * The paths layers wrote or removed, for the post-merge derivation: each written section's keys
 * one or two levels down (`endpoints.azureOpenAI`, `endpoints.anthropic.vertex`), each tombstone,
 * and the custom endpoints written, by identity.
 */
export interface ConfigTouches {
  paths: string[][];
  customEndpoints: Set<string>;
}

export function createConfigTouches(): ConfigTouches {
  return { paths: [], customEndpoints: new Set() };
}

/**
 * Records what one layer wrote (`applied`, librechat.yaml keys) and the tombstones it applied: a
 * keyed tombstone (`endpoints.custom["Name"]…`) by its array, with the custom endpoint it names.
 */
export function recordConfigTouches(
  touches: ConfigTouches,
  applied: JsonRecord,
  tombstones: readonly string[],
): void {
  for (const tombstone of tombstones) {
    touches.paths.push([...getConfigTombstoneSegments(tombstone)]);
    const entry = readConfigEntryTombstone(tombstone);
    if (entry != null && isSegmentPrefix(CUSTOM_ENDPOINTS, entry.segments)) {
      touches.customEndpoints.add(entry.identity);
    }
  }
  for (const [section, value] of Object.entries(applied)) {
    const fields = asRecord(value);
    if (fields == null || Object.keys(fields).length === 0) {
      touches.paths.push([section]);
      continue;
    }
    for (const [field, child] of Object.entries(fields)) {
      const children = asRecord(child);
      if (children == null || Object.keys(children).length === 0) {
        touches.paths.push([section, field]);
        continue;
      }
      for (const key of Object.keys(children)) {
        touches.paths.push([section, field, key]);
      }
    }
  }
  for (const identity of getEndpointIdentities(getAtPath(applied, CUSTOM_ENDPOINTS))) {
    touches.customEndpoints.add(identity);
  }
}

/** Whether any recorded path is `prefix`, lies below it or contains it. */
export function touchesConfig(touches: ConfigTouches, prefix: readonly string[]): boolean {
  return touches.paths.some(
    (path) => isSegmentPrefix(prefix, path) || isSegmentPrefix(path, prefix),
  );
}

/**
 * `raw` with librechat.yaml's value at every base-only path (`BASE_ONLY_CONFIG_PATHS`) whose
 * parent object `raw` holds.
 */
export function withBaseOnlyValues<T extends JsonRecord>(raw: T, baseYaml: JsonRecord): T {
  let result: JsonRecord = raw;
  for (const path of BASE_ONLY_CONFIG_PATHS) {
    const segments = path.split('.');
    const value = getAtPath(baseYaml, segments);
    if (getAtPath(result, segments) === value) {
      continue;
    }
    result = replaceAt(result, segments, value);
  }
  return result as T;
}

/**
 * Copies objects along `segments` and sets the last one (or removes it, for `undefined`). Only an
 * object that is there is changed: a missing parent (a section a layer removed) stays missing.
 */
function replaceAt(root: JsonRecord, segments: readonly string[], value: unknown): JsonRecord {
  const [segment, ...rest] = segments;
  const next: JsonRecord = { ...root };
  if (rest.length === 0) {
    if (value === undefined) {
      delete next[segment];
    } else {
      next[segment] = value;
    }
    return next;
  }
  const child = next[segment];
  if (!isPlainRecord(child)) {
    return root;
  }
  next[segment] = replaceAt(child, rest, value);
  return next;
}

/** `merged` with one endpoint of `endpoints` set (or removed, for `undefined`), copied on the way. */
function setEndpoint<T extends { endpoints?: unknown }>(
  merged: T,
  endpoint: string,
  value: unknown,
): T {
  const next: JsonRecord = { ...asRecord(merged.endpoints) };
  if (value === undefined) {
    delete next[endpoint];
  } else {
    next[endpoint] = value;
  }
  return { ...merged, endpoints: next };
}

/**
 * The Anthropic endpoint with Vertex AI derived again from `raw` (the librechat.yaml-shaped
 * config up to this layer), as `loadEndpoints` derives it at startup: `vertexConfig` from
 * `endpoints.anthropic.vertex`, with librechat.yaml's base-only values (key file, region), and
 * the models it serves. `enabled: false`, or no `vertex` left, removes `vertexConfig` and serves
 * the `endpoints.anthropic.models` the YAML-shaped config holds (none: the provider's defaults).
 * Models a layer set, where no later layer removed them (`modelsOverridden`), stay as merged.
 * Where librechat.yaml configures no Vertex AI ({@link isVertexConfigured}) nothing is derived,
 * so no layer turns it on with the deployment's default Google credentials. A setup that does not
 * load is off too, with a warning naming `principal`: a write that would leave it so is left out
 * of the merge before it lands (`stripInvalidOverrides`), so only a tombstone of one of its
 * settings does, and what the layers leave decides, never a `vertexConfig` derived below it.
 */
export function deriveVertexEndpoint<T extends JsonRecord>(params: {
  merged: T;
  raw: JsonRecord;
  baseYaml: JsonRecord;
  modelsOverridden: boolean;
  principal: string;
}): T {
  const { merged, baseYaml, modelsOverridden, principal } = params;
  const anthropic = asRecord(getAtPath(merged, ANTHROPIC));
  if (anthropic == null || !isVertexConfigured(baseYaml)) {
    return merged;
  }
  const raw = withBaseOnlyValues(params.raw, baseYaml);
  const vertex = asRecord(getAtPath(raw, VERTEX));
  let vertexConfig: TVertexAIConfig | null = null;
  if (vertex != null && vertex.enabled !== false) {
    vertexConfig = isUsableVertex(vertex) ? validateVertexConfig(vertex as TVertexAISchema) : null;
    if (vertexConfig == null) {
      logger.warn(
        `[mergeConfigOverrides] Turning Vertex AI off for ${principal}: endpoints.anthropic.vertex does not load once its tombstones apply`,
      );
    }
  }
  const next: JsonRecord = { ...anthropic };
  if (vertexConfig == null) {
    delete next.vertexConfig;
  } else {
    next.vertexConfig = vertexConfig;
  }
  if (!modelsOverridden) {
    const models = vertexConfig?.modelNames ?? getAtPath(raw, [...ANTHROPIC, 'models']);
    if (models === undefined) {
      delete next.models;
    } else {
      next.models = models;
    }
  }
  return setEndpoint(merged, EModelEndpoint.anthropic, next);
}

/**
 * Each custom endpoint a layer wrote, with `customParams` expanded again from the
 * librechat.yaml-shaped entry the layers merged to, as startup expands librechat.yaml's: a
 * layer's compact definitions get their defaults, a `defaultParamsEndpoint` a layer changes picks
 * the defaults of the new endpoint, and an endpoint only a layer defines gets OpenRouter's
 * defaults by its name or URL. The served entry's other fields (its name, base URL, key) stay as
 * merged. Definitions that do not expand keep librechat.yaml's expanded ones (none for an endpoint
 * librechat.yaml does not define), with a warning.
 */
function expandWrittenEndpoints(
  merged: AppConfig,
  raw: JsonRecord,
  base: AppConfig,
  touches: ConfigTouches,
  expandCustomEndpoint: NonNullable<ConfigDerivation['expandCustomEndpoint']>,
): AppConfig {
  const entries = merged.endpoints?.custom;
  if (touches.customEndpoints.size === 0 || !Array.isArray(entries)) {
    return merged;
  }
  const byIdentity = (items: unknown): Map<string, JsonRecord> => {
    const found = new Map<string, JsonRecord>();
    for (const item of Array.isArray(items) ? items : []) {
      const record = asRecord(item);
      const identity = getEndpointIdentity(record?.name);
      if (record != null && identity != null) {
        found.set(identity, record);
      }
    }
    return found;
  };
  const rawEntries = byIdentity(getAtPath(raw, CUSTOM_ENDPOINTS));
  let baseEntries: Map<string, JsonRecord> | undefined;
  let changed = false;
  const next = entries.map((entry) => {
    const identity = getEndpointIdentity(entry?.name);
    if (identity == null || !touches.customEndpoints.has(identity)) {
      return entry;
    }
    const { customParams: _served, ...served } = entry;
    const compact = rawEntries.get(identity)?.customParams;
    let customParams: unknown;
    try {
      customParams = expandCustomEndpoint({
        ...served,
        ...(compact !== undefined && { customParams: compact }),
      } as TEndpoint).customParams;
    } catch {
      logger.warn(
        `[mergeConfigOverrides] Keeping librechat.yaml's customParams for endpoint "${entry.name}": the merged parameter definitions do not load`,
      );
      baseEntries ??= byIdentity(base.endpoints?.custom);
      customParams = baseEntries.get(identity)?.customParams;
    }
    changed = true;
    return (customParams === undefined ? served : { ...served, customParams }) as typeof entry;
  });
  if (!changed) {
    return merged;
  }
  return { ...merged, endpoints: { ...merged.endpoints, custom: next } };
}

/**
 * The agents endpoint's capabilities derived again, as startup derives them, when a layer wrote
 * or removed `memory` or the agents endpoint: from the YAML-shaped `endpoints.agents` (schema
 * defaults without one), without `memory` while the merged memory config is off, so a profile
 * that turns memory on gets the capability and one that turns it off loses the inert toggle.
 * Startup always serves an agents endpoint, so where a tombstone of it (or of `endpoints`) left
 * none, it is the one startup derives from what the layers leave, as a tombstone of its
 * `capabilities` serves the default capabilities.
 */
function deriveAgentCapabilities(merged: AppConfig, raw: JsonRecord): AppConfig {
  let derived: Partial<TAgentsEndpoint>;
  try {
    derived = agentsConfigSetup(raw as Partial<TCustomConfig>);
  } catch {
    return merged;
  }
  const { capabilities } = derived;
  if (!Array.isArray(capabilities)) {
    return merged;
  }
  const agents = merged.endpoints?.[EModelEndpoint.agents] ?? derived;
  const served = isMemoryEnabled(merged.memory)
    ? capabilities
    : capabilities.filter((capability) => capability !== AgentCapabilities.memory);
  return setEndpoint(merged, EModelEndpoint.agents, { ...agents, capabilities: served });
}

/**
 * The Azure Assistants endpoint derived again, as `loadEndpoints` derives it: its defaults while
 * the merged Azure endpoint turns `assistants` on, the YAML-shaped `endpoints.azureAssistants`
 * over them, and nothing when neither is left. One that does not parse stays as merged.
 */
function deriveAzureAssistants(merged: AppConfig, raw: JsonRecord, principals: string): AppConfig {
  const assistantsOn = Boolean(merged.endpoints?.[EModelEndpoint.azureOpenAI]?.assistants);
  let next: JsonRecord | undefined = assistantsOn ? azureAssistantsDefaults() : undefined;
  if (getAtPath(raw, [ENDPOINTS, EModelEndpoint.azureAssistants]) !== undefined) {
    try {
      next = assistantsConfigSetup(
        raw as Partial<TCustomConfig>,
        EModelEndpoint.azureAssistants,
        next,
      ) as JsonRecord;
    } catch {
      logger.warn(
        `[mergeConfigOverrides] Keeping endpoints.azureAssistants as merged for ${principals}: it does not parse`,
      );
      return merged;
    }
  }
  if (next === undefined && merged.endpoints?.[EModelEndpoint.azureAssistants] === undefined) {
    return merged;
  }
  return setEndpoint(merged, EModelEndpoint.azureAssistants, next);
}

/**
 * The model specs served without those whose endpoint the YAML-shaped config the layers leave
 * (`raw`) does not configure, by the rule startup leaves out librechat.yaml's
 * ({@link isKnownSpecEndpoint}, after inferring an agent spec's endpoint): a tombstone of
 * `endpoints.custom` or `endpoints` hides the specs of the custom endpoints it removes until a
 * layer defines them again, and a spec stored for an endpoint that is not configured is left out
 * on its own. Where no spec and no added endpoint is left, no spec list is served, as tenant
 * scoping and hidden endpoints leave none, so the controls specs turn off are derived without
 * them. `addedEndpoints` stays as merged, as startup keeps it: an endpoint it names that is gone
 * is simply not offered, while emptying the list would offer every endpoint (the names of custom
 * endpoints the layers remove are scoped out of it after the merge, `keyedTombstones`).
 */
function deriveServedSpecs(merged: AppConfig, raw: JsonRecord, principals: string): AppConfig {
  const modelSpecs = materializeModelSpecEndpoints(merged.modelSpecs);
  const list = modelSpecs?.list;
  if (modelSpecs == null || !Array.isArray(list) || list.length === 0) {
    return merged;
  }
  const customEndpoints = getEndpointIdentities(getAtPath(raw, CUSTOM_ENDPOINTS));
  const served = list.filter((spec) => {
    const endpoint: unknown = spec?.preset?.endpoint;
    return typeof endpoint === 'string' && isKnownSpecEndpoint(endpoint, customEndpoints);
  });
  if (served.length === list.length) {
    return merged;
  }
  logger.debug(
    `[mergeConfigOverrides] Leaving out ${list.length - served.length} model spec(s) for ${principals}: their endpoint is not configured once the layers apply`,
  );
  if (served.length > 0 || (modelSpecs.addedEndpoints?.length ?? 0) > 0) {
    return { ...merged, modelSpecs: { ...modelSpecs, list: served } };
  }
  const { modelSpecs: _hidden, ...rest } = merged;
  return rest;
}

/**
 * The derivations that follow a merge, for what its layers touched: custom endpoint parameters
 * (with `expandCustomEndpoint`), the model specs whose endpoint is still configured, the agents
 * endpoint's memory capability, and (with `rederiveEndpoints`) the Azure Assistants endpoint.
 * Untouched parts stay as merged.
 */
export function rederiveMergedConfig(params: {
  merged: AppConfig;
  raw: JsonRecord;
  base: AppConfig;
  touches: ConfigTouches;
  derivation: ConfigDerivation;
  principals: string;
}): AppConfig {
  const { raw, base, touches, derivation, principals } = params;
  let merged = params.merged;
  if (derivation.expandCustomEndpoint != null) {
    merged = expandWrittenEndpoints(merged, raw, base, touches, derivation.expandCustomEndpoint);
  }
  if (touchesConfig(touches, ['modelSpecs']) || touchesConfig(touches, CUSTOM_ENDPOINTS)) {
    merged = deriveServedSpecs(merged, raw, principals);
  }
  if (
    touchesConfig(touches, ['memory']) ||
    touchesConfig(touches, [ENDPOINTS, EModelEndpoint.agents])
  ) {
    merged = deriveAgentCapabilities(merged, raw);
  }
  if (
    derivation.rederiveEndpoints === true &&
    (touchesConfig(touches, [ENDPOINTS, EModelEndpoint.azureOpenAI]) ||
      touchesConfig(touches, [ENDPOINTS, EModelEndpoint.azureAssistants]))
  ) {
    merged = deriveAzureAssistants(merged, raw, principals);
  }
  return merged;
}
