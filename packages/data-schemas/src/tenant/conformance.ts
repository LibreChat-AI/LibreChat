/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the harness interface and the suite factory that each engine's
   own spec imports. The rule guards against accidental exports from spec files. */
/**
 * The portable tenant-isolation contract.
 *
 * `~/tenant/policy` defines the rules and `policy.spec.ts` proves them with no
 * database. This file covers what only an engine can be asked: whether a given
 * binding actually wires those rules to the operations it exposes.
 *
 * An engine satisfies the contract by implementing `TenantEngineHarness` and
 * calling `describeTenantIsolationConformance` from a spec. The suite is
 * deliberately small — it pins portable behaviour, not any one engine's
 * surface, which is why the Mongoose-specific cases stay in
 * `models/plugins/tenantIsolation.spec.ts`.
 */

import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { resetTenantStrictCache } from './policy';

/** A row as the engine stores it. */
export interface TenantRow {
  readonly name: string;
  readonly tenantId?: string;
}

/**
 * The operations an engine must expose for the contract to be checkable.
 *
 * Every method except `seed` and `readAllUnscoped` runs under whatever tenant
 * context the suite has established, and is expected to be subject to the
 * engine's tenant enforcement. Those two deliberately bypass it so the suite
 * can build and inspect cross-tenant fixtures.
 */
export interface TenantEngineHarness {
  readonly name: string;
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Removes all rows, bypassing enforcement. */
  reset(): Promise<void>;
  /** Inserts rows bypassing enforcement, for cross-tenant fixtures. */
  seed(rows: readonly TenantRow[]): Promise<void>;
  /** Reads every row bypassing enforcement, for assertions. */
  readAllUnscoped(): Promise<readonly TenantRow[]>;

  insert(row: TenantRow): Promise<void>;
  findNames(): Promise<readonly string[]>;
  count(): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  /** Applies an update that also attempts to set `tenantId`. */
  renameAndReassign(from: string, to: string, tenantId: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const withStrict = async (value: boolean, fn: () => Promise<void>): Promise<void> => {
  const previous = process.env.TENANT_ISOLATION_STRICT;
  process.env.TENANT_ISOLATION_STRICT = String(value);
  resetTenantStrictCache();
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TENANT_ISOLATION_STRICT;
    } else {
      process.env.TENANT_ISOLATION_STRICT = previous;
    }
    resetTenantStrictCache();
  }
};

const A = 'tenant-a';
const B = 'tenant-b';

export function describeTenantIsolationConformance(harness: TenantEngineHarness): void {
  const asA = <T>(fn: () => Promise<T>): Promise<T> => tenantStorage.run({ tenantId: A }, fn);
  const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
    tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, fn);

  describe(`tenant isolation conformance: ${harness.name}`, () => {
    beforeAll(() => harness.setup());
    afterAll(() => harness.teardown());
    beforeEach(async () => {
      resetTenantStrictCache();
      await harness.reset();
    });

    describe('reads', () => {
      it('sees only the active tenant', async () => {
        await harness.seed([
          { name: 'mine', tenantId: A },
          { name: 'theirs', tenantId: B },
        ]);

        expect(await asA(() => harness.findNames())).toEqual(['mine']);
      });

      it('counts only the active tenant', async () => {
        await harness.seed([
          { name: 'mine', tenantId: A },
          { name: 'theirs', tenantId: B },
        ]);

        expect(await asA(() => harness.count())).toBe(1);
      });

      it('sees every tenant under the system sentinel', async () => {
        await harness.seed([
          { name: 'mine', tenantId: A },
          { name: 'theirs', tenantId: B },
        ]);

        expect([...(await asSystem(() => harness.findNames()))].sort()).toEqual(['mine', 'theirs']);
      });

      it('sees every tenant with no context, for pre-tenancy deployments', async () => {
        await harness.seed([
          { name: 'mine', tenantId: A },
          { name: 'theirs', tenantId: B },
        ]);

        expect([...(await harness.findNames())].sort()).toEqual(['mine', 'theirs']);
      });
    });

    describe('writes', () => {
      it('stamps the active tenant onto an insert', async () => {
        await asA(() => harness.insert({ name: 'fresh' }));

        const rows = await harness.readAllUnscoped();
        expect(rows).toEqual([expect.objectContaining({ name: 'fresh', tenantId: A })]);
      });

      /**
       * A sharp edge worth stating explicitly rather than discovering: an insert
       * that names another tenant is REFUSED in strict mode but TOLERATED
       * otherwise, because pre-tenancy backfill has to be able to write rows for
       * a tenant other than the ambient one. An engine must reproduce both
       * halves, or deliberately decide not to.
       */
      it('refuses a caller-chosen tenant on insert in strict mode', async () => {
        await withStrict(true, async () => {
          await expect(
            asA(() => harness.insert({ name: 'smuggled', tenantId: B })),
          ).rejects.toThrow('[TenantIsolation]');
        });

        expect(await harness.readAllUnscoped()).toHaveLength(0);
      });

      it('tolerates a caller-chosen tenant on insert outside strict mode', async () => {
        await withStrict(false, async () => {
          await asA(() => harness.insert({ name: 'backfilled', tenantId: B }));
        });

        const rows = await harness.readAllUnscoped();
        expect(rows[0]).toEqual(expect.objectContaining({ name: 'backfilled', tenantId: B }));
      });

      it('cannot rename another tenant row', async () => {
        await harness.seed([{ name: 'theirs', tenantId: B }]);

        await asA(() => harness.rename('theirs', 'stolen'));

        const rows = await harness.readAllUnscoped();
        expect(rows[0].name).toBe('theirs');
      });

      it('cannot delete another tenant row', async () => {
        await harness.seed([{ name: 'theirs', tenantId: B }]);

        await asA(() => harness.remove('theirs'));

        expect(await harness.readAllUnscoped()).toHaveLength(1);
      });

      it('refuses an update that reassigns the tenant', async () => {
        await harness.seed([{ name: 'mine', tenantId: A }]);

        await expect(asA(() => harness.renameAndReassign('mine', 'moved', B))).rejects.toThrow(
          '[TenantIsolation]',
        );

        const rows = await harness.readAllUnscoped();
        expect(rows[0]).toEqual(expect.objectContaining({ name: 'mine', tenantId: A }));
      });
    });

    describe('strict mode', () => {
      it('refuses a read with no tenant context', async () => {
        await withStrict(true, async () => {
          await expect(harness.findNames()).rejects.toThrow('[TenantIsolation]');
        });
      });

      it('refuses a write with no tenant context', async () => {
        await withStrict(true, async () => {
          await expect(harness.insert({ name: 'orphan' })).rejects.toThrow('[TenantIsolation]');
        });
      });

      it('still allows the system sentinel through', async () => {
        await withStrict(true, async () => {
          await expect(asSystem(() => harness.findNames())).resolves.toEqual([]);
        });
      });
    });
  });
}
