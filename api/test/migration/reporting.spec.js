const { buildSeed, describeMigration, ids, startMigrationFixture } = require('./harness');

/**
 * Reads the number a labelled report line ends with, so an assertion pins the
 * label and its count without pinning the script's column padding.
 */
const reportedCount = (stdout, label) => {
  const line = stdout
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(label));

  if (line === undefined) {
    return undefined;
  }

  const match = line.match(/(-?\d+)\s*$/);
  return match === null ? undefined : Number(match[1]);
};

/**
 * Property 15: The auth token migration is idempotent and complete over the
 * classes it must move — reporting half.
 *
 * Asserts what the script tells the operator, against the text it actually
 * prints: the dry run's total and per-class breakdown alongside proof it wrote
 * nothing, and the applied run's inserted and already-present counts.
 *
 * The two halves need opposite starting states — one untouched database, one
 * with `authtokens` partly populated — so each runs against its own instance
 * rather than sharing one and depending on case order.
 *
 * **Validates: Requirements 9.11, 9.17**
 */
describeMigration('migrate-auth-tokens: reporting', () => {
  describe('with DRY_RUN set', () => {
    let fixture;
    let seed;
    let before;
    let after;
    let run;
    let stdout;

    beforeAll(async () => {
      fixture = await startMigrationFixture({ dbName: 'librechat_migration_report_dry' });
      seed = buildSeed();

      await fixture.seed(seed.all);
      before = await fixture.snapshot('tokens');

      run = fixture.runMigration({ dryRun: true });
      stdout = run.stdout;

      after = await fixture.snapshot('tokens');
    }, 180_000);

    afterAll(async () => {
      await fixture?.stop();
    });

    it('completes without error and announces the no-write mode', () => {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(stdout).toContain('DRY RUN (no writes)');
      expect(stdout).toContain('Dry run complete. No documents were written.');
    });

    it('reports the total count of selected documents', () => {
      expect(reportedCount(stdout, 'Eligible to move:')).toBe(seed.moving.length);
    });

    it('reports the count left behind in `tokens` alongside it', () => {
      expect(reportedCount(stdout, 'Staying in tokens:')).toBe(seed.staying.length);
    });

    it('breaks the total down by each selected `type` value', () => {
      expect(stdout).toContain('Breakdown:');
      expect(reportedCount(stdout, 'password_reset:')).toBe(1);
      expect(reportedCount(stdout, 'email_verification:')).toBe(1);
    });

    it('counts documents carrying no `type` field as their own class', () => {
      expect(reportedCount(stdout, 'invites (no type field):')).toBe(1);
    });

    it('counts documents whose `type` is null as their own class', () => {
      expect(reportedCount(stdout, 'legacy shape (type null):')).toBe(1);
    });

    it('accounts for every selected document across the named classes', () => {
      const classes = [
        'password_reset:',
        'email_verification:',
        'invites (no type field):',
        'legacy shape (type null):',
      ].map((label) => reportedCount(stdout, label));

      expect(classes.reduce((sum, count) => sum + count, 0)).toBe(
        reportedCount(stdout, 'Eligible to move:'),
      );
      expect(stdout).not.toContain('other / unrecognized');
    });

    it('reports no copy progress and no completion counts', () => {
      expect(stdout).not.toContain('Copying...');
      expect(stdout).not.toContain('processed (inserted');
      expect(stdout).not.toMatch(/^Done\./m);
    });

    it('inserts no document into `authtokens`', async () => {
      expect(await fixture.target.countDocuments({})).toBe(0);
      expect(await fixture.db.listCollections({ name: 'authtokens' }).toArray()).toEqual([]);
    });

    it('modifies no document in `tokens`', () => {
      expect(after).toEqual(before);
      expect(ids(after)).toEqual(ids(seed.all));
    });
  });

  describe('with DRY_RUN unset', () => {
    let fixture;
    let seed;
    let preexisting;
    let before;
    let after;
    let run;
    let stdout;

    beforeAll(async () => {
      fixture = await startMigrationFixture({ dbName: 'librechat_migration_report_apply' });
      seed = buildSeed();
      /** Two of the four selected documents are already at the target, so one run reports both counts. */
      preexisting = seed.moving.slice(0, 2);

      await fixture.seed(seed.all);
      await fixture.target.insertMany(preexisting.map((doc) => ({ ...doc })));
      before = await fixture.snapshot('tokens');

      run = fixture.runMigration();
      stdout = run.stdout;

      after = await fixture.snapshot('tokens');
    }, 180_000);

    afterAll(async () => {
      await fixture?.stop();
    });

    it('completes without error in apply mode', () => {
      expect(run.status).toBe(0);
      expect(run.stderr).toBe('');
      expect(stdout).toContain('mode:     apply');
      expect(stdout).toContain('Copying...');
    });

    it('reports the inserted count and the already-present count on completion', () => {
      expect(stdout).toContain('Done. Inserted 2, left untouched 2.');
    });

    it('reports the same split while copying, against the selected total', () => {
      expect(stdout).toContain('4 / 4 processed (inserted 2, already present 2)');
    });

    it('reports counts that sum to the total it selected', async () => {
      expect(reportedCount(stdout, 'Eligible to move:')).toBe(seed.moving.length);
      expect(await fixture.target.countDocuments({})).toBe(seed.moving.length);
    });

    it('modifies no document in `tokens` while reporting', () => {
      expect(after).toEqual(before);
      expect(ids(after)).toEqual(ids(seed.all));
    });
  });
});
