const mongoose = require('mongoose');

const { AUTH_READ_WRITE, describeContainerSplit, startProvisionedFixture } = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 2: The Auth_Surface's collection reach is exactly its grant —
 * bounded-below half, in MongoDB terms.
 *
 * The bounded-above half (`refused.spec.js`, the DDL and read-only refusals)
 * proves the grant is *narrow*. This spec proves the complementary half: that
 * the grant is *sufficient*. Under the Container_1_Grant every one of the eight
 * read-write collections accepts a write, and the three collections whose method
 * layers issue an explicit `Model.createIndexes()` on the request path accept a
 * `createIndex`. Either half alone is satisfiable by a wrong system — a grant
 * that refuses everything passes the refusal suite, a grant that permits
 * everything passes this one — so both run.
 *
 * This half is the one that is new. The grant's action vocabulary was narrowed
 * to the DocumentDB-portable intersection — `find` on reads, `insert`, `update`,
 * `remove`, `createIndex` on writes, `createCollection` granted nowhere — after
 * a maintainer verified the narrow set against a real Amazon DocumentDB 5.0
 * cluster. Before this harness nothing ran the write path under that narrowed
 * grant, so its sufficiency was assumed rather than observed.
 *
 * Nothing simulates a permitted operation. `mongod` runs with access control on,
 * the credential is the real collection-scoped role the real `provision.mongo.js`
 * produced, and a write that persists persists because the server allowed it.
 *
 * **Persistence is confirmed under the same auth grant.** The Container_1_Grant
 * holds `find` on all eight read-write collections — they are read+write there —
 * so a permitted read-back under that credential is the natural confirmation
 * that the document landed. The observer credential is granted `find` only on
 * the refusal-check collections, so it cannot see these eight; using it here
 * would fail for want of a privilege rather than confirm anything.
 *
 * **Validates: Requirements 3.8**
 *
 * Check: GRANT-ALLOW-WRITE-05
 */
describeContainerSplit('GRANT-ALLOW-WRITE-05: writes to the eight read-write collections', () => {
  let fixture;
  /** A MongoClient authenticated under the Container_1_Grant. */
  let authClient;
  let authDb;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();
    authClient = await MongoClient.connect(fixture.uriFor('auth'));
    authDb = authClient.db(fixture.dbName);
  }, 300_000);

  afterAll(async () => {
    await authClient?.close();
    await fixture?.stop();
  });

  /**
   * The three collections whose method layers issue an explicit
   * `Model.createIndexes()` on the request path — on login, refresh and logout.
   * The grant carries `createIndex` for exactly this reason, and each must be
   * permitted to `createIndex` under the Container_1_Grant.
   */
  const CREATE_INDEX_COLLECTIONS = ['sessions', 'refreshtokenbridges', 'openidrefreshflights'];

  it('grants exactly the eight expected read-write collections', () => {
    // Guards this spec against a silent change to the ownership matrix: if the
    // read-write set moves, the enumeration below stops covering it and this
    // pins the count the requirement names.
    expect(AUTH_READ_WRITE.slice().sort()).toEqual(
      [
        'authtokens',
        'balances',
        'bans',
        'groups',
        'openidrefreshflights',
        'refreshtokenbridges',
        'sessions',
        'users',
      ].sort(),
    );
  });

  describe.each(AUTH_READ_WRITE)('under the Container_1_Grant, collection `%s`', (collection) => {
    it('permits an insert and the document persists', async () => {
      const marker = `insert-${collection}`;
      const doc = { _harness: marker, at: new Date() };

      const insert = await authDb.collection(collection).insertOne(doc);
      expect(insert.acknowledged).toBe(true);

      // Read back under the SAME auth grant — it holds `find` on all eight —
      // so persistence is confirmed by the credential that wrote it.
      const persisted = await authDb.collection(collection).findOne({ _harness: marker });
      expect(persisted).not.toBeNull();
      expect(persisted._id).toEqual(insert.insertedId);
    });

    it('permits an update that persists', async () => {
      const marker = `update-${collection}`;
      const insert = await authDb.collection(collection).insertOne({ _harness: marker, v: 1 });

      const update = await authDb
        .collection(collection)
        .updateOne({ _id: insert.insertedId }, { $set: { v: 2 } });
      expect(update.acknowledged).toBe(true);
      expect(update.modifiedCount).toBe(1);

      const persisted = await authDb.collection(collection).findOne({ _id: insert.insertedId });
      expect(persisted.v).toBe(2);
    });

    it('permits a remove that persists', async () => {
      const marker = `remove-${collection}`;
      const insert = await authDb.collection(collection).insertOne({ _harness: marker });

      const remove = await authDb.collection(collection).deleteOne({ _id: insert.insertedId });
      expect(remove.acknowledged).toBe(true);
      expect(remove.deletedCount).toBe(1);

      const persisted = await authDb.collection(collection).findOne({ _id: insert.insertedId });
      expect(persisted).toBeNull();
    });
  });

  describe.each(CREATE_INDEX_COLLECTIONS)(
    'under the Container_1_Grant, request-path createIndex on `%s`',
    (collection) => {
      it('is permitted', async () => {
        // The shape `Model.createIndexes()` issues on the request path: a
        // `createIndexes` command against the collection the method layer indexes.
        // The server accepting the command (`ok: 1`, no authorization error) is
        // the permission signal. A `listIndexes` read-back would need the
        // `listIndexes` action, which the grant deliberately withholds — the
        // grant carries `createIndex` and nothing wider — so confirming through
        // it would fail for want of a privilege rather than confirm the write.
        const indexName = `harness_${collection}_idx`;
        const created = await authDb.command({
          createIndexes: collection,
          indexes: [{ key: { _harnessIndexed: 1 }, name: indexName }],
        });

        expect(created.ok).toBe(1);
      });
    },
  );
});
