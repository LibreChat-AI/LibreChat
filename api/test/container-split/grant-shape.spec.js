const {
  ADMIN_DB,
  AUTH_ROLE_NAME,
  EXPECTED_GRANT,
  describeContainerSplit,
  startProvisionedFixture,
} = require('./harness');

/**
 * GRANT-SHAPE-01: the provisioned Container_1_Grant is exactly the twelve
 * collections of the ownership matrix, each in its matrix mode, and nothing
 * wider.
 *
 * Property 10 — the grant under test is the provisioned one. The privilege set
 * this spec asserts over is read back from the role `provision.mongo.js`
 * actually created (`rolesInfo … showPrivileges: true`) and normalized, never
 * transcribed from the script's source. The expected value is the fixture's
 * single mirror of the matrix (`EXPECTED_GRANT`), which is itself built from
 * `READ_ACTIONS`, `WRITE_ACTIONS`, `AUTH_READ_WRITE` and `AUTH_READ_ONLY`. A
 * change to any of those, or to the script that must agree with them, surfaces
 * here as a failure rather than as two edits that agree only with each other.
 *
 * Property 2 (bounded above) — the Auth_Surface's collection reach is exactly
 * its grant. This spec decides the *shape* half: exhaustiveness, not presence.
 * A check that asserts the twelve are present would pass a widened grant that
 * also reaches a thirteenth collection or carries a wider action set — the NC4
 * failure mode, and the one that matters most in production. So the comparison
 * is equality of the whole normalized map, plus scalar assertions that close
 * the remaining widening routes: an inherited role, a database-wide or pattern
 * resource, or a second resource database.
 *
 * Normalizing to `Map<collection, sortedActions>` before comparing is what
 * makes the check decide shape rather than action ordering: the readback's
 * privilege order and per-privilege action order are both incidental.
 *
 * **Validates: Requirements 2.2, 2.7, 3.5**
 *
 * Check: GRANT-SHAPE-01
 */

/**
 * Reduce `rolesInfo … showPrivileges: true` output to the three things the
 * shape assertion turns on:
 *
 * - `grant`: `Map<collectionName, sortedActionList>`, one entry per privilege
 *   that names a concrete collection in a database. Actions are sorted so the
 *   comparison never depends on the order `mongod` reports them in.
 * - `inheritedRoles`: the role's `roles` array. The grant must inherit nothing;
 *   an inherited role is a widening route the collection map cannot see.
 * - `resourceDatabases`: the set of databases named across every privilege
 *   resource. Exactly one is expected — the LibreChat database the script
 *   scoped to.
 * - `nonCollectionResources`: privileges whose resource is not a concrete
 *   `{ db, collection }` with a non-empty collection — a database-wide resource
 *   (`collection: ''`), a cluster resource, or an `anyResource` pattern. Each of
 *   these grants far more than one collection, so any is a shape violation.
 */
const normalizeRole = (roleInfo) => {
  const grant = new Map();
  const resourceDatabases = new Set();
  const nonCollectionResources = [];

  for (const privilege of roleInfo.privileges) {
    const { resource, actions } = privilege;

    // A pattern resource names no single collection: cluster-wide, anyResource,
    // or a database-wide resource whose collection is the empty string. Any of
    // these reaches past the twelve, so record it rather than folding it into
    // the collection map where the equality check could not see it.
    if (
      !resource ||
      resource.cluster ||
      resource.anyResource ||
      typeof resource.db !== 'string' ||
      typeof resource.collection !== 'string' ||
      resource.collection === ''
    ) {
      nonCollectionResources.push(resource);
      continue;
    }

    resourceDatabases.add(resource.db);
    grant.set(resource.collection, [...actions].sort());
  }

  return {
    grant,
    inheritedRoles: roleInfo.roles ?? [],
    resourceDatabases,
    nonCollectionResources,
  };
};

/**
 * `Map` equality by content: same key set, and each key's sorted action list
 * equal. Returned as a structured diff rather than a boolean so a failure names
 * the collection and the two action lists rather than reporting a bare `false`.
 */
const diffGrant = (actual, expected) => {
  const missing = [];
  const unexpected = [];
  const mismatched = [];

  for (const [collection, actions] of expected) {
    if (!actual.has(collection)) {
      missing.push(collection);
    } else {
      const actualActions = actual.get(collection);
      if (JSON.stringify(actualActions) !== JSON.stringify(actions)) {
        mismatched.push({ collection, expected: actions, actual: actualActions });
      }
    }
  }

  for (const collection of actual.keys()) {
    if (!expected.has(collection)) {
      unexpected.push(collection);
    }
  }

  return { missing, unexpected, mismatched };
};

describeContainerSplit('GRANT-SHAPE-01: the provisioned grant shape', () => {
  let fixture;
  let normalized;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();

    const info = await fixture.adminDb.command({
      rolesInfo: { role: AUTH_ROLE_NAME, db: ADMIN_DB },
      showPrivileges: true,
    });

    const [role] = info.roles ?? [];

    /**
     * Guarded with a throw rather than an `expect`: the readback either produced
     * the role or the shape assertions below have nothing to normalize, and a
     * throwing `beforeAll` fails every test in the suite with this message. An
     * `expect` here would be a standalone assertion outside a test block, which
     * reports against no check and is what `jest/no-standalone-expect` forbids.
     */
    if (!role) {
      throw new Error(
        `Provisioned role ${AUTH_ROLE_NAME} was not found on ${ADMIN_DB} after the provisioning ` +
          `script reported success. rolesInfo returned: ${JSON.stringify(info.roles ?? null)}`,
      );
    }

    normalized = normalizeRole(role);
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.stop();
    }
  });

  it('grants exactly the twelve matrix collections and no thirteenth, each in its matrix mode', () => {
    // Exhaustiveness, not presence: equality of the whole normalized map against
    // the fixture's mirror of the matrix. A missing collection, an extra one, or
    // a widened action list on any of the twelve fails here.
    const { missing, unexpected, mismatched } = diffGrant(normalized.grant, EXPECTED_GRANT);

    expect({ missing, unexpected, mismatched }).toEqual({
      missing: [],
      unexpected: [],
      mismatched: [],
    });
    expect(normalized.grant.size).toBe(EXPECTED_GRANT.size);
  });

  it('inherits no role', () => {
    // An inherited role would add reach the per-collection map cannot see, so a
    // non-empty inherited-role list is a shape violation on its own.
    expect(normalized.inheritedRoles).toEqual([]);
  });

  it('names no database-wide, cluster, or pattern resource', () => {
    // Every privilege must scope to one concrete collection. A database-wide
    // resource (`collection: ''`), a cluster resource, or an `anyResource`
    // pattern each reaches past the twelve.
    expect(normalized.nonCollectionResources).toEqual([]);
  });

  it('names exactly one resource database', () => {
    // The script scopes every privilege to the connected LibreChat database via
    // `db.getName()`. More than one resource database would mean the grant spans
    // databases it should not.
    expect([...normalized.resourceDatabases]).toEqual([fixture.dbName]);
  });
});
