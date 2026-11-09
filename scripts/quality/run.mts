import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Stryker } from '@stryker-mutator/core';
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { mutationSelection, riskMarkdown, riskReport } from './risk.mts';
import { changes, git, WORKSPACES, workspaceFor } from './changes.mts';
import { coverageArgs } from './jest.mts';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/dev' },
    head: { type: 'string', default: 'HEAD' },
    workspace: { type: 'string' },
    check: { type: 'string' },
  },
});
const workspace = WORKSPACES.find(({ name }) => name === values.workspace);
if (!workspace || !['risk', 'mutation'].includes(values.check ?? '')) {
  throw new Error(
    'Usage: node scripts/quality/run.mts --base ref --workspace name --check risk|mutation',
  );
}
const selection = changes(values.base, values.head);
if (selection.head !== git(['rev-parse', 'HEAD']).trim()) {
  throw new Error('Check out the selected head before measuring its source');
}
const files = selection.files.filter(({ file }) => workspaceFor(file)?.name === workspace.name);
const output = resolve('coverage/changes', workspace.name, values.check!);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(`${output}/selection.json`, JSON.stringify({ ...selection, files }, null, 2));
const summary = (markdown: string) => {
  console.log(markdown);
  writeFileSync(`${output}/summary.md`, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
};
if (!files.length) {
  summary(`## ${workspace.name}: ${values.check}\n\nNo changed source files.\n`);
  process.exit(0);
}
const require = createRequire(import.meta.url);
const jestBin = require.resolve('jest/bin/jest');
const localFiles = files.map(({ file }) => relative(workspace.path, file));
const env = { ...process.env, NODE_ENV: 'test', BABEL_ENV: 'test' };
const configFile = `${workspace.path}/${workspace.config}`;

if (values.check === 'risk') {
  const listed = spawnSync(
    process.execPath,
    [
      jestBin,
      '--config',
      workspace.config,
      '--listTests',
      '--json',
      '--runInBand',
      '--findRelatedTests',
      ...localFiles,
    ],
    { cwd: workspace.path, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0) {
    throw listed.error ?? new Error(`Jest test selection failed: ${listed.stderr}`);
  }
  const tests: unknown = JSON.parse(listed.stdout);
  if (!Array.isArray(tests) || tests.some((test) => typeof test !== 'string')) {
    throw new Error('Invalid Jest test selection');
  }
  writeFileSync(`${output}/selected-tests.json`, JSON.stringify(tests, null, 2));
  const result = tests.length
    ? spawnSync(
        process.execPath,
        [jestBin, ...coverageArgs(workspace.config, localFiles, output, tests)],
        { cwd: workspace.path, stdio: 'inherit', env },
      )
    : { error: undefined, status: 0, signal: null };
  if (result.error || result.status !== 0) {
    summary(
      `## ${workspace.name}: change risk\n\nCoverage failed. Scores are unavailable. See the test log.\n`,
    );
    throw result.error ?? new Error(`Jest exited with ${result.status ?? result.signal}`);
  }
  const coverageFile = `${output}/coverage-final.json`;
  if (!existsSync(coverageFile)) {
    // Jest produces no coverage file when no test matches. Keep the lack of evidence explicit.
    if (tests.length !== 0) throw new Error('Jest did not produce coverage');
    writeFileSync(coverageFile, '{}');
  }
  const report = riskReport(coverageFile, files, selection.base);
  writeFileSync(
    `${output}/risk.json`,
    JSON.stringify({ base: selection.base, head: selection.head, ...report }, null, 2),
  );
  summary(riskMarkdown(report));
} else {
  process.env.NODE_ENV = env.NODE_ENV;
  process.env.BABEL_ENV = env.BABEL_ENV;
  const targets = mutationSelection(files, selection.base);
  writeFileSync(`${output}/functions.json`, JSON.stringify(targets, null, 2));
  if (!targets.length) {
    summary(`## ${workspace.name}: mutation testing\n\nNo added or edited functions.\n`);
    process.exit(0);
  }
  const started = Date.now();
  const stryker = new Stryker({
    plugins: ['@stryker-mutator/jest-runner'],
    testRunner: 'jest',
    jest: {
      projectType: 'custom',
      configFile,
      enableFindRelatedTests: true,
      config: {
        testResultsProcessor: undefined,
        coverageThreshold: {},
        // Match the existing database mutation lane when npm nests Jest's environment.
        ...(workspace.name === 'data-schemas'
          ? {
              testEnvironment: require.resolve('jest-environment-node', {
                paths: [require.resolve('jest')],
              }),
            }
          : {}),
      },
    },
    mutate: targets.flatMap(({ mutate }) => mutate),
    ignoreStatic: false,
    coverageAnalysis: 'perTest',
    concurrency: 2,
    incremental: false,
    allowEmpty: true,
    reporters: ['clear-text', 'progress', 'json', 'html'],
    jsonReporter: { fileName: `${output}/mutation.json` },
    htmlReporter: { fileName: `${output}/mutation.html` },
    thresholds: { high: 90, low: 70, break: 0 },
    timeoutMS: 10000,
    dryRunTimeoutMinutes: 10,
    ignorePatterns: [
      '/*',
      '!/package.json',
      '!/config/',
      '!/packages/',
      '!/api/',
      '!/client/',
      '**/coverage/**',
      '**/workspace/**',
      '**/.git/**',
      '**/.stryker-tmp/**',
      '**/node_modules/**',
    ],
  });
  try {
    const results = await stryker.runMutationTest();
    const counts = new Map<string, number>();
    for (const mutant of results) counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
    const detected = (counts.get('Killed') ?? 0) + (counts.get('Timeout') ?? 0);
    const tested = detected + (counts.get('Survived') ?? 0) + (counts.get('NoCoverage') ?? 0);
    const runtimeErrors = counts.get('RuntimeError') ?? 0;
    const score = tested ? `${((100 * detected) / tested).toFixed(2)}%` : 'N/A (no valid mutants)';
    summary(
      [
        `## ${workspace.name}: mutation testing (advisory)`,
        '',
        `Changed functions: ${targets.reduce((total, target) => total + target.functions.length, 0)} in ${targets.length} files. Static mutations are included. Duration: ${((Date.now() - started) / 60000).toFixed(1)} minutes.`,
        '',
        `Mutation score: ${score}. Surviving and uncovered mutants reduce this score. Invalid mutants are excluded.`,
        ...(runtimeErrors
          ? [
              `${runtimeErrors} mutations had runtime errors. The check fails because their results are incomplete.`,
            ]
          : []),
        '',
        '| Result | Mutants |',
        '| --- | ---: |',
        ...[...counts].map(([status, count]) => `| ${status} | ${count} |`),
        '',
        'Download the report artifact for the HTML report and each mutation location.',
        '',
      ].join('\n'),
    );
    if (runtimeErrors) process.exitCode = 1;
  } catch (error) {
    summary(
      `## ${workspace.name}: mutation testing\n\nStryker failed. This is not a mutation score. See the test log.\n`,
    );
    throw error;
  }
}
