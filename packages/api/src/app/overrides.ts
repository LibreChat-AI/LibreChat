import {
  getAtPath,
  setAtPath,
  unsetAtPath,
  foldConfigMergeKey,
  resolveConfigLayers,
  mergeConfigOverridesWithSource,
} from '@librechat/data-schemas';
import type {
  AppConfig,
  ConfigMergeResult,
  ConfigOverrideLayer,
  AdminConfigLayerIgnored,
  ConfigLayersResolution,
} from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';
import type { EnvReferencePolicy } from './allowlist';
import type { SecretRebinding } from './rebinding';
import {
  withoutSecretBindings,
  createSecretRebindingGuard,
  withoutStoredSecretBindings,
} from './rebinding';
import { getSecretPreviewKey, resolveRuntimeConfigSecrets } from '~/admin/secrets';
import { neutralizeEnvReferences } from './allowlist';
import { expandCustomEndpoint } from './params';

export interface OverrideMergeOptions {
  /** Which `${NAME}` references values from override layers may resolve. */
  envPolicy: EnvReferencePolicy;
  /** Told about each inherited secret a layer drops for sending it somewhere new. */
  onRebinding?: (rebinding: SecretRebinding) => void;
  /**
   * Whether the Azure groups, Vertex AI and the Azure Assistants endpoint are derived again from
   * what the layers write (`CONFIG_REDERIVE_ENDPOINTS`); without it those overrides stay inert.
   */
  rederiveEndpoints?: boolean;
}

/**
 * {@link mergeOverrideLayers}, with the librechat.yaml-shaped config the layers merge to, from
 * which the caller derives what only the final config decides.
 */
export function mergeOverrideLayersWithSource(
  baseConfig: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  options: OverrideMergeOptions,
): ConfigMergeResult {
  const neutralized = layers.map((layer) => {
    const overrides = neutralizeEnvReferences(layer.overrides, options.envPolicy);
    return overrides === layer.overrides ? layer : { ...layer, overrides };
  });
  const { onRebinding, rederiveEndpoints } = options;
  const { appConfig, raw } = mergeConfigOverridesWithSource(baseConfig, neutralized, {
    expandCustomEndpoint,
    rederiveEndpoints,
    afterLayer: createSecretRebindingGuard(onRebinding),
    onWebSearchKeyUnbound: ({ layer, apiKey }) =>
      onRebinding?.({
        layer,
        kind: 'secret',
        segments: ['webSearch', apiKey],
        path: `webSearch.${apiKey}`,
      }),
  });
  return { appConfig: withoutSecretBindings(appConfig), raw };
}

/**
 * Merges database override layers into the base config under the policies that apply to
 * admin-written values: each layer's disallowed `${NAME}` references resolve to nothing before it
 * merges, and a secret sent anywhere but the destination it was entered for is dropped
 * (`createSecretRebindingGuard`; web search keys by the merge's own rule, whose drops are
 * reported the same way). What startup derives from librechat.yaml is derived again for the
 * parts the layers write: custom endpoint parameters (`expandCustomEndpoint`), the agents memory
 * capability, and with `rederiveEndpoints` the Azure groups, Vertex AI and the Azure Assistants
 * endpoint. The
 * destination fingerprints stored beside secrets are read by the guard and left out of the
 * result (`withoutSecretBindings`). Secrets stay as stored, so the result may be cached as is.
 */
export function mergeOverrideLayers(
  baseConfig: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  options: OverrideMergeOptions,
): AppConfig {
  return mergeOverrideLayersWithSource(baseConfig, layers, options).appConfig;
}

/**
 * {@link mergeOverrideLayers}, then the stored credentials runtime readers need in plaintext
 * decrypted once (`resolveRuntimeConfigSecrets`).
 */
export function resolveConfigOverrides(
  baseConfig: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  options: OverrideMergeOptions,
): AppConfig {
  return resolveRuntimeConfigSecrets(mergeOverrideLayers(baseConfig, layers, options));
}

/** {@link resolveOverrideLayers}' result: a {@link ConfigLayersResolution} under admin policies. */
export type OverrideLayersResolution = ConfigLayersResolution;

/** Where a reference the env policy neutralized sat in a layer's overrides, and what it held. */
function findNeutralized(
  written: unknown,
  neutralized: unknown,
  segments: readonly string[] = [],
): AdminConfigLayerIgnored[] {
  if (written === neutralized) {
    return [];
  }
  if (typeof written === 'string') {
    return [
      {
        path: segments.join('.'),
        segments: [...segments],
        reason: 'env_reference_not_allowed',
      },
    ];
  }
  if (written == null || typeof written !== 'object' || neutralized == null) {
    return [];
  }
  const writtenRecord = written as Record<string, unknown>;
  const neutralizedRecord = neutralized as Record<string, unknown>;
  return Object.keys(writtenRecord).flatMap((key) =>
    findNeutralized(writtenRecord[key], neutralizedRecord[key], [...segments, key]),
  );
}

const CUSTOM_ENDPOINTS_PATH = 'endpoints.custom';
const AZURE_GROUP_MAP: readonly string[] = ['endpoints', 'azureOpenAI', 'groupMap'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The index of the entry of a list keyed by `field` whose key `matches`. */
function findEntryIndex(list: unknown, field: string, matches: (key: string) => boolean): number {
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex((item) => {
    const key = asRecord(item)?.[field];
    return typeof key === 'string' && matches(key);
  });
}

/**
 * The concrete location in `tree` of a rebinding's YAML location (`SecretRebinding.segments`), or
 * `null` when the tree holds no such entry: a custom endpoint is found by the name the merge
 * folds; in the served config an MCP server is under `mcpConfig`; in the YAML-shaped result an
 * Azure `groupMap` group the merge resolved from `groups` is that group's entry.
 */
function locateRebinding(
  tree: unknown,
  segments: readonly string[],
  shape: 'served' | 'resolved',
): string[] | null {
  const [section, field, name, ...rest] = segments;
  if (`${section}.${field}` === CUSTOM_ENDPOINTS_PATH && name != null) {
    const identity = foldConfigMergeKey(CUSTOM_ENDPOINTS_PATH, name);
    const index = findEntryIndex(
      getAtPath(tree, [section, field]),
      'name',
      (key) => foldConfigMergeKey(CUSTOM_ENDPOINTS_PATH, key) === identity,
    );
    return index < 0 ? null : [section, field, String(index), ...rest];
  }
  if (section === 'mcpServers' && shape === 'served') {
    return ['mcpConfig', ...segments.slice(1)];
  }
  const groupMapDepth = AZURE_GROUP_MAP.length;
  const isGroupMap = AZURE_GROUP_MAP.every((segment, index) => segments[index] === segment);
  if (shape === 'resolved' && isGroupMap && segments.length > groupMapDepth) {
    const group = segments[groupMapDepth];
    if (asRecord(getAtPath(tree, [...AZURE_GROUP_MAP, group])) != null) {
      return [...segments];
    }
    const groups = [...AZURE_GROUP_MAP.slice(0, -1), 'groups'];
    const index = findEntryIndex(getAtPath(tree, groups), 'group', (key) => key === group);
    return index < 0 ? null : [...groups, String(index), ...segments.slice(groupMapDepth + 1)];
  }
  return [...segments];
}

/**
 * `resolved` without the masked preview stored beside the credential at `target`
 * (`getSecretPreviewKey`): the merge dropped that credential, and a preview left beside it
 * would read as a key that applies.
 */
function withoutDroppedPreview(
  resolved: Partial<TCustomConfig>,
  target: readonly string[],
): Partial<TCustomConfig> {
  if (target.length === 0) {
    return resolved;
  }
  const preview = [...target.slice(0, -1), getSecretPreviewKey(target[target.length - 1])];
  if (getAtPath(resolved, preview) === undefined) {
    return resolved;
  }
  return unsetAtPath(resolved as Record<string, unknown>, preview) as Partial<TCustomConfig>;
}

/**
 * The YAML-shaped result with a rebinding's outcome copied from the served config: the dropped
 * credential (`''`, without its stored preview) or the destination set back. A location the
 * result holds no parent for (an AppConfig-only field such as `vertexConfig`) is left as it is.
 */
function replayRebinding(
  resolved: Partial<TCustomConfig>,
  merged: AppConfig,
  { kind, segments }: SecretRebinding,
): Partial<TCustomConfig> {
  const target = locateRebinding(resolved, segments, 'resolved');
  const source = locateRebinding(merged, segments, 'served');
  if (target == null || source == null || target.length === 0) {
    return resolved;
  }
  const parent = getAtPath(resolved, target.slice(0, -1));
  if (parent == null || typeof parent !== 'object') {
    return resolved;
  }
  const value = getAtPath(merged, source);
  const root = resolved as Record<string, unknown>;
  let replayed: Partial<TCustomConfig>;
  if (value === undefined) {
    replayed = Array.isArray(parent)
      ? resolved
      : (unsetAtPath(root, target) as Partial<TCustomConfig>);
  } else {
    replayed = setAtPath(root, target, value) as Partial<TCustomConfig>;
  }
  return kind === 'secret' ? withoutDroppedPreview(replayed, target) : replayed;
}

function principalKey(layer: ConfigOverrideLayer): string {
  return `${layer.principalType}:${layer.principalId?.toString()}`;
}

/**
 * {@link mergeOverrideLayers}, tracked: `merged` is exactly what it returns, `resolved` the same
 * merge in librechat.yaml shape (`resolveConfigLayers`), with each credential the rebinding guard
 * drops and each destination it sets back applied to it as well, and each layer (the document as
 * given, before env references are neutralized) lists what the merge does not apply of it, its
 * disallowed env references and rebound credentials included. Destination fingerprints are left
 * out of `resolved`, as reads leave them out.
 */
export function resolveOverrideLayers(
  baseConfig: AppConfig,
  layers: readonly ConfigOverrideLayer[],
  options: OverrideMergeOptions,
): OverrideLayersResolution {
  const originals = new Map<ConfigOverrideLayer, ConfigOverrideLayer>();
  const extra = new Map<string, AdminConfigLayerIgnored[]>();
  const neutralized = layers.map((layer) => {
    const overrides = neutralizeEnvReferences(layer.overrides, options.envPolicy);
    if (overrides === layer.overrides) {
      return layer;
    }
    const next = { ...layer, overrides };
    originals.set(next, layer);
    extra.set(principalKey(layer), findNeutralized(layer.overrides, overrides));
    return next;
  });
  const rebindings: SecretRebinding[] = [];
  const unboundKeys: string[][] = [];
  const { onRebinding, rederiveEndpoints } = options;
  const result = resolveConfigLayers(baseConfig, neutralized, {
    expandCustomEndpoint,
    rederiveEndpoints,
    afterLayer: createSecretRebindingGuard((rebinding) => {
      rebindings.push(rebinding);
      onRebinding?.(rebinding);
    }),
    onWebSearchKeyUnbound: ({ layer, apiKey }) => {
      const segments = ['webSearch', apiKey];
      unboundKeys.push(segments);
      onRebinding?.({ layer, kind: 'secret', segments, path: segments.join('.') });
    },
  });
  const merged = withoutSecretBindings(result.merged);
  let resolved = unboundKeys.reduce(
    (tree, segments) => withoutDroppedPreview(tree, segments),
    result.resolved,
  );
  for (const rebinding of rebindings) {
    resolved = replayRebinding(resolved, merged, rebinding);
    const key = principalKey(rebinding.layer);
    extra.set(key, [
      ...(extra.get(key) ?? []),
      {
        path: rebinding.path,
        segments: [...rebinding.segments],
        reason: rebinding.kind === 'secret' ? 'secret_rebinding' : 'destination_restored',
      },
    ]);
  }
  return {
    merged,
    raw: result.raw,
    resolved: withoutStoredSecretBindings(resolved),
    layers: result.layers.map(({ layer, ignored }) => ({
      layer: originals.get(layer) ?? layer,
      ignored: [...ignored, ...(extra.get(principalKey(layer)) ?? [])],
    })),
  };
}
