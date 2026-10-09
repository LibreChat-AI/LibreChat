/**
 * Build entry shim for the `@librechat/api/telemetry` subpath export.
 * Re-exports the telemetry barrel under a unique basename so the bundler emits
 * stable `dist/telemetry.*` output (see tsdown.config.mjs for details).
 */
export * from './telemetry/index';
