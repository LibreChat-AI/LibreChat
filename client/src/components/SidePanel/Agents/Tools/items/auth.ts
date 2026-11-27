import type { TPlugin } from 'librechat-data-provider';

/** A tool requires auth when it declares credential fields and isn't authenticated yet. */
export function pluginNeedsAuth(plugin: TPlugin): boolean {
  return (
    Array.isArray(plugin.authConfig) &&
    plugin.authConfig.length > 0 &&
    plugin.authenticated !== true
  );
}
