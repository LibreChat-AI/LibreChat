import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Stryker } from '@stryker-mutator/core';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mutationSelection, riskMarkdown, riskReport } from './risk.mts';
import { changes, git, WORKSPACES, workspaceFor } from './changes.mts';
import { runCoverage } from './jest.mts';
import { assertMutants, mutantKey, mutationPatterns, planShards } from './shards.mts';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/dev' },
    head: { type: 'string', default: 'HEAD' },
    workspace: { type: 'string' },
    check: { type: 'string' },
    shard: { type: 'string' },
    static: { type: 'string', default: 'off' },
  },
});
const workspace = WORKSPACES.find(({ name }) => name === values.workspace);
if (!workspace || !['risk', 'mutation'].includes(values.check ?? '')) {
  throw new Error(
    'Usage: node scripts/quality/run.mts --base ref --workspace name --check risk|mutation',
  );
}
if (!['on', 'off'].includes(values.static)) throw new Error('--static must be on or off');
const staticMutants = values.static === 'on';
const staticDescription = staticMutants
  ? 'Static mutations are included.'
  : 'Static-only mutations are ignored and excluded from the score. Hybrid mutations use per-test coverage.';
const selection = changes(values.base, values.head);
if (selection.head !== git(['rev-parse', 'HEAD']).trim()) {
  throw new Error('Check out the selected head before measuring its source');
}
const files = selection.files.filter(({ file }) => workspaceFor(file)?.name === workspace.name);
const shardIndex = values.shard === undefined ? undefined : Number(values.shard);
if (
  shardIndex !== undefined &&
  (values.check !== 'mutation' || !Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > 4)
) {
  throw new Error('--shard requires a mutation check and an index from 1 to 4');
}
const output = resolve(
  'coverage/changes',
  workspace.name,
  shardIndex === undefined ? values.check! : `mutation-${shardIndex}`,
);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
writeFileSync(`${output}/selection.json`, JSON.stringify({ ...selection, files }, null, 2));
const summary = (markdown: string) => {
  console.log(markdown);
  writeFileSync(`${output}/summary.md`, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
};
if (!files.length && shardIndex === undefined) {
  summary(`## ${workspace.name}: ${values.check}\n\nNo changed source files.\n`);
  process.exit(0);
}
// Test binaries and configuration belong to the measured head, not the tooling checkout.
const require = createRequire(resolve('package.json'));
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
  try {
    runCoverage({
      workspace: workspace.name,
      config: workspace.config,
      cwd: workspace.path,
      jestBin,
      files: localFiles,
      tests,
      output,
      env,
    });
  } catch (error) {
    summary(
      `## ${workspace.name}: change risk\n\nCoverage failed. Scores are unavailable. See the test log.\n`,
    );
    throw error;
  }
  const coverageFile = `${output}/coverage-final.json`;
  const report = riskReport(coverageFile, files, selection.base);
  writeFileSync(
    `${output}/risk.json`,
    JSON.stringify({ base: selection.base, head: selection.head, ...report }, null, 2),
  );
  summary(riskMarkdown(report));
} else {
  process.env.NODE_ENV = env.NODE_ENV;
  process.env.BABEL_ENV = env.BABEL_ENV;
  console.log(`Mutation run: static=${values.static}. ${staticDescription}`);
  const allTargets = mutationSelection(files, selection.base);
  const plan =
    shardIndex === undefined
      ? undefined
      : await planShards(
          allTargets,
          selection.base,
          selection.head,
          workspace.name,
          4,
          staticMutants,
        );
  const shard = plan?.shards.find(({ index }) => index === shardIndex);
  const targets = shard?.targets ?? allTargets;
  if (plan && shard) {
    writeFileSync(`${output}/plan.json`, JSON.stringify(plan, null, 2));
    console.log(
      `Mutation shard ${shard.index}/${plan.shards.length}: ${shard.expected.length} planned mutants; two workers; static=${values.static}`,
    );
  }
  writeFileSync(`${output}/functions.json`, JSON.stringify(targets, null, 2));
  const completeShard = () => {
    if (plan && shard)
      writeFileSync(
        `${output}/completion.json`,
        JSON.stringify(
          {
            digest: plan.digest,
            index: shard.index,
            complete: true,
            total: shard.expected.length,
          },
          null,
          2,
        ),
      );
  };
  if (!targets.length || shard?.expected.length === 0) {
    completeShard();
    summary(
      `## ${workspace.name}: mutation testing\n\nNo mutations selected for this run. Static=${values.static}.\n`,
    );
    process.exit(0);
  }
  const started = Date.now();
  const stryker = new Stryker({
    plugins: [
      import.meta.resolve('@stryker-mutator/jest-runner'),
      new URL('./progress.mts', import.meta.url).href,
    ],
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
    mutate: mutationPatterns(targets),
    ignoreStatic: !staticMutants,
    coverageAnalysis: 'perTest',
    concurrency: 2,
    incremental: false,
    allowEmpty: true,
    reporters: ['clear-text', 'function-progress', 'json', 'html'],
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
    if (shard)
      assertMutants(
        shard.expected,
        results.map((mutant) =>
          mutantKey(relative(process.cwd(), mutant.fileName).replaceAll('\\', '/'), mutant),
        ),
      );
    const progress = JSON.parse(readFileSync(`${output}/progress.json`, 'utf8'));
    if (!progress.complete || progress.completed !== results.length) {
      throw new Error('Mutation progress report is incomplete');
    }
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
        `Changed functions: ${targets.reduce((total, target) => total + target.functions.length, 0)} in ${targets.length} files. Static=${values.static}. ${staticDescription} Duration: ${((Date.now() - started) / 60000).toFixed(1)} minutes.`,
        '',
        `Mutation score: ${score}. Surviving and uncovered mutants reduce this score. Ignored and invalid mutants are excluded.`,
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
    else completeShard();
  } catch (error) {
    summary(
      `## ${workspace.name}: mutation testing\n\nStryker failed. This is not a mutation score. See the test log.\n`,
    );
    throw error;
  }
}
