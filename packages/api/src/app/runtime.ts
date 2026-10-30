import type { AppConfig } from '@librechat/data-schemas';
import type { LoadedCustomConfig } from './loader';
import { setConfigDigest } from '~/telemetry/digest';

/** The limit the process had before config first set one: 10, or `--stack-trace-limit`. */
let processStackTraceLimit: number | undefined;

const loadedDigests = new WeakMap<object, string>();

/** Stages file identity without changing the running configuration. */
export function recordLoadedConfig({ config, digest }: LoadedCustomConfig): void {
  loadedDigests.set(config, digest);
}

/**
 * Sets `Error.stackTraceLimit` for errors created from now on. With no limit it restores the
 * process default, so removing the key and reloading undoes an earlier value.
 */
export function applyStackTraceLimit(limit: number | undefined): void {
  processStackTraceLimit ??= Error.stackTraceLimit;
  Error.stackTraceLimit = limit ?? processStackTraceLimit;
}

/** Applies process-wide settings only once the YAML-derived base config is published. */
export function applyLoadedConfig({ config }: AppConfig): void {
  applyStackTraceLimit(config?.telemetry?.stackTraceLimit);
  const digest = config && loadedDigests.get(config);
  if (digest) {
    setConfigDigest(digest);
  }
}
