import type { AllowedAddressEnvDropReason } from '../auth/allowedAddresses';
import { resolveAllowedAddressesEnv } from '../auth/allowedAddresses';

const MAX_DEPTH = 10;

export interface ConfigAllowedAddressDrop {
  /** Dotted config path of the list, e.g. `webSearch.allowedAddresses`. */
  path: string;
  entry: string;
  varName: string;
  reason: AllowedAddressEnvDropReason;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function visit(
  node: unknown,
  path: string,
  depth: number,
  env: NodeJS.ProcessEnv,
  dropped: ConfigAllowedAddressDrop[],
): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(node)) {
    node.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1, env, dropped));
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const childPath = path ? `${path}.${key}` : key;
    if (key === 'allowedAddresses' && Array.isArray(value)) {
      const resolution = resolveAllowedAddressesEnv(value, env);
      node[key] = resolution.addresses;
      for (const drop of resolution.dropped) {
        dropped.push({ path: childPath, ...drop });
      }
      continue;
    }
    visit(value, childPath, depth + 1, env, dropped);
  }
}

/**
 * Resolves `${VAR}` / `${VAR}:port` entries in every `allowedAddresses` list of a validated YAML
 * config, in place, from the server environment. Runs only on the file the loader read, so DB
 * overrides and user-provided values never gain environment resolution. Returns the dropped
 * references for the caller to report; the config stays usable either way.
 */
export function resolveConfigAllowedAddresses(
  config: object,
  env: NodeJS.ProcessEnv,
): ConfigAllowedAddressDrop[] {
  const dropped: ConfigAllowedAddressDrop[] = [];
  visit(config, '', 0, env, dropped);
  return dropped;
}
