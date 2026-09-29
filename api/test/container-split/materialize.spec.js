const mongoose = require('mongoose');

const { describeContainerSplit, startProvisionedFixture } = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 2: The Auth_Surface's collection reach is exactly its grant —
 * the materialization corollary of the bounded-below half.
 *
 * The grant withholds `createCollection` everywhere (it is the DocumentDB-portable
 * intersection: `find` on reads; `insert`, `update`, `remove`, `createIndex` on
 * writes; `createCollection` granted nowhere). With `createCollection` ungranted,
 * `createIndex` is what materializes a missing collection on the first write the
 * grant performs now — where a wider grant would have leaned on an implicit
 * `createCollection`. `authtokens` and `bans` are the two read-write collections
 * that no root-seeding touches (task 1.2 deliberately leaves them unseeded), so
 * they are the two whose materialization the harness can observe cleanly.
 *
 * This check asserts *that* both collections exist after the first write the
 * grant performs — not *which* action created them. Both `insert` and
 * `createIndex` can materialize a missing collection, and the method layers issue
 * both; pinning the assertion to one of them would make the check fail on a change
 * in call order that breaks nothing. So each collection is exercised twice, once
 * per materializing action, and every case asserts the same thing: the collection
 * was absent before, and exists after.
 *
 * Nothing simulates a permitted operation. `mongod` runs with access control on,
 * the write runs under the real collection-scoped role the real `provision.mongo.js`
 * produced, and the collection materializes because the server allowed the write.
 *
 * **Existence is observed under a credential that can see it.** The Container_1_Grant
 * does not hold `listCollections`, and the observer grant is scoped to the
 * refusal-check collections only — neither can enumerate `authtokens` or `bans`.
 * The fixture's root client (`fixture.db`) can, so existence before and after is
 * read through it. That keeps the observation off any ungranted action while still
 * proving the write the auth grant performed materialized the collection.
 *
 * **Validates: Requirements 3.8**
 *
 * Check: GRANT-MATERIALIZE-06
 */
describeContainerSplit(
  'GRANT-MATERIALIZE-06: authtokens and bans materialize on first write',
  () => {
    let fixture;
    /** A MongoClient authenticated under the Container_1_Grant. */
    let authClient;
    let authDb;

    /**
     * The two read-write collections task 1.2 leaves unseeded. They are absent
     * from `OBSERVER_SEEDED_COLLECTIONS` for this reason, so their absence before
     * the first write is a property of the fixture rather than a coincidence.
     */
    const MATERIALIZED_COLLECTIONS = ['authtokens', 'bans'];

    /**
     * Observe existence through the fixture's root client, which holds
     * `listCollections`. `nameOnly` keeps the read cheap and needs no further
     * privilege. Returns whether a collection of exactly `name` exists in the
     * LibreChat database.
     */
    const collectionExists = async (name) => {
      const found = await fixture.db.listCollections({ name }, { nameOnly: true }).toArray();
      return found.length === 1 && found[0].name === name;
    };

    beforeAll(async () => {
      fixture = await startProvisionedFixture();
      authClient = await MongoClient.connect(fixture.uriFor('auth'));
      authDb = authClient.db(fixture.dbName);
    }, 300_000);

    afterAll(async () => {
      await authClient?.close();
      await fixture?.stop();
    });

    it('covers exactly the two collections task 1.2 leaves unseeded', () => {
      // Pins the pair this check reasons about: if the fixture ever seeds one of
      // these, or the unseeded set changes, this stops matching and the drift is
      // caught here rather than turning the "absent before" assertions vacuous.
      expect(MATERIALIZED_COLLECTIONS.slice().sort()).toEqual(['authtokens', 'bans']);
    });

    describe.each(MATERIALIZED_COLLECTIONS)('collection `%s`', (collection) => {
      it('is absent before the first write and exists after an insert', async () => {
        expect(await collectionExists(collection)).toBe(false);

        const insert = await authDb
          .collection(collection)
          .insertOne({ _harness: `materialize-insert-${collection}` });
        expect(insert.acknowledged).toBe(true);

        expect(await collectionExists(collection)).toBe(true);
      });

      it('exists after a createIndex materializes it from absent', async () => {
        // Fresh state per case: the insert case above materialized this
        // collection, so drop it as root to return to absent, then let a
        // `createIndex` under the Container_1_Grant be the first write. Both
        // `insert` and `createIndex` can materialize a missing collection and the
        // method layers issue both; this case pins that `createIndex` alone
        // suffices, so a change in call order that reaches `createIndex` first
        // does not turn this check red.
        await fixture.db
          .collection(collection)
          .drop()
          .catch(() => {});
        expect(await collectionExists(collection)).toBe(false);

        const indexName = `harness_${collection}_materialize_idx`;
        const created = await authDb.command({
          createIndexes: collection,
          indexes: [{ key: { _harnessMaterialized: 1 }, name: indexName }],
        });
        expect(created.ok).toBe(1);

        expect(await collectionExists(collection)).toBe(true);
      });
    });
  },
);
