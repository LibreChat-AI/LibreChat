import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run, staticChecks } from './lint.helpers';

/**
 * `eslint-suppressions.json` records what the tree already owed when the design
 * rules landed, as a count per file and rule. What a contributor meets is one
 * scenario each: the commit that FIXES one of those violations must not be
 * rejected for leaving the count too high; a file move must not leave the old
 * path silencing a future file that reuses it; a count edit must be read even
 * when it rides along with a source change; a change to what the rules read must
 * revalidate counts in files it never touches; an inline comment must not be a
 * way to silence a design rule; a record that no longer says what it claims must
 * be rejected; and the command that writes the record must build the primitives
 * it records against. None of them needs the browser: each runs the configured
 * command and reads what it does.
 */

type Suppressions = Record<string, Record<string, { count: number }>>;
const SUPPRESSIONS_FILE = 'eslint-suppressions.json';
const suppressionsPath = resolve(repoRoot, SUPPRESSIONS_FILE);
const ESLINT = resolve(repoRoot, 'node_modules/.bin/eslint');

const readBaseline = (): Suppressions =>
  JSON.parse(readFileSync(suppressionsPath, 'utf8')) as Suppressions;

/** A scratch baseline in its own directory; ESLint and the runner both take a
 *  baseline's location as an argument, so nothing here writes into the tree. */
function writeBaseline(content: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'lc-suppressions-')), SUPPRESSIONS_FILE);
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
  return path;
}

/** lint-staged's config is CommonJS, so it is loaded the way lint-staged loads
 *  it. Executing it is the point: the assertion is about the real commands. A
 *  task may be a function — that is how a command opts out of having the staged
 *  filenames appended — so each one is resolved the way lint-staged resolves
 *  it, with the staged list. */
type HookTask = string | ((files: string[]) => string | string[]);

const loadHookConfig = (path: string, staged: string[]): Record<string, string[]> => {
  const config = createRequire(__filename)(path) as Record<string, HookTask[]>;
  return Object.fromEntries(
    Object.entries(config).map(([pattern, tasks]) => [
      pattern,
      tasks.flatMap((task) => (typeof task === 'function' ? task(staged) : task)),
    ]),
  );
};

test.describe('the recorded design-rule backlog', () => {
  test('fixing a recorded violation keeps the configured lint runs green @scenario:fixing-a-recorded-violation-keeps-the-configured-lint-runs-green', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** Pick a real recorded file and claim one more violation than it has, which
     *  is the state a fix leaves behind until the counts are pruned. */
    const baseline = readBaseline();
    const [file, rules] = Object.entries(baseline)[0];
    const [rule, { count }] = Object.entries(rules)[0];
    const overCounted = writeBaseline({ [file]: { [rule]: { count: count + 1 } } });
    const baselineText = readFileSync(suppressionsPath, 'utf8');

    /** The real pre-commit commands, read by executing the hook's own config:
     *  a copy of the command list here would pass while the hook was broken.
     *  Only the direct ESLint invocations take a suppressions location; the
     *  hook's last task is the runner, asserted below. */
    const hook = loadHookConfig(resolve(repoRoot, '.husky/lint-staged.config.js'), [file]);
    const tasks = hook['*.{js,jsx,ts,tsx}'];

    /** The metadata build has to come before the fixing pass: run after it, a
     *  stale `packages/client/dist` is what the design rules classify against,
     *  and lint-staged stops at the first failure. */
    const buildAt = tasks.findIndex((command) => command.includes('build:client-package'));
    const fixAt = tasks.findIndex((command) => command.startsWith('eslint'));
    expect(buildAt, 'the hook no longer builds the design metadata').toBeGreaterThanOrEqual(0);
    expect(buildAt).toBeLessThan(fixAt);
    const commands = tasks.filter((command) => command.startsWith('eslint'));
    expect(commands.length).toBeGreaterThan(0);

    for (const command of commands) {
      const [, ...args] = command.split(' ');
      const green = run(ESLINT, [...args, '--suppressions-location', overCounted, '--', file]);
      expect(green.status, `${command} rejected the diff that fixed a recorded violation`).toBe(0);

      /** The counter-proof: the same command without the flag exits 2, so the
       *  flag is what keeps the fixing commit committable. */
      const withoutFlag = args.filter((arg) => arg !== '--pass-on-unpruned-suppressions');
      const red = run(ESLINT, [...withoutFlag, '--suppressions-location', overCounted, '--', file]);
      expect(red.status).toBe(2);
      expect(red.output).toContain('suppressions left that do not occur anymore');
    }

    /** And the hook's authoritative pass is the runner itself, so the commit and
     *  the lane read the same rules from the same metadata. */
    expect(
      tasks.some((command) => command.includes('static-checks.mts') && command.includes('--only')),
      'the hook no longer runs the CI mirror',
    ).toBe(true);

    /** The other half of the policy: the commit stays possible, and the lane
     *  then asks for the prune. Capacity a fix freed is capacity the next change
     *  could spend, so the suppressions check rejects a count higher than the
     *  file's violations and names the command that tightens it. */
    const slack = writeBaseline({ [file]: { [rule]: { count: count + 3 } } });
    const capacity = staticChecks([slack, '--only', 'suppressions']);
    expect(capacity.status, 'unused suppression capacity passed the lane').not.toBe(0);
    expect(capacity.output).toContain('would silence a later violation');
    expect(capacity.output).toContain('npm run lint:design:prune');

    /** The re-record has to survive the backlog it is recording. `--suppress-rule`
     *  names the design rules, but the run still reports every other rule in the
     *  roots, and those roots carry a pre-existing error backlog, so the
     *  re-record exits non-zero on a perfectly good write. What matters is that
     *  the write happened, which is why the documented chain does not gate the
     *  prune on that status. */
    const recorded = writeBaseline({});
    const debt = Object.keys(baseline).find((path) => path.endsWith('.tsx')) ?? file;
    const write = run(ESLINT, [
      '--no-warn-ignored',
      '--suppress-rule',
      rule,
      '--suppressions-location',
      recorded,
      '--',
      debt,
    ]);
    expect(existsSync(recorded), 'the re-record wrote no baseline').toBe(true);
    const written = JSON.parse(readFileSync(recorded, 'utf8')) as Suppressions;
    expect(Object.keys(written)).toContain(debt);
    /** Not asserted as an expected failure — a clean root would exit 0 — but the
     *  baseline above is written either way, and that is what the prune needs. */
    expect([0, 1]).toContain(write.status);

    /** And the repository's own baseline is exactly as it was: this scenario
     *  writes only into `os.tmpdir()`. */
    expect(readFileSync(suppressionsPath, 'utf8')).toBe(baselineText);
  });

  test('re-recording a moved file drops its old path @scenario:re-recording-a-moved-file-drops-its-old-path', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** Suppressions are keyed by path, so a move records the new path and leaves
     *  the old one behind; only the prune removes it. Chaining the two is what
     *  makes the documented move recipe complete, and the two halves are run
     *  below rather than read out of `package.json`: the re-record's write is
     *  asserted in the scenario above, and the prune's removal here. */

    const baseline = readBaseline();
    const recorded = Object.keys(baseline);
    const linted = recorded.find((path) => path.startsWith('client/src/a11y/')) ?? recorded[0];
    const directory = linted.slice(0, linted.lastIndexOf('/'));
    const outside = recorded.find((path) => !path.startsWith(`${directory}/`));
    if (!outside) {
      throw new Error('the baseline records only one directory; pick another fixture');
    }
    const phantom = `${directory}/ThisFileMovedAway.tsx`;
    expect(existsSync(resolve(repoRoot, phantom))).toBe(false);

    const scratch = writeBaseline({
      [linted]: baseline[linted],
      [phantom]: { 'shadcn/no-restyle': { count: 4 } },
      [outside]: baseline[outside],
    });

    const pruned = run(ESLINT, [
      '--no-warn-ignored',
      '--prune-suppressions',
      '--suppressions-location',
      scratch,
      directory,
    ]);
    expect(pruned.status, pruned.output).toBe(0);

    const after = JSON.parse(readFileSync(scratch, 'utf8')) as Suppressions;
    expect(after[phantom]).toBeUndefined();
    /** A file the prune never linted keeps its entry: the sweep removes paths,
     *  it does not silently rewrite counts for the rest of the tree. */
    expect(after[outside]).toEqual(baseline[outside]);
    expect(after[linted]).toEqual(baseline[linted]);
  });

  test('a count edit riding along with a recorded source is still read @scenario:a-count-edit-riding-along-with-a-recorded-source-is-rejected', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** A count edit is measured against `HEAD` when no range is given, which is
     *  the pre-commit case. Without that fallback a diff that also touches one
     *  recorded source would narrow the check to that source and let every other
     *  count edit through to CI, so the shape under test is the baseline passed
     *  alongside a recorded source. */
    const baseline = readBaseline();
    const caller = Object.keys(baseline).find((path) => path.startsWith('client/src/'));
    if (!caller) {
      throw new Error('the baseline records no client/src caller; pick another fixture');
    }
    const callerRule = Object.keys(baseline[caller])[0];
    const slack = writeBaseline({
      [caller]: { [callerRule]: { count: baseline[caller][callerRule].count + 4 } },
    });
    const recordedSource = Object.keys(baseline).find(
      (path) => path !== caller && path.startsWith('client/src/'),
    );
    if (!recordedSource) {
      throw new Error('the baseline records only one client/src file; pick another fixture');
    }

    const alongside = staticChecks([slack, recordedSource, '--only', 'suppressions']);
    expect(alongside.status, 'a count edit rode along with a recorded source').not.toBe(0);
    expect(alongside.output).toContain(caller);
    expect(alongside.output).toContain('would silence a later violation');

    /** And the commit reaches it on every path the lane does. A count edit
     *  touches no source file, so the hook's `*.{js,jsx,ts,tsx}` group never
     *  runs; a primitive decides what the rules report in callers nobody
     *  staged. Both arrive through the runner, which `.husky/pre-commit` runs
     *  over the staged diff after lint-staged, so what has to hold is that the
     *  runner selects this check on every path the lane's `suppressions`
     *  paths-filter names — asked of the runner, and read from the workflow
     *  rather than from a copy of it, so the two cannot drift apart silently. */
    const hookScript = readFileSync(resolve(repoRoot, '.husky/pre-commit'), 'utf8');
    expect(hookScript, 'the hook no longer runs the CI mirror over the staged diff').toContain(
      'scripts/static-checks.mts --skip eslint,prettier,imports',
    );

    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/static-checks.yml'), 'utf8');
    const lane = (workflow.split(/^ {12}suppressions:$/m)[1] ?? '')
      .split(/^ {12}\S/m)[0]
      .split('\n')
      .map((line) => /^ {14}- '([^']+)'$/.exec(line)?.[1])
      .filter((pattern): pattern is string => Boolean(pattern) && !pattern.startsWith('!'));
    expect(lane.length, 'the lane declares no suppressions filter').toBeGreaterThan(5);

    const unselected = lane.filter((pattern) => {
      const probe = pattern.replace('**/', 'packages/client/').replace('/**', '/Probe.tsx');
      const listed = staticChecks([probe, '--list', '--skip', 'eslint,prettier,imports']);
      return !/Design-rule suppressions.*would run/.test(listed.output);
    });
    expect(unselected, 'the runner does not select what the lane selects').toEqual([]);

    /** And the lane cannot select what the workflow never starts for: the
     *  trigger is a second path list, so a baseline the `suppressions` filter
     *  names — a nested one outside the source trees the trigger enumerates —
     *  can sit in a diff that runs no workflow at all, which is this gate
     *  advertising coverage CI never reaches. The runner owns that claim,
     *  because the file that breaks it is the workflow and this group is what a
     *  change to it runs; the mock lane's own trigger excludes
     *  `.github/workflows` apart from its own file, so an assertion living here
     *  would be absent from exactly the diff it guards.
     *
     *  Asked of the runner both ways, over a copy of the real workflow: as it
     *  stands, and with the nested-baseline pattern taken out of the trigger. */
    const parityRoot = syntheticRoot();
    const parityWorkflow = join(parityRoot, '.github/workflows/static-checks.yml');
    const parity = () =>
      run(
        process.execPath,
        [
          join(parityRoot, 'scripts/static-checks.mts'),
          'eslint.config.mjs',
          '--only',
          'suppressions',
        ],
        { cwd: parityRoot },
      ).output;
    const complaint = 'starts the workflow for';
    try {
      expect(
        parity(),
        'the committed workflow already disagrees with its own filter',
      ).not.toContain(complaint);

      /** A filter block ends at its first sibling. A neighbouring lane may
       *  name paths this workflow deliberately never starts for, and reading
       *  past the block's end would charge them to `suppressions` and fail a
       *  workflow that is correct. */
      const committed = readFileSync(parityWorkflow, 'utf8');
      const marker = /^ {12}suppressions:$/m.exec(committed);
      const after = committed.slice((marker?.index ?? 0) + (marker?.[0].length ?? 0));
      const sibling = /^ {12}\S/m.exec(after);
      expect(marker && sibling, 'the suppressions filter has no sibling to read past').toBeTruthy();
      const end = (marker?.index ?? 0) + (marker?.[0].length ?? 0) + (sibling?.index ?? 0);
      writeFileSync(
        parityWorkflow,
        `${committed.slice(0, end)}            neighbour:\n              - 'e2e/**'\n${committed.slice(end)}`,
      );
      expect(parity(), "a neighbouring lane's paths were charged to this one").not.toContain(
        complaint,
      );
      copyFileSync(resolve(repoRoot, '.github/workflows/static-checks.yml'), parityWorkflow);
      writeFileSync(
        parityWorkflow,
        readFileSync(parityWorkflow, 'utf8').replace(
          /^ {6}- '\*\*\/eslint-suppressions\.json'\n/m,
          '',
        ),
      );
      const drifted = parity();
      expect(drifted, 'a lane path the trigger never starts went unreported').toContain(complaint);
      expect(drifted).toContain('eslint-suppressions.json');
    } finally {
      rmSync(parityRoot, { force: true, recursive: true });
    }

    /** A rename is two paths, and selection is about both. Git's rename
     *  detection reports `git mv eslint-suppressions.json backlog.json` as the
     *  destination alone — a name no filter matches — so the group that owns
     *  the source never activates and the baseline's disappearance is reported
     *  by nothing until CI. Asked of the staged diff, which is the path the
     *  pre-commit hook takes. */
    const renameRoot = syntheticRoot();
    try {
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        [
          '-c',
          'user.email=scenario@librechat',
          '-c',
          'user.name=scenario',
          'commit',
          '-qm',
          'base',
        ],
        ['mv', SUPPRESSIONS_FILE, 'backlog.json'],
      ]) {
        const step = run('git', args, { cwd: renameRoot });
        expect(step.status, `git ${args[0]}: ${step.output}`).toBe(0);
      }
      const renamed = run(
        process.execPath,
        [join(renameRoot, 'scripts/static-checks.mts'), '--staged', '--only', 'suppressions'],
        { cwd: renameRoot },
      );
      expect(renamed.status, 'a renamed-away baseline was selected by nothing').not.toBe(0);
      expect(renamed.output).toContain(SUPPRESSIONS_FILE);
      expect(renamed.output).toContain('is missing');
    } finally {
      rmSync(renameRoot, { force: true, recursive: true });
    }

    /** And it is a selection, not a default: a path outside both roots is not. */
    const outside = staticChecks([
      'api/server/index.js',
      '--list',
      '--skip',
      'eslint,prettier,imports',
    ]);
    expect(outside.output).toMatch(/Design-rule suppressions.*not affected/);
  });

  test('changing what the design rules read revalidates every recorded count @scenario:changing-what-the-design-rules-read-revalidates-every-recorded-count', () => {
    inOneProject();
    test.setTimeout(240_000);

    /**
     * A count stands for what the rules report, and several things move that
     * without touching the file the count belongs to: the flat config, the
     * manifests the plugin is installed from, the library's own manifest and
     * build config, a primitive's `cva` variants, an app-local component source,
     * and this runner, which decides what a count has to match. Each has to
     * revalidate the record for files the diff never names.
     *
     * Run against a miniature tree rather than the checkout: the real roots are
     * ~2,500 files and each sweep costs minutes, while what is under test is
     * which files the gate asks about — the real runner, the real flat config and
     * the real plugin, over two sources. The checkout's own 437 recorded paths
     * are swept at full scale by the committed-baseline scenario below.
     */
    const root = syntheticRoot();
    /** The copied runner, invoked from the miniature tree: it derives the
     *  repository from its own location and relativizes its file arguments
     *  against the working directory, so asking it about `eslint.config.mjs`
     *  from anywhere else names a path outside its tree and selects nothing. */
    const checks = (files: string[]) =>
      run(
        process.execPath,
        [join(root, 'scripts/static-checks.mts'), ...files, '--only', 'suppressions'],
        { cwd: root },
      );
    try {
      const triggers = [
        'eslint.config.mjs',
        'package.json',
        'package-lock.json',
        'packages/client/package.json',
        'packages/client/tsdown.config.mjs',
        'packages/client/tsconfig.json',
        'scripts/static-checks.mts',
        'packages/client/src/Primitive.tsx',
        'client/src/components/ui/Thing.tsx',
      ];
      for (const trigger of triggers) {
        const report = checks([trigger]);
        expect(report.status, `${trigger} revalidated nothing`).not.toBe(0);
        /** A violation in a file the diff never named and the record never
         *  mentioned: only a sweep of the roots can see it. */
        expect(report.output, `${trigger} missed an unrecorded caller`).toContain(
          'client/src/Caller.tsx',
        );
        /** And slack recorded against a file the diff never touched. */
        expect(report.output, `${trigger} missed an untouched over-count`).toContain(
          'client/src/Clean.tsx',
        );
      }

      /** The reach is conditional, which is what makes the runs above evidence:
       *  an ordinary source change checks that file and stops there. */
      const unrecorded = checks(['client/src/Other.tsx']);
      expect(unrecorded.status, unrecorded.output).toBe(0);
      const ordinary = checks(['client/src/Clean.tsx']);
      expect(ordinary.status, 'a recorded source with slack passed').not.toBe(0);
      expect(ordinary.output).toContain('client/src/Clean.tsx');
      expect(ordinary.output, 'an ordinary source change swept the roots').not.toContain(
        'client/src/Caller.tsx',
      );

      /** And a spec under either metadata root is not metadata, however much it
       *  looks like a component source: the flat config turns every design rule
       *  off inside it and the library's tsconfig keeps it out of the bundle the
       *  caller rules resolve primitives through, so it carries no `cva` variant
       *  and can move no caller's diagnostic. Sweeping both roots for one is
       *  minutes spent on a question with no answer in it. */
      for (const spec of [
        'packages/client/src/Primitive.spec.tsx',
        'client/src/components/ui/Thing.spec.tsx',
      ]) {
        const report = checks([spec]);
        expect(report.status, `${spec}: ${report.output}`).toBe(0);
        expect(report.output, `${spec} swept the roots`).not.toContain('client/src/Caller.tsx');
      }
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('silencing a design rule with an inline comment is rejected @scenario:silencing-a-design-rule-with-an-inline-comment-is-rejected', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** An inline comment is the one way to silence a design rule that leaves
     *  nothing behind to review, and a file with no entry could otherwise carry
     *  one past every other check. Two halves answer for it: the diff's design
     *  sources are linted twice — with and without `--no-inline-config` — so
     *  anything a comment is silencing today shows up whatever its spelling, and
     *  the comments themselves are read out of the parser, so a directive that
     *  silences nothing yet is caught as well and a string that reads like one
     *  is not. */
    const probe = 'client/src/__directive_probe__.tsx';
    const probePath = join(repoRoot, probe);
    const violating = 'export default () => <div className="bg-pink-500" />;\n';
    const clean = 'export default () => <div className="bg-surface-primary" />;\n';
    /** Each directive is rejected over a file that violates the rule and over
     *  one that does not: a comment waiting for its first violation is the same
     *  hole a day later. */
    const directives: [string, string, string][] = [
      ['a named disable', '/* eslint-disable shadcn/no-raw-colors */', 'shadcn/no-raw-colors'],
      [
        'a justified disable',
        '/* eslint-disable shadcn/no-raw-colors -- because */',
        'shadcn/no-raw-colors',
      ],
      [
        'a next-line disable',
        '// eslint-disable-next-line shadcn/no-raw-colors',
        'shadcn/no-raw-colors',
      ],
      ['a blanket disable', '/* eslint-disable */', 'a blanket'],
      ['a described blanket disable', '/* eslint-disable -- temporary */', 'a blanket'],
      ['a described next-line disable', '// eslint-disable-next-line -- temporary', 'a blanket'],
      ['rule configuration', '/* eslint shadcn/no-raw-colors: off */', 'shadcn/no-raw-colors'],
      [
        'rule configuration to warn',
        '/* eslint shadcn/no-raw-colors: "warn" */',
        'shadcn/no-raw-colors',
      ],
      [
        'a quoted rule configuration',
        '/* eslint "shadcn/no-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      /** A quoted key is a JSON string, so its escapes belong to the encoding
       *  and not to the rule name. ESLint decodes both of these to the same
       *  rule it disables for the file; a gate that compares the spelling sees
       *  neither. */
      [
        'an escaped rule configuration',
        '/* eslint "shadcn\\/no-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      [
        'a unicode-escaped rule configuration',
        '/* eslint "shadcn\\u002fno-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      [
        'a single-quoted rule configuration',
        "/* eslint 'shadcn/no-raw-colors': off */",
        'shadcn/no-raw-colors',
      ],
    ];
    try {
      for (const [label, comment, named] of directives) {
        for (const [state, body] of [
          ['over a violation', violating],
          ['over a clean file', clean],
        ]) {
          writeFileSync(probePath, `${comment}\n${body}`);
          const report = staticChecks([probe, '--only', 'suppressions']);
          expect(report.status, `${label} ${state} passed`).not.toBe(0);
          expect(report.output, `${label} ${state}`).toContain(named);
        }
      }

      /** A blanket disable busy silencing some other rule is the case ESLint's
       *  own unused-directive report cannot see: it is used, so it is not
       *  unused, and it still covers every design rule. */
      writeFileSync(
        probePath,
        '/* eslint-disable */\nconst unused = 1;\nexport default () => <div className="bg-surface-primary" />;\n',
      );
      const used = staticChecks([probe, '--only', 'suppressions']);
      expect(used.status, 'a blanket disable silencing another rule passed').not.toBe(0);
      expect(used.output).toContain('a blanket');

      /** And two things that are not a silenced rule: a directive naming another
       *  rule — the tree carries forty of them — and a string that reads like
       *  one. */
      for (const [label, source] of [
        [
          'a directive for another rule',
          '// eslint-disable-next-line react-hooks/exhaustive-deps\nexport default () => <div className="bg-surface-primary" />;\n',
        ],
        [
          'comment-like text in a string',
          'export default () => <div className="bg-surface-primary" title="/* eslint-disable shadcn/no-raw-colors */" />;\n',
        ],
      ]) {
        writeFileSync(probePath, source);
        const report = staticChecks([probe, '--only', 'suppressions']);
        expect(report.status, `${label}: ${report.output}`).toBe(0);
      }
    } finally {
      rmSync(probePath, { force: true });
    }
  });

  test('a backlog that no longer says what it claims is rejected @scenario:a-backlog-that-no-longer-says-what-it-claims-is-rejected', () => {
    inOneProject();
    test.setTimeout(240_000);

    /** The record is data the lint reads, so a diff that edits it alone reaches
     *  no lintable file and nothing else would read it. Start from the positive
     *  control: the committed backlog passes its own gate — every recorded path
     *  exists, is reported on by a design-rule lint, and records the count that
     *  file actually has. */
    const baselineText = readFileSync(suppressionsPath, 'utf8');
    const passing = staticChecks([SUPPRESSIONS_FILE, '--only', 'suppressions']);
    expect(passing.status, passing.output).toBe(0);

    /** And each way it can stop saying what it claims fails, naming the key. The
     *  check validates every suppressions file the target names, so the invalid
     *  ones live in their own scratch directories and the repository's baseline
     *  is never written to. A count against a path no design-rule lint reports on
     *  is the quiet one: `client/src/style.css` is committed, inside a design
     *  root, and outside every AST rule, so the entry silences nothing and waits
     *  for whatever is linted at that path later. */
    const invalid: [string, unknown, string][] = [
      ['a shape ESLint cannot load', [], 'expected an object keyed by file path'],
      [
        'a count no run can reach',
        { 'client/src/App.jsx': { 'shadcn/no-restyle': { count: 0 } } },
        'positive integer count',
      ],
      [
        'a rule the plugin does not define',
        { 'client/src/App.jsx': { 'shadcn/no-shadows': { count: 1 } } },
        'is not a rule @shadcn/lint defines',
      ],
      [
        'a path that no longer exists',
        { 'client/src/Gone.tsx': { 'shadcn/no-restyle': { count: 1 } } },
        'recorded path no longer exists',
      ],
      [
        'a path no design-rule lint reports on',
        { 'client/src/style.css': { 'shadcn/no-restyle': { count: 1 } } },
        'recorded but no design-rule lint reports on it',
      ],
    ];
    for (const [label, content, expected] of invalid) {
      const probe = writeBaseline(content);
      const rejected = staticChecks([probe, '--only', 'suppressions']);
      expect(rejected.status, `${label} was accepted`).toBe(1);
      expect(rejected.output, label).toContain(expected);
    }

    /** And a diff that deletes the baseline outright is the same kind of
     *  failure: the group still activates, the changed-file lint has no source
     *  to report through, so the check has to say so rather than skip. The
     *  deletion is exercised in a synthetic root, not in the checkout. */
    const emptyRoot = mkdtempSync(join(tmpdir(), 'lc-no-baseline-'));
    mkdirSync(join(emptyRoot, 'scripts'), { recursive: true });
    copyFileSync(
      resolve(repoRoot, 'scripts/static-checks.mts'),
      join(emptyRoot, 'scripts/static-checks.mts'),
    );
    copyFileSync(resolve(repoRoot, 'scripts/i18n.mts'), join(emptyRoot, 'scripts/i18n.mts'));
    copyFileSync(resolve(repoRoot, 'package.json'), join(emptyRoot, 'package.json'));
    symlinkSync(resolve(repoRoot, 'node_modules'), join(emptyRoot, 'node_modules'), 'dir');
    const deleted = run(
      process.execPath,
      [join(emptyRoot, 'scripts/static-checks.mts'), SUPPRESSIONS_FILE, '--only', 'suppressions'],
      { cwd: emptyRoot },
    );
    expect(deleted.status, 'a deleted baseline passed validation').not.toBe(0);
    expect(deleted.output).toContain('is missing');
    rmSync(emptyRoot, { force: true, recursive: true });

    /** A diff may carry a baseline that is not the repository's, and dropping an
     *  entry from one is the same hole as raising a count: the source it spoke
     *  for still violates the rule, and the changed-file lint never sees it
     *  because the source did not change. Exercised in a miniature repository
     *  with a history of its own, since what the entry used to say is read from
     *  the diff. */
    const nestedRoot = syntheticRoot();
    const nested = 'packages/client/eslint-suppressions.json';
    try {
      writeFileSync(
        join(nestedRoot, nested),
        `${JSON.stringify({ 'client/src/Caller.tsx': { 'shadcn/no-raw-colors': { count: 1 } } }, null, 2)}\n`,
      );
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        [
          '-c',
          'user.email=scenario@librechat',
          '-c',
          'user.name=scenario',
          'commit',
          '-qm',
          'base',
        ],
      ]) {
        const step = run('git', args, { cwd: nestedRoot });
        expect(step.status, `git ${args[0]}: ${step.output}`).toBe(0);
      }
      writeFileSync(join(nestedRoot, nested), `${JSON.stringify({}, null, 2)}\n`);
      const removed = run(
        process.execPath,
        [join(nestedRoot, 'scripts/static-checks.mts'), nested, '--only', 'suppressions'],
        { cwd: nestedRoot },
      );
      expect(removed.status, 'a nested baseline dropped an entry its file still needs').not.toBe(0);
      expect(removed.output).toContain('client/src/Caller.tsx');
      expect(removed.output).toContain('records nothing but the file has');
    } finally {
      rmSync(nestedRoot, { force: true, recursive: true });
    }

    /** Nothing in the checkout moved while that ran. */
    expect(readFileSync(suppressionsPath, 'utf8')).toBe(baselineText);
  });

  test('a violation swapped inside the recorded allowance is rejected @scenario:a-swap-inside-the-recorded-allowance-is-rejected', () => {
    inOneProject();
    test.setTimeout(180_000);

    /**
     * The record is a budget per file and rule, so a change that removes one
     * raw colour and adds a different one keeps the count equal: the
     * changed-file lint silences the new violation inside the old allowance and
     * the count checks see nothing moved. What the totals cannot tell apart the
     * diagnostics can, so each changed file's version at the base is linted as
     * itself and a message the head reports that the base did not is new debt.
     *
     * A miniature repository with a history of its own, because the question is
     * what this file used to say.
     */
    const root = syntheticRoot();
    const caller = 'client/src/Caller.tsx';
    const checks = () =>
      run(
        process.execPath,
        [join(root, 'scripts/static-checks.mts'), caller, '--only', 'suppressions'],
        { cwd: root },
      );
    try {
      writeFileSync(join(root, caller), 'export default () => <div className="bg-pink-500" />;\n');
      writeFileSync(
        join(root, SUPPRESSIONS_FILE),
        `${JSON.stringify(
          {
            'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } },
            [caller]: { 'shadcn/no-raw-colors': { count: 1 } },
          },
          null,
          2,
        )}\n`,
      );
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        [
          '-c',
          'user.email=scenario@librechat',
          '-c',
          'user.name=scenario',
          'commit',
          '-qm',
          'base',
        ],
      ]) {
        const step = run('git', args, { cwd: root });
        expect(step.status, `git ${args[0]}: ${step.output}`).toBe(0);
      }

      /** The recorded state passes: one violation, one recorded. */
      const recorded = checks();
      expect(recorded.status, recorded.output).toBe(0);

      /** The same violation somewhere else in the file is a move, not new debt:
       *  the message is the message, so the count and the diagnostics agree. */
      writeFileSync(
        join(root, caller),
        'const spacer = null;\nexport default () => <div className="bg-pink-500" />;\n',
      );
      const moved = checks();
      expect(moved.status, `a move was reported as new debt: ${moved.output}`).toBe(0);

      /** A different raw colour at the same count is the swap. */
      writeFileSync(join(root, caller), 'export default () => <div className="bg-lime-400" />;\n');
      const swapped = checks();
      expect(swapped.status, 'a swap inside the allowance passed').not.toBe(0);
      expect(swapped.output).toContain('bg-lime-400');
      expect(swapped.output).toContain('is new here');

      /** And the sanctioned way to add one: the violation stays and the record
       *  grows to say so, which is a line in the diff a reviewer can see. The
       *  gate reports what the growth does not cover, not the act of adding. */
      writeFileSync(
        join(root, caller),
        'export default () => <div className="bg-pink-500 text-lime-400" />;\n',
      );
      writeFileSync(
        join(root, SUPPRESSIONS_FILE),
        `${JSON.stringify(
          {
            'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } },
            [caller]: { 'shadcn/no-raw-colors': { count: 2 } },
          },
          null,
          2,
        )}\n`,
      );
      const recordedGrowth = checks();
      expect(
        recordedGrowth.status,
        `recording what the change owes was rejected: ${recordedGrowth.output}`,
      ).toBe(0);

      /** The same violation without the growth is the debt arriving unsaid. */
      writeFileSync(
        join(root, SUPPRESSIONS_FILE),
        `${JSON.stringify(
          {
            'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } },
            [caller]: { 'shadcn/no-raw-colors': { count: 1 } },
          },
          null,
          2,
        )}\n`,
      );
      const unsaid = checks();
      expect(unsaid.status, 'a new violation passed without the record growing').not.toBe(0);
      expect(unsaid.output).toContain('text-lime-400');

      /** A file the change adds has no allowance to inherit, whatever the
       *  record says about it: recording a new violation at the same time as
       *  writing it is the same debt by another route. */
      writeFileSync(join(root, caller), 'export default () => <div className="bg-pink-500" />;\n');
      const added = 'client/src/Added.tsx';
      writeFileSync(join(root, added), 'export default () => <div className="bg-lime-400" />;\n');
      writeFileSync(
        join(root, SUPPRESSIONS_FILE),
        `${JSON.stringify(
          {
            'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } },
            [caller]: { 'shadcn/no-raw-colors': { count: 1 } },
            [added]: { 'shadcn/no-raw-colors': { count: 1 } },
          },
          null,
          2,
        )}\n`,
      );
      const recordedAtOnce = run(
        process.execPath,
        [join(root, 'scripts/static-checks.mts'), added, '--only', 'suppressions'],
        { cwd: root },
      );
      expect(recordedAtOnce.status, 'a new file arrived with its own allowance').not.toBe(0);
      expect(recordedAtOnce.output).toContain('is in a file this change adds');

      /** A move is not an addition: the violations came with the file, so the
       *  documented re-record of a moved path stays a green commit. */
      rmSync(join(root, added), { force: true });
      const moved2 = 'client/src/Renamed.tsx';
      writeFileSync(join(root, moved2), readFileSync(join(root, caller), 'utf8'));
      rmSync(join(root, caller), { force: true });
      writeFileSync(
        join(root, SUPPRESSIONS_FILE),
        `${JSON.stringify(
          {
            'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } },
            [moved2]: { 'shadcn/no-raw-colors': { count: 1 } },
          },
          null,
          2,
        )}\n`,
      );
      expect(run('git', ['add', '-A'], { cwd: root }).status).toBe(0);
      const renamed = run(
        process.execPath,
        [join(root, 'scripts/static-checks.mts'), moved2, '--only', 'suppressions'],
        { cwd: root },
      );
      expect(renamed.status, `a rename was read as new debt: ${renamed.output}`).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('a change to how the primitives are built rebuilds them before the backlog is read @scenario:a-build-config-change-rebuilds-the-primitives-before-validation', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** The design rules classify against `packages/client/dist`, which is build
     *  output and not in the tree. The runner rebuilds it when it is older than
     *  the library's sources — and the library's manifest and build config are
     *  sources in that sense too: they decide what is emitted and which entry
     *  point the rules resolve primitives through, while every file under `src`
     *  stays older than the last build. CI always builds, so a local run that
     *  trusted the old output would be the only one disagreeing.
     *
     *  The build is made observable rather than real: the miniature
     *  repository's `build:client-package` writes a marker and refreshes the
     *  bundle the manifest promises, dated ahead of every source so the result
     *  is what a finished build looks like. The assertion is whether the runner
     *  asked for a build at all — and, in the last case, what it does when the
     *  build reports success without producing one. */
    const root = syntheticRoot();
    const marker = join(root, 'built.marker');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const buildScript = 'scripts/fake-build.cjs';
    writeFileSync(
      join(root, buildScript),
      `const fs = require('fs');
const path = require('path');
fs.writeFileSync('built.marker', '1');
const when = new Date(Date.now() + 86400000);
for (const entry of ${JSON.stringify(bundleEntries())}) {
  const file = path.join('packages/client', entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export {};\\n');
  fs.utimesSync(file, when, when);
}
fs.utimesSync('packages/client/dist', when, when);
`,
    );
    const setBuild = (command: string): void => {
      manifest.scripts['build:client-package'] = command;
      writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    };
    setBuild(`node ${buildScript}`);
    const checks = (files: string[]) =>
      run(
        process.execPath,
        [join(root, 'scripts/static-checks.mts'), ...files, '--only', 'suppressions'],
        { cwd: root },
      );

    /** Freshness is an mtime comparison, and a file written in the same
     *  millisecond as the build reads as not newer than it. The times are set
     *  here rather than raced for, so what the scenario asserts is the rule and
     *  not the filesystem's clock. */
    const at = (relative: string, secondsFromNow: number): void => {
      const when = new Date(Date.now() + secondsFromNow * 1000);
      utimesSync(join(root, relative), when, when);
    };

    try {
      /** A build that holds everything the manifest promises and is newer than
       *  every source and build input: no rebuild. */
      const entries = bundleEntries();
      for (const entry of entries) at(join('packages/client', entry), 60);
      at('packages/client/dist', 60);
      rmSync(marker, { force: true });
      const fresh = checks(['eslint.config.mjs']);
      expect(fresh.status, fresh.output).not.toBe(0);
      expect(existsSync(marker), 'a current build was rebuilt anyway').toBe(false);

      /** The build empties `dist` before it writes, so a build that failed
       *  halfway leaves a recent directory over a bundle with no entry point.
       *  A timestamp cannot tell that apart from a finished build; what the
       *  manifest promises can. */
      rmSync(join(root, 'packages/client', entries[0]), { force: true });
      at('packages/client/dist', 90);
      const partial = checks(['eslint.config.mjs']);
      expect(existsSync(marker), 'a half-written bundle was trusted').toBe(true);
      expect(partial.status, partial.output).not.toBe(0);
      writeFileSync(join(root, 'packages/client', entries[0]), 'export {};\n');
      for (const entry of entries) at(join('packages/client', entry), 100);
      at('packages/client/dist', 100);
      rmSync(marker, { force: true });

      /** The build config moves, the sources do not: the build has to be asked
       *  for, because what `dist` holds was emitted under the old one. */
      at('packages/client/tsdown.config.mjs', 120);
      const afterConfig = checks(['packages/client/tsdown.config.mjs']);
      expect(existsSync(marker), 'a build-config change kept the old metadata').toBe(true);
      expect(afterConfig.status, afterConfig.output).not.toBe(0);

      /** And the library's manifest, which names the entry point the rules
       *  resolve `@librechat/client` through. */
      for (const entry of entries) at(join('packages/client', entry), 180);
      at('packages/client/dist', 180);
      rmSync(marker, { force: true });
      at('packages/client/package.json', 240);
      const afterManifest = checks(['packages/client/package.json']);
      expect(existsSync(marker), 'a manifest change kept the old metadata').toBe(true);
      expect(afterManifest.status, afterManifest.output).not.toBe(0);

      /** And the root manifests, which say what `build:client-package` runs and
       *  which toolchain runs it: they already select this check, and a build
       *  made under the previous definition is not the current one. */
      for (const entry of entries) at(join('packages/client', entry), 300);
      at('packages/client/dist', 300);
      rmSync(marker, { force: true });
      at('package-lock.json', 360);
      const afterToolchain = checks(['package-lock.json']);
      expect(existsSync(marker), 'a toolchain change kept the old metadata').toBe(true);
      expect(afterToolchain.status, afterToolchain.output).not.toBe(0);

      /** A spec under the library's sources is not one of the things the bundle
       *  is built from — `packages/client/tsconfig.json` excludes it — so a
       *  build older than it is not stale, and editing one buys no rebuild. */
      for (const entry of entries) at(join('packages/client', entry), 420);
      at('packages/client/dist', 420);
      rmSync(marker, { force: true });
      at('packages/client/src/Primitive.spec.tsx', 480);
      const afterSpec = checks(['eslint.config.mjs']);
      expect(existsSync(marker), 'a spec edit rebuilt the primitives').toBe(false);
      expect(afterSpec.status, afterSpec.output).not.toBe(0);

      /** Freshness is a property of every declared output, not of the newest
       *  file in the directory. A resolver loads one entry: a build that
       *  rewrote the ESM bundle and left the CJS one or the type declarations
       *  behind still satisfies a `max` comparison while `@shadcn/lint` reads
       *  the stale one. Only asserted when the manifest promises more than one
       *  output, which is what makes the distinction observable. */
      if (entries.length > 1) {
        for (const entry of entries) at(join('packages/client', entry), 600);
        at('packages/client/dist', 600);
        rmSync(marker, { force: true });
        /** Newer than one declared output and older than the rest, so the
         *  newest-file comparison reads the bundle as current and the
         *  per-output one does not. */
        at('packages/client/tsconfig.json', 520);
        at(join('packages/client', entries[0]), 300);
        const partialRefresh = checks(['eslint.config.mjs']);
        expect(existsSync(marker), 'one stale declared output read as a current build').toBe(true);
        expect(partialRefresh.status, partialRefresh.output).not.toBe(0);
      }

      /** And a build that reports success without producing one is not a
       *  build. Its exit code says the metadata is current; `dist` says it is
       *  not, and the lint that would follow classifies against a bundle that
       *  describes something else — reporting fewer violations than CI, which
       *  is the failure the rebuild exists to prevent. */
      setBuild('node -e "process.exit(0)"');
      for (const entry of entries) at(join('packages/client', entry), 700);
      at('packages/client/dist', 700);
      rmSync(marker, { force: true });
      at('packages/client/tsdown.config.mjs', 760);
      const lying = checks(['packages/client/tsdown.config.mjs']);
      expect(lying.status, 'a build that produced nothing was trusted').not.toBe(0);
      expect(lying.output).toContain('reported success');
      expect(lying.output).toContain('packages/client/dist');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test('recording the backlog builds the primitives first @scenario:recording-the-backlog-builds-the-primitives-first', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** The runner rebuilds before it validates, but the record is also written
     *  by hand, through `npm run lint:design:record`. That script reads the same
     *  `cva` variants out of `packages/client/dist`, so in a fresh checkout, or
     *  after a primitive changed, it recorded counts for a library nobody is
     *  compiling against: lower than the ones CI reports, and committed as the
     *  budget every later change is measured against.
     *
     *  The build is made observable rather than real, as above. The questions
     *  are whether the record asks for one before it writes, and whether a build
     *  that fails is still loud now that the wrapper no longer carries its own.
     */
    const root = syntheticRoot();
    const log = join(root, 'built.log');
    const baseline = join(root, SUPPRESSIONS_FILE);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const setBuild = (command: string): void => {
      manifest.scripts['build:client-package'] = command;
      writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    };
    const npmRun = (script: string) => run('npm', ['run', '--silent', script], { cwd: root });

    try {
      setBuild(`node -e "require('fs').appendFileSync('built.log','built\\n')"`);
      writeFileSync(baseline, '{}\n');
      const recorded = npmRun('lint:design:record');
      expect(existsSync(log), 'the backlog was recorded without building the primitives').toBe(
        true,
      );
      expect(readFileSync(baseline, 'utf8'), recorded.output).toContain('client/src/Caller.tsx');

      /** The wrapper dropped its own build, because both steps it chains now
       *  carry one. A build that fails still has to be loud: the record cannot
       *  write a baseline it never linted for, and the prune that follows does
       *  not swallow its exit the way the record's is swallowed. */
      setBuild('node -e "process.exit(1)"');
      writeFileSync(baseline, '{}\n');
      rmSync(log, { force: true });
      const suppressed = npmRun('lint:design:suppress');
      expect(suppressed.status, 'a failed build passed as a re-record').not.toBe(0);
      expect(readFileSync(baseline, 'utf8').trim(), suppressed.output).toBe('{}');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

/**
 * A miniature repository the runner can be pointed at: its own copy of this
 * script, the real flat config, the real manifests and a symlinked
 * `node_modules`, over two client sources and one library source. `ROOT` is
 * derived from the script's own location, so the copy treats this tree as the
 * repository — which is what makes a roots sweep affordable to assert.
 *
 * The bundle is written last, holding exactly what the library's manifest
 * promises, so the runner reads the design metadata as current and does not
 * rebuild; the rules still resolve the real primitives through the symlinked
 * `node_modules`.
 */
function syntheticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-synthetic-root-'));
  const write = (relative: string, content: string): void => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const copy = (relative: string): void => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    copyFileSync(resolve(repoRoot, relative), path);
  };

  for (const file of [
    'scripts/static-checks.mts',
    'scripts/i18n.mts',
    'package.json',
    'package-lock.json',
    'eslint.config.mjs',
    'packages/client/package.json',
    'packages/client/tsdown.config.mjs',
    'packages/client/tsconfig.json',
    /** The lane this runner mirrors: the filter-parity check reads it, and the
     *  copy is what a scenario can break without touching the checkout. */
    '.github/workflows/static-checks.yml',
  ]) {
    copy(file);
  }
  symlinkSync(resolve(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');

  /** One caller that violates a design rule and is recorded nowhere, one that is
   *  clean and recorded with slack: between them, a sweep of the roots is the
   *  only run that can report both. */
  write('client/src/Caller.tsx', 'export default () => <div className="bg-pink-500" />;\n');
  write('client/src/Clean.tsx', 'export default () => <div className="bg-surface-primary" />;\n');
  write('client/src/Other.tsx', 'export default () => <div className="bg-surface-primary" />;\n');
  write('client/src/components/ui/Thing.tsx', 'export const Thing = () => null;\n');
  write('packages/client/src/Primitive.tsx', 'export const Primitive = () => null;\n');
  /** A spec beside each of them, under both metadata roots. The real roots are
   *  full of these — every primitive in `packages/client/src/components` has
   *  one — and the flat config turns every design rule off inside them, so what
   *  the gate does when one changes is a question the checkout asks constantly.
   *  Written before the bundle, so the miniature build still reads as current. */
  write('packages/client/src/Primitive.spec.tsx', 'export const fixture = null;\n');
  write('client/src/components/ui/Thing.spec.tsx', 'export const fixture = null;\n');
  for (const entry of bundleEntries()) write(join('packages/client', entry), 'export {};\n');
  write(
    SUPPRESSIONS_FILE,
    `${JSON.stringify({ 'client/src/Clean.tsx': { 'shadcn/no-restyle': { count: 2 } } }, null, 2)}\n`,
  );
  return root;
}

/**
 * What `packages/client/package.json` promises inside `dist`: its entry fields
 * and every string leaf of `exports` except a subpath pattern, which names no
 * single file. A build is only finished when these are there, which is what the
 * runner checks and what the miniature repository has to reproduce to stand in
 * for one.
 */
function bundleEntries(): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'packages/client/package.json'), 'utf8'),
  ) as Record<string, unknown>;
  const declared: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const path = value.replace(/^\.\//, '');
      if (path.startsWith('dist/') && !path.includes('*')) declared.push(path);
      return;
    }
    if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect);
  };
  for (const field of ['main', 'module', 'types', 'exports']) collect(manifest[field]);
  return [...new Set(declared)];
}
