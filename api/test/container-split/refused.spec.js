const mongoose = require('mongoose');

const {
  OBSERVER_OUT_OF_GRANT,
  describeContainerSplit,
  startProvisionedFixture,
} = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 2: The Auth_Surface's collection reach is exactly its grant —
 * bounded-above half, read side.
 *
 * The Container_1_Grant enumerates exactly the twelve collections of the
 * ownership matrix. This suite exercises the boundary from outside it: under
 * that grant it reads each of the five collections the grant does not name —
 * `conversations`, `messages`, `files`, `tokens`, `keys` — and asserts `mongod`
 * refuses each read with an authorization error, that the refusal yields no
 * document, and that the error is the server's own (code 13 / "not authorized").
 *
 * Nothing here simulates an authorization error. The fixture runs
 * `mongodb-memory-server` with access control on, the credential is the real
 * collection-scoped role the unmodified `provision.mongo.js` created, and the
 * refusals are `mongod`'s — the same discipline `api/test/migration/harness.js`
 * sets out for itself.
 *
 * Each target holds a document the fixture root-seeded before any grant applied
 * (harness task 1.2), so "returns no document" is a consequence of the refusal
 * rather than of an empty collection (Property 6). The observer credential —
 * read-only and distinct from the Container_1_Grant — reads the same collections
 * to confirm the seed is present, so a refused read under the grant is
 * distinguishable from an empty collection under any credential.
 *
 * **Validates: Requirements 3.6**
 *
 * Check: GRANT-DENY-READ-03
 */
describeContainerSplit('GRANT-DENY-READ-03: reads outside the twelve are refused', () => {
  let fixture;
  let authClient;
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

  describe.each(OBSERVER_OUT_OF_GRANT)('reading `%s` under the Container_1_Grant', (collection) => {
    /**
     * The single `find` attempt every assertion below reads from. Run once in
     * `beforeAll` so the three facets of one refusal — that it threw, that it
     * threw an authorization error, and that it produced no document — are read
     * from the same operation rather than from three separate reads that could
     * diverge.
     */
    let error;
    let returned;

    beforeAll(async () => {
      error = undefined;
      returned = undefined;
      try {
        returned = await authDb.collection(collection).findOne({});
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

    it('returns no document', () => {
      // A consequence of the refusal: the `find` threw before yielding a value,
      // so nothing was returned even though the collection holds a root-seeded
      // document (confirmed below under the observer).
      expect(returned).toBeUndefined();
    });

    it('leaves the root-seeded document readable under the observer credential', async () => {
      const seeded = await observerDb.collection(collection).findOne({});

      expect(seeded).not.toBeNull();
      expect(seeded).toMatchObject({ _seededBy: 'harness-root', collection });
    });
  });
});
