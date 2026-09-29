import { isEnabled } from '~/utils';

/**
 * Whether this container skips the startup work that initializes shared deployment state —
 * seeding, interface-permission derivation, migration checks, file sweeps, skill sync, MCP
 * initialization — plus the boot-time RAG health probe, the credential-database check, the
 * search index sync, and the search plugin's index-provisioning block.
 *
 * The last four members of that set are not gated at the entrypoints. The RAG health probe and
 * the credential-database check are gated inside `performStartupChecks`
 * (`packages/api/src/app/checks.ts`); the search index sync is gated inside `indexSync()`
 * (`api/db/indexSync.js`), beside its existing `SEARCH` guard; and the plugin's
 * index-provisioning block is gated inside `mongoMeili.ts` (below), because it runs when the
 * plugin is attached to a schema during model registration rather than at a call the entrypoint
 * makes.
 *
 * `process.env` is read on every call rather than captured at module load, so a caller always
 * observes the current value of `DISABLE_STARTUP_TASKS`.
 *
 * A second reader of the same flag exists in
 * `packages/data-schemas/src/models/plugins/mongoMeili.ts`, named `areStartupTasksDisabledLocal`.
 * It cannot call this predicate, because `packages/data-schemas` does not depend on
 * `@librechat/api`. The two must be changed in step: if they disagree on any value the variable
 * can hold, that value would suppress the startup calls gated here while leaving the search
 * plugin's index-provisioning block running.
 */
export function areStartupTasksDisabled(): boolean {
  return isEnabled(process.env.DISABLE_STARTUP_TASKS);
}

/**
 * The single `warn`-level line a gated container emits per boot, shared by both entrypoints so
 * neither holds its own copy.
 */
export const startupTasksDisabledWarning: string =
  '[Deployment] DISABLE_STARTUP_TASKS is set: this container performs no database seeding, ' +
  'no interface permission derivation from librechat.yaml, no migration checks, no file sweeps, ' +
  'no skill sync, no search indexing, and no MCP initialization. Another container must perform ' +
  'that work — do not run this container as a single-container deployment.';
