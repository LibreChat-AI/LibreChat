import mongoose from 'mongoose';
import { createModels } from '../index';

/**
 * Global symbol set by applyTenantIsolation() on every schema it processes.
 * Recreated here via Symbol.for (the global registry) so the guard can detect
 * plugin application without the plugin exporting anything.
 */
const TENANT_ISOLATION_APPLIED = Symbol.for('librechat:tenantIsolation');

/**
 * Models that carry a `tenantId` field but intentionally do NOT use the
 * tenant-isolation plugin. SystemGrant scopes tenancy manually inside its
 * methods (see models/systemGrant). SkillSyncStatus stores both app-wide YAML
 * status rows and tenant-scoped override rows, so its methods apply explicit
 * tenant filters instead of ambient ALS scoping. AuditLog composes its tenant
 * filter from the JWT-resolved caller and uses `{ tenantId: { $exists: false } }`
 * for platform-level entries. RefreshTokenBridge resolves tenant context from
 * the signed OpenID marker cookie during unauthenticated refresh recovery, and
 * its methods apply explicit tenant filters. Adding an entry here must be a
 * deliberate, reviewed decision — that is the whole point of this guard.
 */
const MANUAL_TENANT_SCOPING = new Set<string>([
  'SystemGrant',
  'SkillSyncStatus',
  'AuditLog',
  'RefreshTokenBridge',
]);

function isPluginApplied(schema: mongoose.Schema): boolean {
  return (schema as unknown as { [key: symbol]: boolean })[TENANT_ISOLATION_APPLIED] === true;
}

describe('tenant-isolation plugin coverage', () => {
  beforeAll(() => {
    createModels(mongoose);
  });

  it('applies the tenant-isolation plugin to every model that has a tenantId field', () => {
    const missing: string[] = [];

    for (const [name, model] of Object.entries(mongoose.models)) {
      const hasTenantId = Boolean(model.schema.path('tenantId'));
      if (!hasTenantId || MANUAL_TENANT_SCOPING.has(name)) {
        continue;
      }
      if (!isPluginApplied(model.schema)) {
        missing.push(name);
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps the manual-scoping allowlist accurate (tenantId field, no plugin)', () => {
    for (const name of MANUAL_TENANT_SCOPING) {
      const model = mongoose.models[name];
      expect(model).toBeDefined();
      expect(Boolean(model.schema.path('tenantId'))).toBe(true);
      expect(isPluginApplied(model.schema)).toBe(false);
    }
  });
});
