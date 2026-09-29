const {
  SOURCE,
  TARGET,
  buildSeed,
  describeMigration,
  ids,
  startRestrictedFixture,
} = require('./harness');

/**
 * Property 15: The auth token migration is idempotent and complete over the
 * classes it must move — refused-operation half.
 *
 * Runs `scripts/container-split/migrate.mongo.js` under two real MongoDB
 * credentials on an `--auth` instance: one that cannot read `tokens`, and one
 * that can read `tokens` but cannot write `authtokens`. Each must stop, report
 * the refused operation, leave what an earlier run already copied in
 * `authtokens`, and leave every `tokens` document in place.
 *
 * The two halves are checked in one fixture rather than two so both credentials
 * observe the same seeded state, and so the second half's "already copied"
 * documents are the same documents the first half must also leave alone.
 *
 * The read-refused credential fails before reaching the write, and the
 * write-refused credential holds read on both collections, so each refusal is
 * pinned to the operation the case is named for rather than to whichever
 * privilege happened to be missing first.
 *
 * **Validates: Requirements 9.16**
 */
describeMigration('migrate-auth-tokens: refused operations', () => {
  let fixture;
  let seed;

  /** What an earlier, interrupted run had already copied before the credential changed. */
  let alreadyCopied;
  let sourceBefore;
  let targetBefore;

  const cases = [
    {
      name: 'a credential that cannot read `tokens`',
      grant: 'noSourceRead',
      collection: SOURCE,
      reachedBreakdown: false,
    },
    {
      name: 'a credential that cannot write `authtokens`',
      grant: 'noTargetWrite',
      collection: TARGET,
      reachedBreakdown: true,
    },
  ];

  const runs = {};

  beforeAll(async () => {
    fixture = await startRestrictedFixture();
    seed = buildSeed();
    alreadyCopied = seed.moving.slice(0, 2);

    await fixture.seed(seed.all);
    await fixture.seedTarget(alreadyCopied);

    sourceBefore = await fixture.snapshot(SOURCE);
    targetBefore = await fixture.snapshot(TARGET);

    for (const { grant } of cases) {
      runs[grant] = fixture.runMigrationAs(grant);
    }
  }, 300_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it('seeds `authtokens` with a strict subset of what the migration would copy', () => {
    expect(ids(targetBefore)).toEqual(ids(alreadyCopied));
    expect(alreadyCopied).toHaveLength(2);
    expect(seed.moving).toHaveLength(4);
  });

  describe.each(cases)('under $name', ({ grant, collection, reachedBreakdown }) => {
    it('stops with a nonzero exit status', () => {
      expect(runs[grant].status).not.toBe(0);
    });

    it('reports an authorization error naming the refused operation', () => {
      const { stderr } = runs[grant];

      expect(stderr).toMatch(/not authorized/i);
      /** Quoted, because the unquoted source name is a substring of the target name. */
      expect(stderr).toContain(`"${collection}"`);
    });

    it('reaches only the phase its grant permits', () => {
      const { stdout } = runs[grant];

      expect(stdout).toContain('Auth token relocation: tokens -> authtokens');
      expect(stdout.includes('Breakdown:')).toBe(reachedBreakdown);
      expect(stdout).not.toContain('Done. Inserted');
    });
  });

  it('leaves already-copied documents in `authtokens`, unchanged and undeduplicated', async () => {
    const target = await fixture.snapshot(TARGET);

    expect(target).toEqual(targetBefore);
    expect(ids(target)).toEqual(ids(alreadyCopied));

    for (const doc of alreadyCopied) {
      expect(await fixture.target.findOne({ _id: doc._id })).toEqual(doc);
    }
  });

  it('copies nothing further into `authtokens`', async () => {
    const uncopied = seed.moving.slice(2);

    for (const doc of uncopied) {
      expect(await fixture.target.findOne({ _id: doc._id })).toBeNull();
    }
    expect(await fixture.target.countDocuments({})).toBe(alreadyCopied.length);
  });

  it('leaves every `tokens` document in place', async () => {
    const source = await fixture.snapshot(SOURCE);

    expect(source).toEqual(sourceBefore);
    expect(ids(source)).toEqual(ids(seed.all));

    for (const doc of seed.all) {
      expect(await fixture.source.findOne({ _id: doc._id })).toEqual(doc);
    }
  });
});
