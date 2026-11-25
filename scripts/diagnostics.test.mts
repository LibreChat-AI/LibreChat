import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { diagnosis, introducedViolations } from './diagnostics.mts';
import type { LintReport, SuppressionsFile } from './diagnostics.mts';

const RULE = 'shadcn/no-restyle';
const CLIENT_PATH = 'client/src/components/Chat/Probe.tsx';
const PACKAGE_PATH = 'packages/chat/src/components/Probe.tsx';

/** `shadcn/no-restyle`'s message for a gap class on `<Button>`, as ESLint reports it at each path:
 *  the violation reads the same, the remedy offers `PanelContent` only inside the app. */
const restyle = (className: string, path: string): string =>
  `"${className}" is not allowed on <Button>: <Button> owns its spacing. Use a size (default, roomy), or margin here${
    path.startsWith('client/') ? ', gap on the parent, or PanelContent' : ' or gap on the parent'
  } for space around it. Add a size in packages/client/dist/index.mjs only if the design explicitly calls for one. See CLAUDE.md, "Theming and styling".`;

/** A report whose design diagnostics are all suppressed by the record, as the baseline leaves them. */
const report = (path: string, ...classNames: string[]): LintReport => ({
  filePath: path,
  messages: [],
  suppressedMessages: classNames.map((className) => ({
    ruleId: RULE,
    message: restyle(className, path),
    suppressions: [{ kind: 'file' }],
  })),
});

const recordOf = (path: string, count: number): SuppressionsFile => ({
  [path]: { [RULE]: { count } },
});

test('the remedy differs across the move, the violation does not', () => {
  assert.notEqual(restyle('gap-1', CLIENT_PATH), restyle('gap-1', PACKAGE_PATH));
  assert.equal(
    diagnosis(restyle('gap-1', CLIENT_PATH)),
    '"gap-1" is not allowed on <Button>: <Button> owns its spacing.',
  );
  assert.equal(diagnosis(restyle('gap-1', CLIENT_PATH)), diagnosis(restyle('gap-1', PACKAGE_PATH)));
});

test('a file moved into a package with its violation re-recorded at the same count passes', () => {
  const problems = introducedViolations(
    {
      path: PACKAGE_PATH,
      head: report(PACKAGE_PATH, 'gap-1'),
      base: { path: CLIENT_PATH, reports: [report(CLIENT_PATH, 'gap-1')] },
    },
    recordOf(PACKAGE_PATH, 1),
    recordOf(CLIENT_PATH, 1),
  );
  assert.deepEqual(problems, []);
});

test('a same-count swap fails and names the new violation', () => {
  const problems = introducedViolations(
    {
      path: CLIENT_PATH,
      head: report(CLIENT_PATH, 'gap-2'),
      base: { path: CLIENT_PATH, reports: [report(CLIENT_PATH, 'gap-1')] },
    },
    recordOf(CLIENT_PATH, 1),
    recordOf(CLIENT_PATH, 1),
  );
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /"gap-2" is not allowed on <Button>: <Button> owns its spacing\. is new here/,
  );
});

test('a same-count swap across a move fails too', () => {
  const problems = introducedViolations(
    {
      path: PACKAGE_PATH,
      head: report(PACKAGE_PATH, 'gap-2'),
      base: { path: CLIENT_PATH, reports: [report(CLIENT_PATH, 'gap-1')] },
    },
    recordOf(PACKAGE_PATH, 1),
    recordOf(CLIENT_PATH, 1),
  );
  assert.equal(problems.length, 1);
  assert.match(
    problems[0],
    /^packages\/chat\/src\/components\/Probe\.tsx: .*"gap-2".* is new here/,
  );
});

test('a violation added with the count raised to cover it passes', () => {
  const problems = introducedViolations(
    {
      path: CLIENT_PATH,
      head: report(CLIENT_PATH, 'gap-1', 'gap-2'),
      base: { path: CLIENT_PATH, reports: [report(CLIENT_PATH, 'gap-1')] },
    },
    recordOf(CLIENT_PATH, 2),
    recordOf(CLIENT_PATH, 1),
  );
  assert.deepEqual(problems, []);
});

test('a file the change adds brings no allowance, whatever the record says', () => {
  const problems = introducedViolations(
    { path: PACKAGE_PATH, head: report(PACKAGE_PATH, 'gap-1') },
    recordOf(PACKAGE_PATH, 1),
    {},
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /is in a file this change adds/);
});
