const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');

const { buildSeed, describeMigration, ids, startMigrationFixture } = require('./harness');

const { ObjectId } = mongoose.mongo;

const day = 86_400_000;

/**
 * Push every `expiresAt` past the end of the run while keeping the values
 * distinct per document. Once the models register, the schema's TTL index on
 * `expiresAt` is live on both collections, and an already-expired fixture would
 * be swept out from under the assertions by the server's TTL monitor.
 */
const pending = (documents) => {
  const base = Date.now();
  return documents.map((doc, index) => ({ ...doc, expiresAt: new Date(base + (index + 1) * day) }));
};

const findById = (documents, id) => documents.find((doc) => doc._id.toString() === id.toString());

const ttlIndex = (indexes) => indexes.find(({ key }) => key.expiresAt === 1);

/**
 * Property 15: The auth token migration is idempotent and complete over the
 * classes it must move — idempotence and resume half.
 *
 * Each block drives the real `scripts/container-split/migrate.mongo.js` through
 * `mongosh` against its own ephemeral database, so what is asserted is the
 * script's `$setOnInsert` upsert rather than a reimplementation of it.
 *
 * Selection and non-destructiveness (9.3–9.6, 9.9) are asserted in
 * `selection.spec.js`; reporting (9.11, 9.17) and refused operations (9.16)
 * extend the same harness in their own files.
 *
 * **Validates: Requirements 9.7, 9.8, 9.10, 9.15**
 */
describeMigration('migrate-auth-tokens: an `_id` already present in `authtokens`', () => {
  let fixture;
  let seed;
  let claimed;
  let run;
  let before;
  let after;
  let migrated;

  beforeAll(async () => {
    fixture = await startMigrationFixture({ dbName: 'librechat_migration_claimed' });
    seed = buildSeed();

    await fixture.seed(seed.all);

    /**
     * What the application writes to `authtokens` after the upgrade: the same
     * `_id` as a selected source document, every other field different, one
     * field the source carries omitted (`identifier`) and one the source lacks
     * added (`tenantId`). A copy that overwrote, merged, or filled in fields
     * would show up as any of those three differences.
     */
    claimed = {
      _id: seed.moving[0]._id,
      userId: new ObjectId(),
      email: 'rewritten@example.com',
      token: 'application-written-token',
      type: 'password_reset',
      createdAt: new Date('2024-06-01T00:00:00.000Z'),
      expiresAt: new Date('2024-06-01T02:00:00.000Z'),
      tenantId: 'tenant-a',
    };
    await fixture.target.insertOne({ ...claimed });

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

  it('leaves every field of the existing document unchanged', async () => {
    expect(await fixture.target.findOne({ _id: claimed._id })).toEqual(claimed);
  });

  it('inserts no additional document for that `_id`', async () => {
    expect(await fixture.target.countDocuments({ _id: claimed._id })).toBe(1);
    expect(ids(migrated)).toEqual(ids(seed.moving));
    expect(migrated).toHaveLength(seed.moving.length);
  });

  it('holds the existing document rather than the source document for that `_id`', () => {
    const source = findById(seed.all, claimed._id);

    expect(findById(migrated, claimed._id)).not.toEqual(source);
    expect(source.token).toBe('hashed-password-reset-token');
  });

  it('copies the selected documents whose `_id` was absent, unchanged', () => {
    for (const doc of seed.moving.slice(1)) {
      expect(findById(migrated, doc._id)).toEqual(doc);
    }
  });

  it('leaves the source document for that `_id` in `tokens`, and `tokens` untouched', () => {
    expect(findById(after, claimed._id)).toEqual(findById(seed.all, claimed._id));
    expect(after).toEqual(before);
    expect(after).toHaveLength(seed.all.length);
  });
});

describeMigration('migrate-auth-tokens: a second run', () => {
  let fixture;
  let seed;
  let firstRun;
  let secondRun;
  let firstMigrated;
  let secondMigrated;
  let firstSource;
  let secondSource;

  beforeAll(async () => {
    fixture = await startMigrationFixture({ dbName: 'librechat_migration_rerun' });
    seed = buildSeed();

    await fixture.seed(seed.all);

    firstRun = fixture.runMigration();
    firstMigrated = await fixture.snapshot('authtokens');
    firstSource = await fixture.snapshot('tokens');

    secondRun = fixture.runMigration();
    secondMigrated = await fixture.snapshot('authtokens');
    secondSource = await fixture.snapshot('tokens');
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('completes without error both times', () => {
    expect(firstRun.status).toBe(0);
    expect(firstRun.stderr).toBe('');
    expect(secondRun.status).toBe(0);
    expect(secondRun.stderr).toBe('');
  });

  it('leaves `authtokens` holding the same `_id` set with the same field values', () => {
    expect(secondMigrated).toEqual(firstMigrated);
    expect(ids(secondMigrated)).toEqual(ids(seed.moving));
  });

  it('inserts no duplicate on the second run', () => {
    expect(secondMigrated).toHaveLength(seed.moving.length);
  });

  it('leaves `tokens` unchanged across both runs', () => {
    expect(secondSource).toEqual(firstSource);
    expect(ids(secondSource)).toEqual(ids(seed.all));
  });
});

/**
 * An interrupted run leaves `tokens` whole and `authtokens` holding the subset
 * it had copied when it stopped. The script reads only the current state of the
 * two collections, so that state is reproduced here by running the script over
 * the subset the interrupted run had reached and then adding the documents it
 * had not: at the second run's start, `tokens` holds all eight documents and
 * `authtokens` holds two script-written copies, which is the post-interruption
 * state exactly. Killing a real run mid-batch would produce the same state
 * non-deterministically.
 */
describeMigration('migrate-auth-tokens: a run resumed after an interruption', () => {
  let fixture;
  let seed;
  let reached;
  let remaining;
  let interruptedRun;
  let resumedRun;
  let copiedBeforeInterruption;
  let migrated;
  let source;

  beforeAll(async () => {
    fixture = await startMigrationFixture({ dbName: 'librechat_migration_resume' });
    seed = buildSeed();
    reached = seed.moving.slice(0, 2);
    remaining = seed.moving.slice(2);

    await fixture.seed([...reached, ...seed.staying]);
    interruptedRun = fixture.runMigration();
    copiedBeforeInterruption = await fixture.snapshot('authtokens');

    await fixture.seed(remaining);
    resumedRun = fixture.runMigration();
    migrated = await fixture.snapshot('authtokens');
    source = await fixture.snapshot('tokens');
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  /*
   * The title it shares is in a different suite. `describeMigration` is an
   * imported binding, so eslint-plugin-jest cannot see it as a `describe` and
   * reads this suite's tests as siblings of the earlier suite's.
   */
  // eslint-disable-next-line jest/no-identical-title
  it('completes without error', () => {
    expect(interruptedRun.status).toBe(0);
    expect(interruptedRun.stderr).toBe('');
    expect(resumedRun.status).toBe(0);
    expect(resumedRun.stderr).toBe('');
  });

  it('starts from a target holding only the documents the interrupted run had copied', () => {
    expect(ids(copiedBeforeInterruption)).toEqual(ids(reached));
  });

  it('copies the selected documents the interrupted run had not yet copied', () => {
    for (const doc of remaining) {
      expect(findById(migrated, doc._id)).toEqual(doc);
    }
  });

  it('leaves the documents it had already copied unchanged', () => {
    for (const doc of copiedBeforeInterruption) {
      expect(findById(migrated, doc._id)).toEqual(doc);
    }
  });

  it('converges on the full selection with no duplicate', () => {
    expect(ids(migrated)).toEqual(ids(seed.moving));
    expect(migrated).toHaveLength(seed.moving.length);
  });

  it('leaves every `tokens` document in place', () => {
    expect(ids(source)).toEqual(ids(seed.all));
    expect(source).toEqual(
      [...seed.all].sort((a, b) => (a._id.toString() < b._id.toString() ? -1 : 1)),
    );
  });
});

describeMigration('migrate-auth-tokens: before and after model registration', () => {
  let unregistered;
  let registered;
  let documents;
  let seed;
  let unregisteredRun;
  let registeredRun;
  let unregisteredMigrated;
  let registeredMigrated;
  let unregisteredIndexes;
  let registeredIndexes;

  beforeAll(async () => {
    seed = buildSeed();
    documents = pending(seed.all);

    unregistered = await startMigrationFixture({ dbName: 'librechat_migration_unregistered' });
    await unregistered.seed(documents);
    unregisteredRun = unregistered.runMigration();
    unregisteredMigrated = await unregistered.snapshot('authtokens');
    unregisteredIndexes = await unregistered.target.indexes();

    registered = await startMigrationFixture({ dbName: 'librechat_migration_registered' });
    /**
     * What starting the upgraded containers does to the database: the models
     * register, which creates both collections and builds the schema's TTL
     * index on `expiresAt`.
     *
     * Every model's `init()` is awaited, not just the two token models, so the
     * whole set's index builds have settled before `mongosh` connects. Builds
     * still in flight leave the server busy enough to lose `mongosh`'s server
     * selection, which would fail the run for a reason that has nothing to do
     * with the state under test.
     */
    await mongoose.connect(registered.uri);
    const models = createModels(mongoose);
    await Promise.all(Object.values(models).map((model) => model.init()));
    registeredIndexes = await registered.target.indexes();

    await registered.seed(documents);
    registeredRun = registered.runMigration();
    registeredMigrated = await registered.snapshot('authtokens');
  }, 240_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await unregistered?.stop();
    await registered?.stop();
  });

  it('completes without error in both orders', () => {
    expect(unregisteredRun.status).toBe(0);
    expect(unregisteredRun.stderr).toBe('');
    expect(registeredRun.status).toBe(0);
    expect(registeredRun.stderr).toBe('');
  });

  it('runs against a registered `authtokens` that already carries the TTL index', () => {
    expect(ttlIndex(registeredIndexes)).toMatchObject({ expireAfterSeconds: 0 });
    expect(ttlIndex(unregisteredIndexes)).toBeUndefined();
  });

  it('produces the same `_id` set in `authtokens` either way', () => {
    expect(ids(registeredMigrated)).toEqual(ids(unregisteredMigrated));
    expect(ids(registeredMigrated)).toEqual(ids(seed.moving));
  });

  it('produces the same field values for every `_id` either way', () => {
    expect(registeredMigrated).toEqual(unregisteredMigrated);
    for (const doc of documents.filter(({ _id }) => findById(seed.moving, _id))) {
      expect(findById(registeredMigrated, doc._id)).toEqual(doc);
    }
  });

  it('leaves `tokens` holding every seeded document either way', async () => {
    expect(ids(await unregistered.snapshot('tokens'))).toEqual(ids(documents));
    expect(ids(await registered.snapshot('tokens'))).toEqual(ids(documents));
  });
});
