import type { ParsedServerConfig } from '~/mcp/types';

/** Optional header maps a stored config may carry as an explicit null. */
type LegacyHeaderMaps = {
  headers?: Record<string, string> | null;
  requestHeaders?: Record<string, string> | null;
};

/**
 * Drops `headers` and `requestHeaders` stored as null by a writer that
 * serialized an absent map: BSON materializes an explicit undefined property as
 * null, and both fields are optional objects in the MCP transport schemas, so a
 * stored null fails the runtime validation every connection and catalog
 * generation depends on.
 *
 * Every store a config is read back from is a compatibility boundary, because a
 * replica running older code can write into it while this replica reads. The
 * same value is returned when there is nothing to normalize, so the hot path
 * allocates nothing.
 */
export function normalizeLegacyHeaderMaps(config: ParsedServerConfig): ParsedServerConfig {
  const persistedConfig = config as ParsedServerConfig & LegacyHeaderMaps;
  if (persistedConfig.headers !== null && persistedConfig.requestHeaders !== null) {
    return config;
  }

  const { headers, requestHeaders, ...rest } = persistedConfig;
  return {
    ...rest,
    ...(headers != null && { headers }),
    ...(requestHeaders != null && { requestHeaders }),
  } as ParsedServerConfig;
}

/** The same normalization across a stored server map, reusing the input map when every entry is current. */
export function normalizeLegacyHeaderMapsIn<T extends Record<string, ParsedServerConfig>>(
  configs: T,
): T {
  let normalized: Record<string, ParsedServerConfig> | undefined;
  for (const serverName of Object.keys(configs)) {
    const config = configs[serverName];
    const normalizedConfig = normalizeLegacyHeaderMaps(config);
    if (normalizedConfig === config) {
      continue;
    }
    normalized ??= { ...configs };
    normalized[serverName] = normalizedConfig;
  }
  return (normalized as T) ?? configs;
}
