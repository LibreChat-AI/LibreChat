const {
  ADMIN_DB,
  AUTH_ROLE_NAME,
  EXPECTED_GRANT,
  describeContainerSplit,
  startProvisionedFixture,
} = require('./harness');

/**
 * PROVISION-IDEMPOTENT-10: re-running the unmodified script narrows a
 * deliberately widened role back to exactly the twelve-collection shape.
 *
 * Property 10 — the grant under test is the provisioned one. The corrective
 * mechanism the design relies on for a *drifted* role is re-running the script,
 * not editing it: `provision.mongo.js` recomputes the role with `updateRole`,
 * which replaces the privilege and inherited-role sets wholesale rather than
 * merging into them, so a previously broader grant is narrowed rather than left
 * in place. This spec exercises exactly that.
 *
 * The order matters. A run that only ever *added* privileges would satisfy a
 * naive "the twelve are present" check while leaving a widened grant standing
 * silently — the NC4 failure mode. So the widening is introduced first, through
 * a root command (NG2 — the script is never edited), observed to have taken
 * effect, and only then is the unmodified script re-run. The assertion is that
 * the second run *removed* the widening: the re-read normalized grant equals
 * `EXPECTED_GRANT` exactly, with nothing else about the shape changed.
 *
 * Widening is done AS ROOT via `grantPrivilegesToRole`, adding a thirteenth
 * collection the ownership matrix does not assign. That is a real drift a root
 * operator could introduce out of band; the script's re-run is the repair, and
 * this check keeps that repair honest.
 *
 * Normalizing to `Map<collection, sortedActions>` before comparing is what
 * makes the check decide *shape* rather than action ordering — the same
 * normalization `grant-shape.spec.js` uses on the freshly provisioned role.
 *
 * **Validates: Requirements 2.2, 2.7**
 *
 * Check: PROVISION-IDEMPOTENT-10
 */

/**
 * A thirteenth collection the ownership matrix never assigns, plus a mutating
 * action, so the widening is visible along both axes the shape check closes: an
 * extra collection key, and a wider action set on it. Kept distinct from every
 * name in `EXPECTED_GRANT` so the widening cannot be mistaken for one of the
 * twelve.
 */
const WIDENING_COLLECTION = 'harness_widened_collection';
const WIDENING_ACTIONS = ['find', 'insert', 'update', 'remove'];

/**
 * Reduce `rolesInfo … showPrivileges: true` output to `Map<collection,
 * sortedActions>`, one entry per privilege naming a concrete collection.
 * Actions are sorted so the comparison never depends on the order `mongod`
 * reports them in. Mirrors `grant-shape.spec.js`'s normalization, scoped to the
 * collection map this spec compares.
 */
const normalizeGrant = (roleInfo) => {
  const grant = new Map();
  for (const privilege of roleInfo.privileges) {
    const { resource, actions } = privilege;
    if (
      !resource ||
      resource.cluster ||
      resource.anyResource ||
      typeof resource.db !== 'string' ||
      typeof resource.collection !== 'string' ||
      resource.collection === ''
    ) {
      continue;
    }
    grant.set(resource.collection, [...actions].sort());
  }
  return grant;
};

/**
 * `Map` equality by content: same key set, and each key's sorted action list
 * equal. Returned as a structured diff so a failure names the collection and
 * the two action lists rather than a bare `false`. Mirrors `grant-shape.spec.js`.
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

const readGrant = async (adminDb) => {
  const info = await adminDb.command({
    rolesInfo: { role: AUTH_ROLE_NAME, db: ADMIN_DB },
    showPrivileges: true,
  });
  const [role] = info.roles;
  expect(role).toBeDefined();
  return normalizeGrant(role);
};

describeContainerSplit('PROVISION-IDEMPOTENT-10: idempotent narrowing of a widened role', () => {
  let fixture;
  let widenedGrant;
  let narrowedGrant;
  let rerun;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();

    // Widen the provisioned role AS ROOT — add a thirteenth collection with a
    // mutating action the matrix never assigns. `grantPrivilegesToRole` unions
    // into the existing privilege set, so the twelve stay and the extra lands
    // on top. This is the out-of-band drift the re-run must repair (NG2 — the
    // script itself is untouched).
    await fixture.adminDb.command({
      grantPrivilegesToRole: AUTH_ROLE_NAME,
      privileges: [
        {
          resource: { db: fixture.dbName, collection: WIDENING_COLLECTION },
          actions: [...WIDENING_ACTIONS],
        },
      ],
    });

    widenedGrant = await readGrant(fixture.adminDb);

    // Re-run the UNMODIFIED script a second time. This is the corrective
    // mechanism: `updateRole` replaces the privilege set, so the widening is
    // dropped rather than merged.
    rerun = fixture.runProvision();

    narrowedGrant = await readGrant(fixture.adminDb);
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('observably widened the role before the re-run', () => {
    // The re-run's narrowing is only meaningful if the widening actually took
    // effect first. Assert the thirteenth collection was present with its wider
    // action set, so a run that only ever adds privileges cannot pass this spec
    // by leaving the widening in place unobserved.
    expect(widenedGrant.has(WIDENING_COLLECTION)).toBe(true);
    expect(widenedGrant.get(WIDENING_COLLECTION)).toEqual([...WIDENING_ACTIONS].sort());
    expect(widenedGrant.size).toBe(EXPECTED_GRANT.size + 1);
  });

  it('completed the re-run successfully', () => {
    // The narrowing is the script's own repair, so the re-run must succeed and
    // emit its completion signal. A failed re-run would leave the widening in
    // place and prove nothing.
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain('Done.');
  });

  it('narrowed the role back to exactly the twelve-collection shape', () => {
    // Exhaustiveness, not presence: equality of the whole normalized map against
    // the fixture's mirror of the matrix. The widening collection must be gone,
    // the twelve must be intact in their matrix modes, and nothing else about the
    // shape may have changed.
    const { missing, unexpected, mismatched } = diffGrant(narrowedGrant, EXPECTED_GRANT);

    expect({ missing, unexpected, mismatched }).toEqual({
      missing: [],
      unexpected: [],
      mismatched: [],
    });
    expect(narrowedGrant.size).toBe(EXPECTED_GRANT.size);
    expect(narrowedGrant.has(WIDENING_COLLECTION)).toBe(false);
  });
});
