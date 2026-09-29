const mongoose = require('mongoose');

const {
  ADMIN_DB,
  AUTH_USER_NAME,
  API_USER_NAME,
  describeContainerSplit,
  startProvisionedFixture,
} = require('./harness');

const { MongoClient } = mongoose.mongo;

/**
 * Property 9 (Layer A slice): a missing or wrong `authSource` is a configuration
 * defect the harness must be able to name, not a grant defect.
 *
 * `provision.mongo.js` creates both roles and both users on `admin`, while every
 * privilege names the LibreChat database. Authentication resolves the *user*
 * against `authSource`; authorization then resolves the *privileges* against the
 * databases the role names. So the two databases play distinct roles, and a
 * `MONGO_URI` that carries `authSource=admin` authenticates against the database
 * the users actually live on, while a URI that omits `authSource` — or sets it to
 * the LibreChat database — authenticates against a database that holds no such
 * user and fails.
 *
 * This suite fixes both halves for each provisioned credential:
 *
 *   - **With `authSource=admin`, authentication succeeds.** The fixture's
 *     `uriFor(...)` already carries `authSource=admin`, so a `ping` under it
 *     returns `{ ok: 1 }`.
 *   - **Without `authSource` (default database), authentication fails** with a
 *     `MongoServerError` whose code is 18 / `AuthenticationFailed` — the same
 *     error a wrong password produces. That collision is the point: a URI missing
 *     `authSource` is indistinguishable at the wire from a bad credential, which
 *     is precisely what makes it a trap. Naming that failure mode here is what
 *     lets `MONGO-URI-19` and NC5 report a missing-or-wrong `authSource` as an
 *     authentication-source defect in Layer B rather than as a mysterious
 *     wrong-password error.
 *
 * Nothing here simulates a failure. The fixture runs `mongodb-memory-server` with
 * access control on, both credentials are the real collection-scoped users the
 * unmodified `provision.mongo.js` created (NG2), and the authentication failure is
 * `mongod`'s own — the same discipline the sibling suites set out for themselves.
 *
 * **Validates: Requirements 2.5, 2.6**
 *
 * Check: PROVISION-AUTHSOURCE-11
 */
describeContainerSplit('PROVISION-AUTHSOURCE-11: both credentials require authSource=admin', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * The fixture's `baseUri` carries the LibreChat database in its path and no
   * credential. Layering the grant's user and password on without ever setting
   * `authSource` produces exactly the mistaken URI Requirement 2.6 guards
   * against: the driver defaults `authSource` to the URI's default database — the
   * LibreChat database — where neither provisioned user exists.
   */
  const uriWithoutAuthSource = ({ user, password }) => {
    const url = new URL(fixture.baseUri);
    url.username = encodeURIComponent(user);
    url.password = encodeURIComponent(password);
    return url.toString();
  };

  /**
   * The two provisioned credentials, driven through one table so the auth-surface
   * grant and the API-container grant are each held to both halves of the property
   * rather than one standing in for the other.
   */
  const CREDENTIALS = [
    { label: 'auth-surface (Container_1_Grant)', name: 'auth', user: AUTH_USER_NAME },
    { label: 'API-container (Container_2_Grant)', name: 'api', user: API_USER_NAME },
  ];

  describe.each(CREDENTIALS)('$label', ({ name, user }) => {
    describe(`with authSource=${ADMIN_DB}`, () => {
      let client;
      let pingResult;
      let pingError;

      beforeAll(async () => {
        pingError = undefined;
        pingResult = undefined;
        // `uriFor` already carries `authSource=admin` (harness `credentialedUri`).
        client = new MongoClient(fixture.uriFor(name));
        try {
          await client.connect();
          pingResult = await client.db(fixture.dbName).command({ ping: 1 });
        } catch (caught) {
          pingError = caught;
        }
      }, 300_000);

      afterAll(async () => {
        await client?.close();
      });

      it('authenticates successfully', () => {
        expect(pingError).toBeUndefined();
      });

      it('answers a ping', () => {
        expect(pingResult).toMatchObject({ ok: 1 });
      });
    });

    describe('without authSource (defaults to the LibreChat database)', () => {
      let client;
      let error;

      beforeAll(async () => {
        error = undefined;
        client = new MongoClient(
          uriWithoutAuthSource({ user, password: fixture[`${name}Password`] }),
        );
        try {
          await client.connect();
          // Reached only if authentication did not fail; the command forces a
          // round-trip so a lazily-connected driver cannot mask the failure.
          await client.db(fixture.dbName).command({ ping: 1 });
        } catch (caught) {
          error = caught;
        }
      }, 300_000);

      afterAll(async () => {
        await client?.close();
      });

      it('fails to authenticate', () => {
        expect(error).toBeDefined();
        expect(error).toBeInstanceOf(mongoose.mongo.MongoServerError);
      });

      it('reports an authentication failure (the wrong-password failure mode, code 18)', () => {
        // Code 18 / AuthenticationFailed is `mongod`'s own error, identical to
        // the one a wrong password yields. This is the failure mode
        // `MONGO-URI-19` and NC5 must recognize and attribute to a missing or
        // wrong `authSource` in Layer B rather than to a bad credential.
        expect(error.code).toBe(18);
        expect(error.codeName).toBe('AuthenticationFailed');
        expect(error.message).toMatch(/[Aa]uthentication failed/);
      });
    });
  });
});
