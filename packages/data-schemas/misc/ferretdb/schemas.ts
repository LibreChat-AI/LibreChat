import type { Schema } from 'mongoose';
import { createModels } from '~/models';

/**
 * Registry entries that production keeps app-wide instead of provisioning into
 * every org database, per the rationale in each factory under `src/models`:
 * `SystemGrant` (cross-tenant control plane), `AuditLog` (append-only chain
 * serialized per `chainKey`), `SkillSyncCredential` and `SkillSyncStatus`
 * (app-wide GitHub skill sync). They are exactly the registry entries that opt
 * out of the tenant-isolation plugin, so provisioning them per org would
 * duplicate credentials and control-plane state into every tenant.
 */
export const APP_WIDE_MODELS: ReadonlySet<string> = new Set([
  'AuditLog',
  'SkillSyncCredential',
  'SkillSyncStatus',
  'SystemGrant',
]);

let cachedSchemas: Record<string, Schema> | undefined;

/**
 * Rebuilds a schema from its own definition, options, and declared indexes.
 *
 * The registry schemas are module-level singletons that `createModels` mutates
 * with application middleware (tenant isolation, audit chaining). This harness
 * benchmarks raw per-database storage behavior and reads/writes without any
 * tenant context, so it must not inherit that middleware — under
 * `TENANT_ISOLATION_STRICT=true` those hooks throw before a single FerretDB
 * assertion runs. The copy keeps every path, index, and option the collection
 * layout depends on while carrying none of the hooks.
 */
function detachSchema(mongoose: typeof import('mongoose'), source: Schema): Schema {
  const detached = new mongoose.Schema(source.obj, source.options);
  const declared = new Set(detached.indexes().map(([fields]) => JSON.stringify(fields)));

  for (const [fields, options] of source.indexes()) {
    const key = JSON.stringify(fields);
    if (declared.has(key)) {
      continue;
    }
    detached.index(fields, options);
    declared.add(key);
  }

  return detached;
}

/**
 * Derives a `{ modelName: Schema }` map of every org-local LibreChat model from
 * the live `createModels` registry instead of a hand-maintained list, so each
 * FerretDB harness spec that provisions "one of every org collection" tracks
 * the current model set automatically as models are added or removed.
 *
 * The registry is built on a throwaway Mongoose instance so nothing is
 * registered on the default connection — the benchmark opens that connection
 * itself, and default models would otherwise auto-create their collections in
 * the URI's base database and skew catalog metrics and timings.
 */
export function getModelSchemas(mongoose: typeof import('mongoose')): Record<string, Schema> {
  if (cachedSchemas) {
    return cachedSchemas;
  }

  const registry = createModels(new mongoose.Mongoose());

  const unknownAppWide = [...APP_WIDE_MODELS].filter((name) => !(name in registry));
  if (unknownAppWide.length > 0) {
    throw new Error(
      `APP_WIDE_MODELS lists models missing from the registry: ${unknownAppWide.join(', ')}`,
    );
  }

  const schemas: Record<string, Schema> = {};
  for (const [name, model] of Object.entries(registry)) {
    if (APP_WIDE_MODELS.has(name)) {
      continue;
    }
    schemas[name] = detachSchema(mongoose, model.schema);
  }

  cachedSchemas = schemas;
  return schemas;
}
