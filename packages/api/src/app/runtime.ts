import type { LoadedCustomConfig } from './loader';
import { setConfigDigest } from '~/telemetry/digest';

/** The limit the process had before config first set one: 10, or `--stack-trace-limit`. */
let processStackTraceLimit: number | undefined;

/**
 * Sets `Error.stackTraceLimit` for errors created from now on. With no limit it restores the
 * process default, so removing the key and reloading undoes an earlier value.
 */
export function applyStackTraceLimit(limit: number | undefined): void {
  processStackTraceLimit ??= Error.stackTraceLimit;
  Error.stackTraceLimit = limit ?? processStackTraceLimit;
}

/** Process-wide effects of the librechat.yaml that just loaded, at startup and on reload. */
export function applyLoadedConfig({ config, digest }: LoadedCustomConfig): void {
  applyStackTraceLimit(config.telemetry?.stackTraceLimit);
  setConfigDigest(digest);
}
