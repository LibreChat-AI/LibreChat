import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger } from '@librechat/data-schemas';
import type { TToolApprovalHookConfig } from 'librechat-data-provider';
import type { ToolApprovalHookFactory } from './hooks';
import { registerToolApprovalHook } from './hooks';

/**
 * The default-export contract a tool-approval hook MODULE must satisfy: a builder that takes
 * the config entry's static `options` and returns a per-run {@link ToolApprovalHookFactory}.
 *
 *   // my-hook.js
 *   module.exports = (options) => (context) => async (input) => ({ decision: 'ask' });
 */
export type ToolApprovalHookModule = (options?: Record<string, unknown>) => ToolApprovalHookFactory;

export interface LoadToolApprovalHooksOptions {
  /** Directory to resolve relative module paths against. Defaults to `process.cwd()`. */
  basePath?: string;
  /** Override the dynamic importer (used by tests to avoid touching the filesystem). */
  importModule?: (specifier: string) => Promise<unknown>;
}

/**
 * Unregister fns for the hooks THIS loader registered. Tracked so a config reload can drop
 * its previous batch without disturbing hooks registered directly in code.
 */
let loadedUnregisters: Array<() => void> = [];

/**
 * Turn a config `module` string into an importable specifier. Explicit paths (absolute, or
 * `./`-relative) resolve against `basePath` and become a `file://` URL so `import()` accepts
 * them on every platform. A bare specifier prefers a real FILE under `basePath` (so
 * `config/hooks/workspace.js` works without a leading `./`), falling back to a package
 * specifier when no such file exists; scoped names (`@scope/pkg`) are always packages.
 */
function resolveModuleSpecifier(spec: string, basePath: string): string {
  if (path.isAbsolute(spec)) {
    return pathToFileURL(spec).href;
  }
  if (spec.startsWith('.')) {
    return pathToFileURL(path.resolve(basePath, spec)).href;
  }
  if (!spec.startsWith('@')) {
    const candidate = path.resolve(basePath, spec);
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return spec;
}

/**
 * Load + register the programmatic tool-approval hooks declared under
 * `endpoints.agents.toolApproval.hooks`. Call once at startup (and again on a config reload —
 * each call first unregisters the previous batch, so it is idempotent across reloads and
 * never double-registers).
 *
 * Robust by design: a bad entry (unimportable module, non-function export, builder that
 * throws or returns a non-function) is logged and skipped — one misconfigured hook never
 * crashes startup or blocks the others. Returns the number of hooks successfully registered.
 *
 * SECURITY: each `module` is dynamically imported and executed in-process. This is
 * admin-level config (librechat.yaml); only reference trusted code.
 */
export async function loadToolApprovalHooks(
  hooks: TToolApprovalHookConfig[] | undefined,
  options: LoadToolApprovalHooksOptions = {},
): Promise<number> {
  const basePath = options.basePath ?? process.cwd();
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));

  // Drop the previous batch (reload safety) WITHOUT clearing code-registered hooks.
  for (const off of loadedUnregisters) {
    off();
  }
  loadedUnregisters = [];

  if (!Array.isArray(hooks) || hooks.length === 0) {
    return 0;
  }

  let registered = 0;
  for (const entry of hooks) {
    try {
      // Validate the matcher regex up front: the SDK compiles it with `new RegExp` at
      // run-build time, where a bad pattern would throw out of buildHITLRunWiring and break
      // EVERY HITL run — here it's skipped like any other bad entry.
      if (entry.matcher != null) {
        try {
          void new RegExp(entry.matcher);
        } catch (regexErr) {
          logger.error(
            `[toolApprovalHooks] Invalid matcher regex ${JSON.stringify(entry.matcher)} for module "${entry.module}"; skipping`,
            regexErr,
          );
          continue;
        }
      }

      const specifier = resolveModuleSpecifier(entry.module, basePath);
      const mod = (await importModule(specifier)) as { default?: unknown };
      let builder: unknown = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;
      // CJS/transpiled interop: TypeScript/Babel `exports.default = fn` (esModuleInterop)
      // surfaces through import() as `{ default: { default: fn } }`, so unwrap one more level
      // before rejecting — otherwise documented "default export" hook modules fail to load.
      if (
        builder != null &&
        typeof builder === 'object' &&
        'default' in builder &&
        typeof (builder as { default: unknown }).default === 'function'
      ) {
        builder = (builder as { default: unknown }).default;
      }
      if (typeof builder !== 'function') {
        logger.error(
          `[toolApprovalHooks] Module "${entry.module}" did not export a hook-builder function; skipping`,
        );
        continue;
      }

      const factory = (builder as ToolApprovalHookModule)(entry.options);
      if (typeof factory !== 'function') {
        logger.error(
          `[toolApprovalHooks] Builder from "${entry.module}" did not return a factory function; skipping`,
        );
        continue;
      }

      loadedUnregisters.push(registerToolApprovalHook(factory, { matcher: entry.matcher }));
      registered++;
      logger.info(
        `[toolApprovalHooks] Registered tool-approval hook from "${entry.module}"` +
          (entry.matcher ? ` (matcher: ${entry.matcher})` : ''),
      );
    } catch (err) {
      logger.error(
        `[toolApprovalHooks] Failed to load tool-approval hook module "${entry.module}"; skipping`,
        err,
      );
    }
  }

  return registered;
}
