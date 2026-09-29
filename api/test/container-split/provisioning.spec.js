const {
  ADMIN_DB,
  ROOT_USER,
  credentialedUri,
  describeContainerSplit,
  generatePassword,
  runProvision,
  startProvisionedFixture,
} = require('./harness');

/**
 * The provisioning script's own guards — the `admin`-connection refusal and the
 * equal-password refusal.
 *
 * `scripts/container-split/provision.mongo.js` scopes every privilege to the
 * connected database via `db.getName()`. Two of its guards keep that scoping
 * honest, and both throw before anything is written:
 *
 *   - **The `admin`-connection guard.** Run against `admin`, `db.getName()`
 *     resolves to `admin`, so every privilege would name a collection on the
 *     credential database rather than on LibreChat's — a database-wide grant in
 *     effect. The script refuses outright.
 *   - **The equal-password guard.** Each credential is meant for exactly one
 *     container, so provisioning both with the same password is refused.
 *
 * The Layer B runner refuses equal passwords before its own spawn, because
 * failing in the runner gives a clearer message than parsing the script's
 * throw. Exercising the script's *own* refusal here is what keeps that guard
 * tested rather than merely avoided (Property 9: setup failure is not property
 * falsification — both refusals are the script classifying a bad invocation
 * before it provisions).
 *
 * Nothing simulates a failure. `mongod` runs with access control on, the script
 * is the unmodified one under test (NG2), and each refusal is the script's own
 * `throw`, surfaced by `mongosh` as a non-zero exit with the message on stderr.
 *
 * **Validates: Requirements 2.5, 2.6, 2.8**
 *
 * Checks: PROVISION-ADMIN-08, PROVISION-PW-09
 */
describeContainerSplit('provision.mongo.js guards', () => {
  let fixture;

  beforeAll(async () => {
    fixture = await startProvisionedFixture();
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /**
   * The same live mongod and root credential the fixture provisioned against,
   * re-pointed at the `admin` database as its default. `credentialedUri` sets
   * the credential and `authSource`; the default database lives in the URL
   * path, so it is swapped to `admin` here rather than through that helper.
   *
   * A run against this URI is what would produce the database-wide grant the
   * script exists to refuse: `db.getName()` would resolve to `admin`.
   */
  const adminTargetedRootUri = () => {
    const url = new URL(fixture.baseUri);
    url.pathname = `/${ADMIN_DB}`;
    return credentialedUri(url.toString(), {
      user: ROOT_USER,
      password: fixture.rootPassword,
      authSource: ADMIN_DB,
    });
  };

  describe('PROVISION-ADMIN-08: refuses a run connected to `admin`', () => {
    let run;

    beforeAll(() => {
      /**
       * Two distinct passwords, so the refusal here is pinned to the
       * `admin`-connection guard and cannot be the equal-password guard firing
       * first. The `admin` guard runs before the password checks in any case,
       * but keeping the passwords distinct removes the ambiguity entirely.
       */
      run = runProvision(adminTargetedRootUri(), {
        authPassword: generatePassword(),
        apiPassword: generatePassword(),
      });
    }, 300_000);

    it('exits non-zero', () => {
      expect(run.status).not.toBe(0);
    });

    it('names the admin-connection guard on stderr', () => {
      expect(run.stderr).toMatch(/Refusing to provision/i);
      expect(run.stderr).toContain(ADMIN_DB);
      expect(run.stderr).toMatch(/connect to the LibreChat database/i);
    });

    it('emits no success completion signal', () => {
      expect(run.stdout).not.toContain('Done.');
    });
  });

  describe('PROVISION-PW-09: refuses equal auth-surface and API passwords', () => {
    let run;
    let sharedPassword;

    beforeAll(() => {
      sharedPassword = generatePassword();
      /**
       * Targets the LibreChat database, not `admin`, so the equal-password
       * guard is the only one that can fire — a run against `admin` would be
       * refused by the earlier guard and prove nothing about this one.
       */
      run = fixture.runProvision({
        authPassword: sharedPassword,
        apiPassword: sharedPassword,
      });
    }, 300_000);

    it('exits non-zero', () => {
      expect(run.status).not.toBe(0);
    });

    it('names the shared-password rejection on stderr', () => {
      expect(run.stderr).toMatch(/Refusing to provision/i);
      expect(run.stderr).toMatch(/must not share a password/i);
    });

    it('emits no success completion signal', () => {
      expect(run.stdout).not.toContain('Done.');
    });
  });
});
