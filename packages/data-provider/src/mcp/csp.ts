export type MCPAppCspLimits = {
  maxSourcesPerDirective: number;
  maxSerializedLength: number;
};

export const DEFAULT_MCP_APP_CSP_LIMITS: Readonly<MCPAppCspLimits> = Object.freeze({
  maxSourcesPerDirective: 32,
  maxSerializedLength: 4096,
});

/** Default serialized resource CSP limit retained for mixed-version consumers. */
export const MCP_APP_CSP_MAX_LENGTH = DEFAULT_MCP_APP_CSP_LIMITS.maxSerializedLength;

/** Default source count retained for mixed-version consumers. */
export const MCP_APP_CSP_MAX_DOMAINS = DEFAULT_MCP_APP_CSP_LIMITS.maxSourcesPerDirective;

export type MCPAppCspDeclaration = {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

const MCP_APP_CSP_SOURCE_PATTERN =
  /^(?:(?:https?|wss?):\/\/)?(?:\*\.)?[a-zA-Z0-9][a-zA-Z0-9\-.]*(?::(?:\d{1,5}|\*))?(?:\/[^\s;,'"?#]*)?$/i;

const validLimit = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function resolveMCPAppCspLimits(value?: Partial<MCPAppCspLimits>): MCPAppCspLimits {
  return {
    maxSourcesPerDirective: validLimit(
      value?.maxSourcesPerDirective,
      DEFAULT_MCP_APP_CSP_LIMITS.maxSourcesPerDirective,
    ),
    maxSerializedLength: validLimit(
      value?.maxSerializedLength,
      DEFAULT_MCP_APP_CSP_LIMITS.maxSerializedLength,
    ),
  };
}

const normalizeCspSources = (value: unknown, maxSources: number): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sources: string[] = [];
  for (const entry of value) {
    const source = typeof entry === 'string' ? entry.trim() : '';
    if (source.length > 0 && MCP_APP_CSP_SOURCE_PATTERN.test(source)) {
      sources.push(source);
      if (sources.length === maxSources) {
        break;
      }
    }
  }
  return sources.length > 0 ? sources : undefined;
};

/**
 * Canonical declaration used for sandbox serialization, response policies, and host link checks.
 * Host link matching remains intentionally narrower than this CSP source grammar.
 */
export function normalizeMCPAppCspDeclaration(
  value: unknown,
  limits?: Partial<MCPAppCspLimits>,
): MCPAppCspDeclaration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const { maxSourcesPerDirective } = resolveMCPAppCspLimits(limits);
  const input = value as Record<keyof MCPAppCspDeclaration, unknown>;
  const normalized: MCPAppCspDeclaration = {};
  for (const key of [
    'resourceDomains',
    'connectDomains',
    'frameDomains',
    'baseUriDomains',
  ] as const) {
    const sources = normalizeCspSources(input[key], maxSourcesPerDirective);
    if (sources) {
      normalized[key] = sources;
    }
  }
  return normalized;
}
