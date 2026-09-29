const {
  OAUTH_TYPES,
  buildSeed,
  describeMigration,
  ids,
  startMigrationFixture,
} = require('./harness');

/**
 * Property 15: The auth token migration is idempotent and complete over the
 * classes it must move — selection half.
 *
 * Seeds `tokens` with one document of each class that must move and one of each
 * of the four OAuth types that must stay, runs
 * `scripts/container-split/migrate.mongo.js`, and compares both collections against
 * the expected partition.
 *
 * Only the selection and non-destructiveness halves of P15 are asserted here.
 * Idempotence and resume (9.7, 9.8, 9.15), reporting (9.11, 9.17), and refused
 * operations (9.16) extend the same harness in their own files.
 *
 * **Validates: Requirements 9.3, 9.4, 9.5, 9.6, 9.9**
 */
describeMigration('migrate-auth-tokens: selection', () => {
  let fixture;
  let seed;
  let before;
  let after;
  let migrated;
  let run;

  const sourceById = (id) => seed.all.find((doc) => doc._id.toString() === id);
  const migratedById = (id) => migrated.find((doc) => doc._id.toString() === id);

  beforeAll(async () => {
    fixture = await startMigrationFixture();
    seed = buildSeed();

    await fixture.seed(seed.all);
    before = await fixture.snapshot('tokens');

    run = fixture.runMigration();

    after = await fixture.snapshot('tokens');
    migrated = await fixture.snapshot('authtokens');
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('completes without error', () => {
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });

  it('copies exactly the documents whose `type` is none of the four OAuth types', () => {
    expect(ids(migrated)).toEqual(ids(seed.moving));
    expect(migrated).toHaveLength(4);
  });

  it('carries over `_id` and every other field unchanged', () => {
    for (const id of ids(seed.moving)) {
      expect(migratedById(id)).toEqual(sourceById(id));
    }
  });

  it('copies the `password_reset` and `email_verification` documents', () => {
    const types = migrated.map(({ type }) => type);
    expect(types).toContain('password_reset');
    expect(types).toContain('email_verification');
  });

  it('copies an invite document that carries no `type` field, leaving the field absent', () => {
    const invite = migratedById(seed.moving[2]._id.toString());

    expect(invite).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(invite, 'type')).toBe(false);
    expect(invite.token).toBe('hashed-invite-token');
  });

  it('copies a legacy document whose `type` is null, preserving the explicit null', () => {
    const legacy = migratedById(seed.moving[3]._id.toString());

    expect(legacy).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(legacy, 'type')).toBe(true);
    expect(legacy.type).toBeNull();
  });

  it('copies no document of any of the four OAuth types', async () => {
    expect(migrated.map(({ type }) => type).filter((type) => OAUTH_TYPES.includes(type))).toEqual(
      [],
    );
    expect(await fixture.target.countDocuments({ type: { $in: OAUTH_TYPES } })).toBe(0);
  });

  it('leaves each OAuth document in `tokens` only', async () => {
    for (const doc of seed.staying) {
      expect(await fixture.source.findOne({ _id: doc._id })).toEqual(doc);
      expect(await fixture.target.findOne({ _id: doc._id })).toBeNull();
    }
  });

  it('deletes and modifies no `tokens` document', () => {
    expect(after).toEqual(before);
    expect(after).toHaveLength(seed.all.length);
    expect(ids(after)).toEqual(ids(seed.all));
  });
});
