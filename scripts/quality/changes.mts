import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const WORKSPACES = [
  { name: 'data-schemas', path: 'packages/data-schemas', config: 'jest.config.mjs' },
  { name: 'data-provider', path: 'packages/data-provider', config: 'jest.config.js' },
  { name: 'api', path: 'packages/api', config: 'jest.config.mjs' },
  { name: 'server', path: 'api', config: 'jest.config.js' },
  { name: 'client', path: 'client', config: 'jest.config.cjs' },
  { name: 'client-package', path: 'packages/client', config: 'jest.config.js' },
  { name: 'chat', path: 'packages/chat', config: 'jest.config.js' },
];

export const REPORT_WORKSPACES = ['data-schemas', 'api', 'server'];

export function reportSelection(check: string, scope: string) {
  if (!['risk', 'mutation', 'both'].includes(check))
    throw new Error('Check must be risk, mutation, or both');
  const supported = check === 'mutation' ? ['data-schemas'] : REPORT_WORKSPACES;
  const scopes = scope === 'all' ? supported : scope.split(',');
  if (
    !scopes.length ||
    new Set(scopes).size !== scopes.length ||
    scopes.some((name) => !supported.includes(name))
  ) {
    throw new Error(`Supported scopes for ${check}: ${supported.join(',')}, or all`);
  }
  return { check, scopes: REPORT_WORKSPACES.filter((name) => scopes.includes(name)) };
}

/** Risk reports cover backend workspaces; mutation shards only cover data-schemas. */
export function reportJobs(workspaces: string[], check = 'both') {
  return workspaces
    .filter((name) => REPORT_WORKSPACES.includes(name))
    .flatMap((workspace) => [
      ...(check !== 'mutation' ? [{ workspace, task: { check: 'risk', shard: 0 } }] : []),
      ...(workspace === 'data-schemas' && check !== 'risk'
        ? [1, 2, 3, 4].map((shard) => ({ workspace, task: { check: 'mutation', shard } }))
        : []),
    ]);
}

export interface ChangedRange {
  start: number;
  count: number;
}

export interface ChangedFile {
  file: string;
  ranges: ChangedRange[];
}

export function literalGlob(file: string): string {
  return file.replace(/[\\*?[\]{}()!+@]/gu, '\\$&');
}

export function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', ['--literal-pathspecs', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Shared test suites and fixtures colocated with database production source.
const DATABASE_TEST_SUPPORT = new Set([
  'packages/data-schemas/src/app/conformance.ts',
  'packages/data-schemas/src/tenant/conformance.ts',
  'packages/data-schemas/src/tenant/harness.ts',
  'packages/data-schemas/src/tenant/probe.ts',
  'packages/data-schemas/src/methods/test-helpers.ts',
]);

export function isSource(file: string): boolean {
  return (
    /\.[cm]?[jt]sx?$/u.test(file) &&
    !file.startsWith('packages/data-schemas/src/contracts/') &&
    !DATABASE_TEST_SUPPORT.has(file) &&
    !/\.(?:d|spec|test|helper|manual)\.[cm]?[jt]sx?$/u.test(file) &&
    !/(?:^|\/)(?:__tests__|__mocks__|test|tests|specs|fixtures|misc|dist|node_modules)\//u.test(
      file,
    )
  );
}

export function workspaceFor(file: string) {
  return WORKSPACES.find(({ path }) => file.startsWith(path === 'api' ? 'api/' : `${path}/src/`));
}

export function changedRanges(patch: string): ChangedRange[] {
  return [...patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)].map(
    ([, start, count]) => ({
      start: Number(start),
      count: count === undefined ? 1 : Number(count),
    }),
  );
}

export function overlaps(start: number, end: number, ranges: ChangedRange[]): boolean {
  return ranges.some((range) =>
    range.count === 0
      ? start <= range.start && range.start < end
      : start <= range.start + range.count - 1 && range.start <= end,
  );
}

/** Compare the PR's head with its merge base, never with GitHub's synthetic merge commit. */
export function changes(base: string, head = 'HEAD', cwd = process.cwd()) {
  const mergeBase = git(['merge-base', base, head], cwd).trim();
  // Treat a rename as deletion + addition so every function at the new path is included.
  const files = git(
    ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=AM', mergeBase, head, '--'],
    cwd,
  )
    .split('\0')
    .filter(Boolean);
  const sources = files.filter(isSource);
  return {
    base: mergeBase,
    head: git(['rev-parse', '--verify', `${head}^{commit}`], cwd).trim(),
    unsupported: sources.filter((file) => !workspaceFor(file)),
    files: sources
      .filter((file) => workspaceFor(file))
      .map(
        (file): ChangedFile => ({
          file,
          ranges: changedRanges(
            git(
              [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--no-renames',
                '--unified=0',
                mergeBase,
                head,
                '--',
                file,
              ],
              cwd,
            ),
          ),
        }),
      ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      base: { type: 'string', default: 'origin/dev' },
      head: { type: 'string', default: 'HEAD' },
      scope: { type: 'string', default: 'all' },
      check: { type: 'string', default: 'both' },
    },
  });
  const request = reportSelection(values.check, values.scope);

  const selection = changes(values.base, values.head);
  const workspaces = WORKSPACES.filter(
    ({ name, path }) =>
      REPORT_WORKSPACES.includes(name) &&
      request.scopes.includes(name) &&
      selection.files.some(({ file }) => workspaceFor(file)?.path === path),
  ).map(({ name }) => name);
  const reports = reportJobs(workspaces, request.check);
  const mutationWorkspaces = [
    ...new Set(
      reports.filter(({ task }) => task.check === 'mutation').map(({ workspace }) => workspace),
    ),
  ];
  const riskWorkspaces = reports
    .filter(({ task }) => task.check === 'risk')
    .map(({ workspace }) => workspace);
  console.log(JSON.stringify({ ...selection, workspaces, reports, mutationWorkspaces }, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `workspaces=${JSON.stringify(workspaces)}`,
        `hasChanges=${reports.length > 0}`,
        `reports=${JSON.stringify(reports)}`,
        `mutationWorkspaces=${JSON.stringify(mutationWorkspaces)}`,
        `hasMutations=${mutationWorkspaces.length > 0}`,
        '',
      ].join('\n'),
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        '## Changed source selection',
        '',
        `Base: ${selection.base}. Head: ${selection.head}. Scope: ${values.scope}.`,
        '',
        `Change-risk workspaces: ${riskWorkspaces.join(', ') || 'none'}.`,
        '',
        `Mutation workspaces: ${mutationWorkspaces.join(', ') || 'none'} (four shards each).`,
        '',
        `Workspaces outside this run's scope: ${
          WORKSPACES.filter(
            ({ name }) =>
              !workspaces.includes(name) &&
              selection.files.some(({ file }) => workspaceFor(file)?.name === name),
          )
            .map(({ name }) => name)
            .join(', ') || 'none'
        }.`,
        '',
        `Source outside the application test workspaces: ${selection.unsupported.join(', ') || 'none'}.`,
        '',
      ].join('\n'),
    );
  }
}
