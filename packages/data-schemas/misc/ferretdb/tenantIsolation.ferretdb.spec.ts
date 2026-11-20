import { describeTenantIsolationConformance } from '~/tenant/conformance';
import { createMongooseTenantHarness } from '~/tenant/harness';

/**
 * The portable tenant-isolation contract against a live engine: FerretDB (PostgreSQL +
 * DocumentDB extension), or any MongoDB-compatible server for parity. It covers the
 * single-partition reads that config resolution relies on, whose tenantless filter
 * (`$exists: false`, `null` and `''`) must mean the same on every engine.
 *
 * Run against FerretDB (see docker-compose.ferretdb.yml):
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/tenant_conformance" \
 *     npx jest --config misc/ferretdb/jest.ferretdb.config.mjs tenantIsolation.ferretdb
 *
 * Run against MongoDB (for parity):
 *   FERRETDB_URI="mongodb://127.0.0.1:27017/tenant_conformance" \
 *     npx jest --config misc/ferretdb/jest.ferretdb.config.mjs tenantIsolation.ferretdb
 */

const FERRETDB_URI = process.env.FERRETDB_URI;

if (FERRETDB_URI) {
  describeTenantIsolationConformance(
    createMongooseTenantHarness({
      name: `mongoose on ${new URL(FERRETDB_URI).host}`,
      connect: async () => FERRETDB_URI,
      release: async () => undefined,
    }),
  );
} else {
  describe.skip('tenant isolation conformance (set FERRETDB_URI to run)', () => {
    it('runs against a live engine', () => {
      expect(FERRETDB_URI).toBeDefined();
    });
  });
}
