import { EModelEndpoint } from 'librechat-data-provider';
import {
  logger,
  getAtPath,
  parseConfigPath,
  isSegmentPrefix,
  resolveRawConfig,
  isVertexConfigured,
  mergeConfigEntries,
  isBaseConfigPrincipal,
  applyConfigTombstones,
  resolveServedAzureGroups,
} from '@librechat/data-schemas';
import type { ConfigOverrideLayer } from '@librechat/data-schemas';
import type { TCustomConfig } from 'librechat-data-provider';

const ENDPOINTS = 'endpoints';
const AZURE_GROUPS = [ENDPOINTS, EModelEndpoint.azureOpenAI, 'groups'];
const AZURE_GROUPS_PATH = AZURE_GROUPS.join('.');
const VERTEX = [ENDPOINTS, EModelEndpoint.anthropic, 'vertex'];
/**
 * Where the overrides `CONFIG_REDERIVE_ENDPOINTS` applies sit, besides Azure `groups` and Vertex
 * AI (which it applies only where librechat.yaml configures Vertex AI).
 */
const AZURE_ASSISTANTS_PATHS = [
  [ENDPOINTS, EModelEndpoint.azureOpenAI, 'assistants'],
  [ENDPOINTS, EModelEndpoint.azureAssistants],
];

/** A stored config document, as the startup report reads it. */
export type ReportedConfig = ConfigOverrideLayer & {
  tenantId?: string | null;
  isActive?: boolean;
};

/**
 * The config documents whose endpoint overrides `CONFIG_REDERIVE_ENDPOINTS` applies, which are
 * inert without it, by description.
 */
export interface EndpointOverrideReport {
  /**
   * Documents that write or tombstone Vertex AI (`endpoints.anthropic.vertex`, where librechat.yaml
   * configures it) or the Azure Assistants switches (`endpoints.azureOpenAI.assistants`,
   * `endpoints.azureAssistants`).
   */
  rederived: string[];
  /**
   * Documents that write or tombstone Vertex AI where librechat.yaml configures none: the merge
   * never applies those overrides, whether the switch is on or off.
   */
  ignoredVertex: string[];
  /**
   * Documents whose Azure `groups`, merged by `group` over the groups below them (librechat.yaml's,
   * and the active Base profile's for any other document), resolve, or that tombstone them: the
   * whole list, a group, or a path inside one.
   */
  azureGroups: string[];
  /**
   * Documents whose Azure `groups` do not resolve over those groups (such as full copies an older
   * admin panel stored with blank deployment names), which the merge leaves out.
   */
  unresolvedAzureGroups: string[];
}

function describeConfig(config: ReportedConfig): string {
  const principal = `${config.principalType}/${config.principalId.toString()}`;
  const tenant = config.tenantId ? ` in tenant ${config.tenantId}` : '';
  const inactive = config.isActive === false ? ' (inactive)' : '';
  return `${principal}${tenant}${inactive}`;
}

function getGroupNames(groups: unknown[]): Set<string> {
  const names = new Set<string>();
  for (const item of groups) {
    const name = (item as { group?: unknown } | null)?.group;
    if (typeof name === 'string') {
      names.add(name);
    }
  }
  return names;
}

function getTombstones(config: ReportedConfig): string[] {
  return (config.tombstones ?? []).filter((path): path is string => typeof path === 'string');
}

/**
 * Whether a tombstone removes Azure `groups` and nothing above them: the whole list, or a keyed
 * tombstone of a group or of a path inside one (`endpoints.azureOpenAI.groups["east"].version`).
 */
function isAzureGroupsTombstone(tombstone: string): boolean {
  if (tombstone === AZURE_GROUPS_PATH) {
    return true;
  }
  const location = parseConfigPath(tombstone);
  return (
    location?.entry != null &&
    location.segments.length === AZURE_GROUPS.length &&
    isSegmentPrefix(AZURE_GROUPS, location.segments)
  );
}

/** Whether a document writes `segments`, or tombstones it or anything below it. */
function holds(config: ReportedConfig, tombstones: string[], segments: string[]): boolean {
  const path = segments.join('.');
  return (
    getAtPath(config.overrides, segments) !== undefined ||
    tombstones.some((tombstone) => tombstone === path || tombstone.startsWith(`${path}.`))
  );
}

function getTenantKey(config: ReportedConfig): string {
  return config.tenantId ?? '';
}

/**
 * Sorts the stored config documents by what `CONFIG_REDERIVE_ENDPOINTS` changes for their
 * endpoint overrides. Each document's Azure `groups` are judged as a write validates them: over
 * `baseYaml`, and for any document but the Base profile over its tenant's active Base profile too,
 * which the merge applies first.
 */
export function getEndpointOverrideReport(
  configs: readonly ReportedConfig[],
  baseYaml: Partial<TCustomConfig>,
): EndpointOverrideReport {
  const report: EndpointOverrideReport = {
    rederived: [],
    ignoredVertex: [],
    azureGroups: [],
    unresolvedAzureGroups: [],
  };
  const vertexConfigured = isVertexConfigured(baseYaml);
  const bases = new Map<string, ReportedConfig>();
  for (const config of configs) {
    if (isBaseConfigPrincipal(config) && config.isActive !== false) {
      bases.set(getTenantKey(config), config);
    }
  }
  const floors = new Map<string, Partial<TCustomConfig>>();
  const getFloor = (config: ReportedConfig): Partial<TCustomConfig> => {
    const key = getTenantKey(config);
    const base = isBaseConfigPrincipal(config) ? undefined : bases.get(key);
    if (base == null) {
      return baseYaml;
    }
    let floor = floors.get(key);
    if (floor == null) {
      floor = resolveRawConfig(baseYaml, [base]);
      floors.set(key, floor);
    }
    return floor;
  };
  for (const config of configs) {
    const description = describeConfig(config);
    const tombstones = getTombstones(config);
    const holdsVertex = holds(config, tombstones, VERTEX);
    if (holdsVertex && !vertexConfigured) {
      report.ignoredVertex.push(description);
    }
    if (
      (holdsVertex && vertexConfigured) ||
      AZURE_ASSISTANTS_PATHS.some((segments) => holds(config, tombstones, segments))
    ) {
      report.rederived.push(description);
    }
    const groups = getAtPath(config.overrides, AZURE_GROUPS);
    if (!Array.isArray(groups)) {
      if (tombstones.some(isAzureGroupsTombstone)) {
        report.azureGroups.push(description);
      }
      continue;
    }
    const below = getAtPath(applyConfigTombstones(getFloor(config), tombstones), AZURE_GROUPS);
    const merged = mergeConfigEntries(AZURE_GROUPS, below, groups);
    const resolves = resolveServedAzureGroups(merged, getGroupNames(groups)).isValid;
    (resolves ? report.azureGroups : report.unresolvedAzureGroups).push(description);
  }
  return report;
}

/**
 * Logs, once at startup, the config documents whose endpoint overrides `CONFIG_REDERIVE_ENDPOINTS`
 * applies: with it, which Vertex AI, Azure Assistants and Azure `groups` overrides apply and
 * which groups do not resolve and are left out; without it, which documents hold overrides that
 * are inert until it is set, and which of their groups would not resolve then either. Either way,
 * the documents whose Vertex AI overrides never apply, because librechat.yaml configures no Vertex
 * AI. A failure to read or judge the documents is logged and never rejects.
 */
export async function reportEndpointOverrides(params: {
  listConfigs: () => Promise<readonly ReportedConfig[]>;
  baseYaml: Partial<TCustomConfig>;
  rederiveEndpoints: boolean;
}): Promise<EndpointOverrideReport | null> {
  const { listConfigs, baseYaml, rederiveEndpoints } = params;
  let report: EndpointOverrideReport;
  try {
    report = getEndpointOverrideReport(await listConfigs(), baseYaml);
  } catch (error) {
    logger.error(
      '[config] Could not report the endpoint overrides of the config documents:',
      error,
    );
    return null;
  }
  const { rederived, ignoredVertex, azureGroups, unresolvedAzureGroups } = report;
  if (ignoredVertex.length > 0) {
    logger.warn(
      `[config] Ignoring the Vertex AI overrides (endpoints.anthropic.vertex) of these config documents, because librechat.yaml configures no Vertex AI; configure it there or remove them: ${ignoredVertex.join(', ')}`,
    );
  }
  if (!rederiveEndpoints) {
    const inert = [...new Set([...rederived, ...azureGroups, ...unresolvedAzureGroups])];
    if (inert.length > 0) {
      logger.warn(
        `[config] These config documents hold Vertex AI, Azure Assistants or Azure groups overrides that are inert until CONFIG_REDERIVE_ENDPOINTS=true, which will become the default; review them before enabling it: ${inert.join(', ')}`,
      );
    }
    if (unresolvedAzureGroups.length > 0) {
      logger.warn(
        `[config] The Azure groups of these config documents do not resolve over librechat.yaml and the Base profile, so CONFIG_REDERIVE_ENDPOINTS would leave them out; rewrite or remove them: ${unresolvedAzureGroups.join(', ')}`,
      );
    }
    return report;
  }
  if (rederived.length > 0) {
    logger.info(
      `[config] Applying the Vertex AI and Azure Assistants overrides (CONFIG_REDERIVE_ENDPOINTS) of: ${rederived.join(', ')}`,
    );
  }
  if (azureGroups.length > 0) {
    logger.info(
      `[config] Applying the Azure groups (CONFIG_REDERIVE_ENDPOINTS; merged by group over librechat.yaml's and the Base profile's) of: ${azureGroups.join(', ')}`,
    );
  }
  if (unresolvedAzureGroups.length > 0) {
    logger.warn(
      `[config] Ignoring the Azure groups of these config documents, which do not resolve over librechat.yaml and the Base profile; rewrite or remove them: ${unresolvedAzureGroups.join(', ')}`,
    );
  }
  return report;
}
