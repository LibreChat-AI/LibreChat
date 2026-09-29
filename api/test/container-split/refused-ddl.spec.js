const mongoose = require('mongoose');

const { AUTH_READ_WRITE, describeContainerSplit, startProvisionedFixture } = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 2: The Auth_Surface's collection reach is exactly its grant —
 * bounded-above half, DDL side.
 *
 * `refused.spec.js` walks the reads outside the twelve and `refused-writes.spec.js`
 * the writes withheld inside them; this suite walks the *data-definition* actions
 * withheld on the eight read-write collections. The Container_1_Grant carries the
 * DocumentDB-portable write vocabulary — `insert`, `update`, `remove`,
 * `createIndex` — and nothing more. `createCollection` is granted **nowhere at
 * all**, and `drop` and `dropIndex` are granted nowhere either. So under that
 * grant an `insert` or a `createIndex` on a read-write collection succeeds, but a
 * `createCollection`, a `drop`, or a `dropIndex` on that same collection must be
 * refused. This suite attempts each of the three against every read-write
 * collection and asserts `mongod` refuses each with an authorization error
 * (code 13 / "not authorized").
 *
 * `createCollection` is the load-bearing one. It is granted nowhere, and its
 * absence is what makes `GRANT-MATERIALIZE-06` (task 3.5) necessary rather than
 * incidental: with no `createCollection`, `createIndex` is what materializes
 * `authtokens` and `bans` on first write. A grant that quietly regained
 * `createCollection` would make that materialization check pass for the wrong
 * reason, so its refusal is asserted here first and most plainly.
 *
 * **The DDL target exists before the attempt.** A `drop` or `dropIndex` against a
 * collection that does not exist can fail with a namespace-not-found error rather
 * than an authorization error, which would make the refusal ambiguous — is the
 * action refused, or is there simply nothing to drop? So the fixture's root client
 * (`fixture.db`, which bypasses every provisioned grant) materializes each
 * read-write collection and builds an index on it *before* the grant attempts the
 * DDL. The refusal is then unambiguously about the DDL privilege the grant lacks,
 * not about a missing namespace. `createCollection` is the exception: it is
 * attempted against a name that does *not* yet exist, because attempting to create
 * an already-existing collection would itself be a namespace-exists error rather
 * than the authorization refusal under test.
 *
 * Nothing here simulates an authorization error. The fixture runs
 * `mongodb-memory-server` with access control on, the credential is the real
 * collection-scoped role the unmodified `provision.mongo.js` created, and the
 * refusals are `mongod`'s — the same discipline `api/test/migration/harness.js`
 * sets out for itself.
 *
 * **Validates: Requirements 3.5**
 *
 * Check: GRANT-DENY-DDL-07
 */
describeContainerSplit('GRANT-DENY-DDL-07: DDL on the read-write collections is refused', () => {
  let fixture;
  /** A MongoClient authenticated under the Container_1_Grant. */
  let authClient;
  let authDb;
  /** The fixture's root database handle, bypassing every provisioned grant. */
  let rootDb;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();

    authClient = await MongoClient.connect(fixture.uriFor('auth'));
    authDb = authClient.db(fixture.dbName);
    rootDb = fixture.db;

    // Materialize each read-write collection and build an index on it as root,
    // so a `drop`/`dropIndex` refusal below is about the DDL privilege the grant
    // lacks rather than about a missing namespace. Root bypasses the grant, so
    // this setup asserts nothing about the grant itself.
    for (const collection of AUTH_READ_WRITE) {
      await rootDb.collection(collection).insertOne({ _seededBy: 'harness-root', collection });
      await rootDb.collection(collection).createIndex({ _seededBy: 1 }, { name: 'ddl_target_idx' });
    }
  }, 300_000);

  afterAll(async () => {
    await authClient?.close();
    await fixture?.stop();
  });

  it('grants exactly the eight expected read-write collections', () => {
    // Guards this spec against a silent change to the ownership matrix: if the
    // read-write set moves, the enumeration below stops covering it. Pins the set
    // the requirement names.
    expect(AUTH_READ_WRITE.slice().sort()).toEqual(
      [
        'users',
        'sessions',
        'authtokens',
        'balances',
        'bans',
        'groups',
        'refreshtokenbridges',
        'openidrefreshflights',
      ].sort(),
    );
  });

  describe.each(AUTH_READ_WRITE)('DDL on `%s` under the Container_1_Grant', (collection) => {
    /**
     * One attempted DDL action per row, each run once in `beforeAll` so the
     * assertion reads from the same operation.
     *
     * `createCollection` targets a *new* name so the refusal is an authorization
     * error rather than a namespace-exists error; `drop` and `dropIndex` target
     * the collection and index the root client materialized above, so the refusal
     * is an authorization error rather than a namespace-not-found error. In every
     * case the assertion is that the DDL action is refused, regardless of target.
     */
    describe.each([
      ['createCollection', (db) => db.createCollection(`${collection}_harness_ddl`)],
      ['drop', (db) => db.collection(collection).drop()],
      ['dropIndex', (db) => db.collection(collection).dropIndex('ddl_target_idx')],
    ])('attempting %s', (action, attempt) => {
      let error;

      beforeAll(async () => {
        error = undefined;
        try {
          await attempt(authDb);
        } catch (caught) {
          error = caught;
        }
      });

      it('is refused with an authorization error from mongod', () => {
        expect(error).toBeDefined();
        // MongoServerError, code 13, is `mongod`'s own Unauthorized code — not a
        // client-side guard, and not a namespace-not-found (26) or
        // namespace-exists (48) error, which the setup above deliberately avoids.
        // The message check keeps the assertion honest against any error that
        // merely happens to carry code 13.
        expect(error).toBeInstanceOf(mongoose.mongo.MongoServerError);
        expect(error.code).toBe(13);
        expect(error.codeName).toBe('Unauthorized');
        expect(error.message).toMatch(/not authorized/i);
      });
    });
  });
});
