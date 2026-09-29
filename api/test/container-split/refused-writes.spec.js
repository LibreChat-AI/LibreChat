const mongoose = require('mongoose');

const { AUTH_READ_ONLY, describeContainerSplit, startProvisionedFixture } = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 2: The Auth_Surface's collection reach is exactly its grant —
 * bounded-above half, write side.
 *
 * `refused.spec.js` walks the reads outside the twelve; this suite walks the
 * writes inside the twelve that the grant withholds. The Container_1_Grant holds
 * `find` alone on its four read-only collections — `roles`, `configs`,
 * `systemgrants`, `banners` — so under that grant a read succeeds but every
 * write must be refused. This suite attempts `insert`, `update` and `remove`
 * against each of the four and asserts `mongod` refuses each with an
 * authorization error (code 13 / "not authorized"), and that the refusal leaves
 * the target document unchanged.
 *
 * Nothing here simulates an authorization error. The fixture runs
 * `mongodb-memory-server` with access control on, the credential is the real
 * collection-scoped role the unmodified `provision.mongo.js` created, and the
 * refusals are `mongod`'s — the same discipline `api/test/migration/harness.js`
 * sets out for itself.
 *
 * **The target is confirmed unchanged under the observer, not under the grant.**
 * Each collection holds a document the fixture root-seeded before any grant
 * applied (harness task 1.2): `{ _seededBy: 'harness-root', collection }`. A
 * re-read under the Container_1_Grant would succeed — the grant holds `find`
 * here — but so would a re-read after a write that the grant somehow let
 * through, so reading under the refusing credential proves nothing about whether
 * the write took. The observer credential is read-only, distinct from the
 * Container_1_Grant, and granted `find` on exactly these collections
 * (Requirement 3.9), so the observer's view of the seed is the independent
 * evidence that the refused write left no trace.
 *
 * **Validates: Requirements 3.7**
 *
 * Check: GRANT-DENY-WRITE-04
 */
describeContainerSplit(
  'GRANT-DENY-WRITE-04: writes to the four read-only collections are refused',
  () => {
    let fixture;
    /** A MongoClient authenticated under the Container_1_Grant. */
    let authClient;
    /** The read-only observer, distinct from the grant, used only to confirm state. */
    let observerClient;
    let authDb;
    let observerDb;

    beforeAll(async () => {
      fixture = await startProvisionedFixture();

      authClient = await MongoClient.connect(fixture.uriFor('auth'));
      observerClient = await MongoClient.connect(fixture.uriFor('observer'));

      authDb = authClient.db(fixture.dbName);
      observerDb = observerClient.db(fixture.dbName);
    }, 300_000);

    afterAll(async () => {
      await authClient?.close();
      await observerClient?.close();
      await fixture?.stop();
    });

    it('grants exactly the four expected read-only collections', () => {
      // Guards this spec against a silent change to the ownership matrix: if the
      // read-only set moves, the enumeration below stops covering it. Pins the set
      // the requirement names.
      expect(AUTH_READ_ONLY.slice().sort()).toEqual(
        ['banners', 'configs', 'roles', 'systemgrants'].sort(),
      );
    });

    /**
     * The root-seeded document every read-only collection carries, asserted so a
     * later "unchanged" check is anchored to a known starting state rather than to
     * whatever the collection happens to hold.
     */
    const seededDocument = (collection) => ({ _seededBy: 'harness-root', collection });

    describe.each(AUTH_READ_ONLY)('writing `%s` under the Container_1_Grant', (collection) => {
      /**
       * The observer's view of the collection before any write is attempted. Read
       * once in `beforeAll` so each refusal assertion below compares the target's
       * post-refusal state against the same recorded baseline rather than against a
       * fresh read that could itself have drifted.
       */
      let seededBefore;

      beforeAll(async () => {
        seededBefore = await observerDb.collection(collection).findOne({});
      });

      it('holds exactly the root-seeded document before any write', () => {
        // The starting state every refusal below is measured against: the single
        // document the fixture root-seeded, visible to the read-only observer.
        expect(seededBefore).not.toBeNull();
        expect(seededBefore).toMatchObject(seededDocument(collection));
      });

      /**
       * One attempted write per action, each run once in `beforeAll` so the two
       * facets of a single refusal — that it threw an authorization error, and
       * that it left the target unchanged — are read from the same operation
       * rather than from two writes that could diverge.
       */
      describe.each([
        [
          'insert',
          (db) =>
            db.collection(collection).insertOne({ _seededBy: 'harness-intruder', collection }),
        ],
        [
          'update',
          (db) =>
            db
              .collection(collection)
              .updateOne({ collection }, { $set: { _seededBy: 'harness-intruder' } }),
        ],
        ['remove', (db) => db.collection(collection).deleteOne({ collection })],
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
          // client-side guard. The message check keeps the assertion honest against
          // any error that merely happens to carry code 13.
          expect(error).toBeInstanceOf(mongoose.mongo.MongoServerError);
          expect(error.code).toBe(13);
          expect(error.codeName).toBe('Unauthorized');
          expect(error.message).toMatch(/not authorized/i);
          expect(error.message).toContain(collection);
        });

        it('leaves the root-seeded document unchanged under the observer credential', async () => {
          // Read under the observer, not the grant. A read under the Container_1_Grant
          // would succeed whether or not the write took, so it distinguishes nothing;
          // the observer is the independent witness that the refused write left the
          // seed exactly as it was.
          const after = await observerDb.collection(collection).find({}).toArray();

          expect(after).toHaveLength(1);
          expect(after[0]).toMatchObject(seededDocument(collection));
          // No intruder marker landed, from any of the three attempted writes.
          expect(after[0]._seededBy).toBe('harness-root');
          expect(after[0]._id).toEqual(seededBefore._id);
        });
      });
    });
  },
);
