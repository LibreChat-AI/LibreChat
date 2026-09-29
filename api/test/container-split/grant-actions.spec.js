const {
  ADMIN_DB,
  AUTH_ROLE_NAME,
  AUTH_READ_ONLY,
  AUTH_READ_WRITE,
  READ_ACTIONS,
  WRITE_ACTIONS,
  describeContainerSplit,
  startProvisionedFixture,
} = require('./harness');

/**
 * GRANT-ACTIONS-02: the provisioned Container_1_Grant's action vocabulary is
 * the DocumentDB-portable intersection, literally — the read set is exactly
 * `find`, the write set is exactly `insert, update, remove, createIndex`, and
 * `createCollection` is granted on no collection at all.
 *
 * Property 2 — the Auth_Surface's collection reach is exactly its grant. Where
 * GRANT-SHAPE-01 (grant-shape.spec.js) decides the *shape* — which twelve
 * collections, in which mode — this spec decides the *vocabulary*: the exact
 * set of privileged actions the grant carries on reads and on writes, asserted
 * as literal sets rather than derived from the fixture's expected table.
 *
 * Why literal, and why a separate spec. The vocabulary was narrowed to the
 * intersection a real Amazon DocumentDB 5.0 cluster accepts — `find` for reads,
 * `insert, update, remove, createIndex` for writes, `createCollection` dropped
 * everywhere — after a maintainer verified the narrow set against that cluster.
 * A later edit that silently re-widens the vocabulary (adds `createCollection`
 * back, or an aggregation/DDL action) would survive a shape check that only
 * counts collections and modes. Pinning the two action sets to their literal
 * values here makes such a re-widening fail within seconds of a unit run rather
 * than surviving to a 300-second topology bring-up.
 *
 * This is the MongoDB baseline half only. It asserts what the script
 * provisioned and what MongoDB reports back; it claims nothing about DocumentDB
 * (NG7). The `DOCUMENTDB_URI`-gated suites under
 * `packages/data-schemas/misc/documentdb/` own the DocumentDB verdict.
 *
 * The action sets are read back from the role `provision.mongo.js` actually
 * created (`rolesInfo … showPrivileges: true`), never transcribed from the
 * script's source — the script's computed privilege set is the thing under
 * test.
 *
 * **Validates: Requirements 3.5**
 *
 * Check: GRANT-ACTIONS-02
 */

const CREATE_COLLECTION = 'createCollection';

/**
 * Collect, from a `rolesInfo … showPrivileges: true` readback, the observed
 * action vocabulary keyed by collection, plus the union of every action the
 * grant carries anywhere.
 *
 * - `actionsByCollection`: `Map<collectionName, sortedActionList>`, one entry
 *   per privilege naming a concrete collection. Sorted so the comparison never
 *   depends on the order `mongod` reports actions in — the same normalization
 *   grant-shape.spec.js uses.
 * - `allActions`: the set of every action named across every privilege, so a
 *   forbidden action (`createCollection`) can be asserted absent grant-wide in
 *   one place rather than per collection.
 */
const collectActions = (roleInfo) => {
  const actionsByCollection = new Map();
  const allActions = new Set();

  for (const privilege of roleInfo.privileges) {
    const { resource, actions } = privilege;
    for (const action of actions) {
      allActions.add(action);
    }

    if (
      resource &&
      typeof resource.db === 'string' &&
      typeof resource.collection === 'string' &&
      resource.collection !== ''
    ) {
      actionsByCollection.set(resource.collection, [...actions].sort());
    }
  }

  return { actionsByCollection, allActions };
};

const sorted = (actions) => [...actions].sort();

describeContainerSplit('GRANT-ACTIONS-02: the provisioned grant action vocabulary', () => {
  let fixture;
  let actionsByCollection;
  let allActions;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();

    const info = await fixture.adminDb.command({
      rolesInfo: { role: AUTH_ROLE_NAME, db: ADMIN_DB },
      showPrivileges: true,
    });

    const [role] = info.roles ?? [];

    /**
     * Guarded with a throw rather than an `expect`: the readback either produced
     * the role or the vocabulary assertions below have nothing to read, and a
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

    ({ actionsByCollection, allActions } = collectActions(role));
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.stop();
    }
  });

  it('grants exactly `find` on every read-only collection and nothing more', () => {
    // The whole read vocabulary is `find`. Any read-only collection carrying a
    // second action is a re-widening.
    const expectedReadSet = sorted(READ_ACTIONS);
    expect(expectedReadSet).toEqual(['find']);

    for (const collection of AUTH_READ_ONLY) {
      expect(actionsByCollection.get(collection)).toEqual(expectedReadSet);
    }
  });

  it('grants exactly `find, insert, update, remove, createIndex` on every read-write collection', () => {
    // The read-write vocabulary is the read set plus exactly the four write
    // actions of the DocumentDB-portable intersection — no wider, and in
    // particular without `createCollection`.
    const expectedWriteSet = sorted(WRITE_ACTIONS);
    expect(expectedWriteSet).toEqual(sorted(['insert', 'update', 'remove', 'createIndex']));

    const expectedReadWriteSet = sorted([...READ_ACTIONS, ...WRITE_ACTIONS]);

    for (const collection of AUTH_READ_WRITE) {
      expect(actionsByCollection.get(collection)).toEqual(expectedReadWriteSet);
    }
  });

  it('grants `createCollection` on no collection anywhere', () => {
    // The load-bearing absence: with `createCollection` withheld, `createIndex`
    // is what materializes `authtokens` and `bans` on first write. A grant that
    // carried `createCollection` on any collection would re-widen the
    // vocabulary past the portable intersection.
    expect(allActions.has(CREATE_COLLECTION)).toBe(false);

    for (const [collection, actions] of actionsByCollection) {
      expect({ collection, hasCreateCollection: actions.includes(CREATE_COLLECTION) }).toEqual({
        collection,
        hasCreateCollection: false,
      });
    }
  });

  it('carries no action outside the read set and the write set anywhere in the grant', () => {
    // The union of every action the grant names must be exactly the read set
    // plus the write set — five actions. A stray action on any collection
    // (an aggregation privilege, a DDL action, anything) surfaces here even if
    // it slipped onto a collection this suite does not enumerate by name.
    const permittedVocabulary = sorted([...READ_ACTIONS, ...WRITE_ACTIONS]);
    expect(sorted(allActions)).toEqual(permittedVocabulary);
  });
});
