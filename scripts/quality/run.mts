import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolve, relative } from 'node:path';
import { Stryker } from '@stryker-mutator/core';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import type { MutantResult } from '@stryker-mutator/api/core';
import type { RunEvidence } from './coverage.mts';
import type { ShardPlan } from './shards.mts';

import { allMutationTargets, riskMarkdown, riskReport, suppressionAdvisory } from './risk.mts';
import {
  assertMutants,
  describeMutatedScope,
  isReconstructedShardComplete,
  mutantKey,
  mutationPatterns,
  parseMutantKey,
  planShards,
} from './shards.mts';
import { changes, git, WORKSPACES, workspaceFor } from './changes.mts';
import { LOGGER_IGNORER_NAME } from './ignore.mts';
import {
  parseProgressLines,
  resolveMutationBudgetMinutes,
  runWithinBudget,
  wasAlreadyComplete,
} from './budget.mts';
import { checkRevision, mergeFileCoverage, suiteStatuses } from './coverage.mts';
import {
  coverageGroups,
  listRelatedTests,
  readGroupResults,
  resolveAliasBudgetMinutes,
  runAliasCoverage,
  runCoverage,
} from './jest.mts';

const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'origin/dev' },
    head: { type: 'string', default: 'HEAD' },
    workspace: { type: 'string' },
    check: { type: 'string' },
    shard: { type: 'string' },
    static: { type: 'string', default: 'off' },
    // Hidden: set only when this script re-execs itself to run Stryker under a budget below.
    'mutation-worker': { type: 'boolean', default: false },
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

/** Reconstructs `mutation.json` and `completion.json` from what the killed worker already wrote
 * to `progress.jsonl`, with `completion.status` `'partial'` and every mutant the worker never
 * reached named in `completion.unfinished`. */
function finalizeBudgetTimeout(budgetMinutes: number): 'raced-complete' | 'partial' {
  const completionPath = `${output}/completion.json`;
  if (
    wasAlreadyComplete(
      existsSync(completionPath) ? readFileSync(completionPath, 'utf8') : undefined,
    )
  ) {
    // The worker finished and wrote its real result right as the deadline fired; keep it rather
    // than overwrite it with a reconstructed partial one.
    console.log('Execution budget reached, but the worker already completed this shard.');
    return 'raced-complete';
  }
  const planPath = `${output}/plan.json`;
  if (shardIndex === undefined || !existsSync(planPath)) {
    const markdown = [
      `## ${workspace!.name}: mutation testing`,
      '',
      `Execution budget reached (${budgetMinutes} minutes) before a shard plan was written. No mutation results are available.`,
      '',
    ].join('\n');
    writeFileSync(`${output}/summary.md`, markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    throw new Error(
      'Execution budget reached: no shard plan was available to record progress against',
    );
  }
  const plan: ShardPlan = JSON.parse(readFileSync(planPath, 'utf8'));
  const shard = plan.shards.find((item) => item.index === shardIndex);
  if (!shard) throw new Error('Execution budget reached: shard plan is missing this shard index');
  const progressPath = `${output}/progress.jsonl`;
  const finished = existsSync(progressPath)
    ? parseProgressLines(readFileSync(progressPath, 'utf8'))
    : [];
  const finishedByKey = new Map<string, MutantResult>();
  for (const result of finished) {
    const file = relative(process.cwd(), result.fileName).replaceAll('\\', '/');
    finishedByKey.set(mutantKey(file, result), result);
  }
  const reportFiles: Record<string, { source: string; language: string; mutants: MutantResult[] }> =
    {};
  const sourceFor = (file: string) =>
    (reportFiles[file] ??= {
      source: readFileSync(file, 'utf8'),
      language: /\.tsx?$/u.test(file) ? 'typescript' : 'javascript',
      mutants: [],
    });
  for (const result of finishedByKey.values()) {
    const file = relative(process.cwd(), result.fileName).replaceAll('\\', '/');
    sourceFor(file).mutants.push(result);
  }
  // Every planned mutant finished (from the worker's own per-mutant callback); only the final
  // completion.json write raced with the kill. Record this shard as complete, the same as a
  // normal run, instead of a false 'partial' the merge step would then reject as incomplete.
  if (isReconstructedShardComplete(shard.expected, new Set(finishedByKey.keys()))) {
    writeFileSync(
      `${output}/mutation.json`,
      JSON.stringify(
        {
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: reportFiles,
          testFiles: {},
        },
        null,
        2,
      ),
    );
    writeFileSync(
      `${output}/completion.json`,
      JSON.stringify(
        { digest: plan.digest, index: shard.index, complete: true, total: shard.expected.length },
        null,
        2,
      ),
    );
    const markdown = [
      `## ${workspace!.name}: mutation testing`,
      '',
      `Execution budget reached at ${budgetMinutes} minutes, but every planned mutant had already finished; recorded as complete.`,
      '',
    ].join('\n');
    writeFileSync(`${output}/summary.md`, markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
    console.log(markdown);
    return 'raced-complete';
  }
  const unfinished = shard.expected.filter((key) => !finishedByKey.has(key));
  // Every unfinished planned mutant still gets a `Pending` stub in the synthetic report, built
  // from the plan alone (same location, mutator, and replacement a finished result would carry).
  // Without this, buildFindings's ordinal sequence (scripts/quality/report.mts) would run only
  // over the mutants that actually finished, so a survivor after an unfinished identical-tuple
  // mutant would take that mutant's ordinal instead of its own, changing its key once the budget
  // run and a later complete run disagree on which mutants finished.
  for (const key of unfinished) {
    const parsed = parseMutantKey(key);
    sourceFor(parsed.file).mutants.push({
      id: `pending:${parsed.file}:${parsed.location.start.line}:${parsed.location.start.column}`,
      fileName: parsed.file,
      status: 'Pending',
      mutatorName: parsed.mutatorName,
      replacement: parsed.replacement,
      location: parsed.location,
    });
  }
  writeFileSync(
    `${output}/mutation.json`,
    JSON.stringify(
      {
        schemaVersion: '1.0',
        thresholds: { high: 90, low: 70 },
        files: reportFiles,
        testFiles: {},
      },
      null,
      2,
    ),
  );
  writeFileSync(
    `${output}/completion.json`,
    JSON.stringify(
      {
        digest: plan.digest,
        index: shard.index,
        complete: false,
        total: shard.expected.length,
        status: 'partial',
        unfinished,
      },
      null,
      2,
    ),
  );
  const markdown = [
    `## ${workspace!.name}: mutation testing`,
    '',
    `Execution budget reached: ${budgetMinutes} minutes elapsed with ${unfinished.length} of ${shard.expected.length} planned mutants unfinished.`,
    `${finishedByKey.size} mutants finished and are included below. Unfinished mutants are not detected or surviving; they were never run.`,
    '',
  ].join('\n');
  writeFileSync(`${output}/summary.md`, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  return 'partial';
}

if (values.check === 'risk') {
  // Per file, not just per batch: a failing related spec then marks only that file incomplete.
  const nativeSpecs = new Map(
    files.map(({ file }, index) => [
      file,
      listRelatedTests({
        jestBin,
        config: workspace.config,
        cwd: workspace.path,
        env,
        files: [localFiles[index]],
      }),
    ]),
  );
  const tests = [...new Set([...nativeSpecs.values()].flat())];
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
  const nativeCoverage: unknown = JSON.parse(readFileSync(`${output}/coverage-final.json`, 'utf8'));
  if (
    nativeCoverage === null ||
    typeof nativeCoverage !== 'object' ||
    Array.isArray(nativeCoverage)
  ) {
    throw new Error('Invalid native coverage-final.json');
  }
  const nativeLabel = `${workspace.path} tests`;
  const nativeRevision = checkRevision(workspace.path, selection.head, localFiles);
  const nativeRun: RunEvidence = {
    label: nativeLabel,
    coverage: nativeCoverage as Record<string, unknown>,
    suites: suiteStatuses(readGroupResults(output, coverageGroups(workspace.name, tests))),
    relatedSpecs: Object.fromEntries(
      [...nativeSpecs].map(([file, specs]) => [resolve(file), specs]),
    ),
    revision: nativeRevision,
  };
  const runsByFile = new Map<string, RunEvidence[]>(files.map(({ file }) => [file, [nativeRun]]));
  let coverageScope = nativeLabel;

  // packages/api source also gets coverage from api/ specs via a source alias, since those specs
  // only ever import the built `@librechat/api` package, never packages/api/src directly.
  if (workspace.name === 'api') {
    const aliasConfig = fileURLToPath(new URL('./jest.source.cjs', import.meta.url));
    const aliasCwd = process.cwd();
    const bSpecs = new Map(
      files.map(({ file }) => [
        file,
        listRelatedTests({ jestBin, config: aliasConfig, cwd: aliasCwd, env, files: [file] }),
      ]),
    );
    const bTests = [...new Set([...bSpecs.values()].flat())];
    writeFileSync(`${output}/b-selected-tests.json`, JSON.stringify(bTests, null, 2));
    if (bTests.length) {
      const aliasBudgetMinutes = resolveAliasBudgetMinutes(
        process.env.QUALITY_ALIAS_BUDGET_MINUTES,
      );
      const revision = checkRevision(
        aliasCwd,
        selection.head,
        files.map(({ file }) => file),
      );
      const outcome = await runAliasCoverage({
        config: aliasConfig,
        cwd: aliasCwd,
        jestBin,
        tests: bTests,
        collectFrom: files.map(({ file }) => file),
        output: `${output}/b`,
        env,
        budgetMinutes: aliasBudgetMinutes,
      });
      const bLabel = 'api/ specs (source alias)';
      const bRun: RunEvidence = outcome.ok
        ? {
            label: bLabel,
            coverage: outcome.value.coverage,
            suites: suiteStatuses(outcome.value.results),
            relatedSpecs: Object.fromEntries(
              [...bSpecs].map(([file, specs]) => [resolve(file), specs]),
            ),
            revision,
          }
        : { label: bLabel, coverage: {}, suites: [], runFailure: outcome.error.message };
      for (const { file } of files) runsByFile.get(file)!.push(bRun);
      if (outcome.ok)
        coverageScope = `${nativeLabel} + ${bRun.label} for changed packages/api files`;
    }
  }

  const coverageResults = files.map(({ file }) => mergeFileCoverage(file, runsByFile.get(file)!));
  writeFileSync(`${output}/coverage-states.json`, JSON.stringify(coverageResults, null, 2));
  const mergedCoverageFile = `${output}/coverage-merged.json`;
  writeFileSync(
    mergedCoverageFile,
    JSON.stringify(
      Object.fromEntries(
        coverageResults
          .filter((result) => result.entry)
          .map((result) => [resolve(result.file), result.entry]),
      ),
    ),
  );
  const report = riskReport(mergedCoverageFile, files, {
    base: selection.base,
    coverageResults,
    coverageScope,
  });
  writeFileSync(
    `${output}/risk.json`,
    JSON.stringify({ base: selection.base, head: selection.head, ...report }, null, 2),
  );
  summary(riskMarkdown(report));
} else if (!values['mutation-worker']) {
  // The actual run happens in a child process (re-running this script with the hidden
  // `--mutation-worker` flag) that this process can signal at the deadline.
  const budgetMinutes = resolveMutationBudgetMinutes(process.env.QUALITY_MUTATION_BUDGET_MINUTES);
  console.log(`Mutation run: execution budget is ${budgetMinutes} minutes.`);
  const { timedOut, exitCode } = await runWithinBudget(
    process.execPath,
    [process.argv[1]!, ...process.argv.slice(2), '--mutation-worker'],
    budgetMinutes * 60_000,
  );
  if (!timedOut) process.exit(exitCode ?? 1);
  process.exit(finalizeBudgetTimeout(budgetMinutes) === 'raced-complete' ? 0 : 1);
} else {
  process.env.NODE_ENV = env.NODE_ENV;
  process.env.BABEL_ENV = env.BABEL_ENV;
  console.log(`Mutation run: static=${values.static}. ${staticDescription}`);
  const rawTargets = allMutationTargets(files);
  const allTargets = rawTargets.filter(({ mutate }) => mutate.length);
  const advisory = suppressionAdvisory(rawTargets);
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
    // The merge step renders `suppressions` later; keep its shape stable.
    writeFileSync(
      `${output}/plan.json`,
      JSON.stringify({ ...plan, suppressions: advisory }, null, 2),
    );
    console.log(
      `Mutation shard ${shard.index}/${plan.shards.length}: ${shard.expected.length} planned mutants; two workers; static=${values.static}`,
    );
  }
  writeFileSync(`${output}/functions.json`, JSON.stringify(targets, null, 2));
  // Advisory only: a suppression with no reason or naming `all` does not fail the run.
  const suppressionNotes = advisory.map(
    (item) =>
      `${item.file}:${item.line} \`${item.text}\`${item.problem === 'all' ? ' (unscoped `all`)' : ' (no reason given)'}`,
  );
  const suppressionSummary = suppressionNotes.length
    ? [
        '',
        'Suppression comments missing a reason, or naming `all`, in changed files:',
        '',
        ...suppressionNotes.map((note) => `- ${note}`),
      ]
    : [];
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
      [
        `## ${workspace.name}: mutation testing`,
        '',
        `No mutations selected for this run. Static=${values.static}.`,
        ...suppressionSummary,
        '',
      ].join('\n'),
    );
    process.exit(0);
  }
  const started = Date.now();
  const stryker = new Stryker({
    plugins: [
      import.meta.resolve('@stryker-mutator/jest-runner'),
      new URL('./progress.mts', import.meta.url).href,
      new URL('./ignore.mts', import.meta.url).href,
    ],
    ignorers: [LOGGER_IGNORER_NAME],
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
    const compileErrors = counts.get('CompileError') ?? 0;
    const score = tested ? `${((100 * detected) / tested).toFixed(2)}%` : 'N/A (no valid mutants)';
    // Invalid (RuntimeError/CompileError) mutants: the mutated program could not be run to a
    // result at all. Every planned mutant still finished with some status, so the shard itself
    // is complete; these are shown in the report as invalid and excluded from the score, not
    // treated as a tool failure.
    const invalidNotes = [
      runtimeErrors
        ? `${runtimeErrors} mutant${runtimeErrors === 1 ? '' : 's'} had runtime errors (the mutated code crashed the tests, often while a test file loads). They are listed as invalid and are not counted in the scores.`
        : undefined,
      compileErrors
        ? `${compileErrors} mutant${compileErrors === 1 ? '' : 's'} had compile errors. They are listed as invalid and are not counted in the scores.`
        : undefined,
    ].filter((note): note is string => note !== undefined);
    summary(
      [
        `## ${workspace.name}: mutation testing (advisory)`,
        '',
        `${describeMutatedScope(targets)} Static=${values.static}. ${staticDescription} Duration: ${((Date.now() - started) / 60000).toFixed(1)} minutes.`,
        '',
        `Mutation score: ${score}. Surviving and uncovered mutants reduce this score. Ignored and invalid mutants are excluded.`,
        ...invalidNotes,
        '',
        '| Result | Mutants |',
        '| --- | ---: |',
        ...[...counts].map(([status, count]) => `| ${status} | ${count} |`),
        ...suppressionSummary,
        '',
        'Download the report artifact for the HTML report and each mutation location.',
        '',
      ].join('\n'),
    );
    completeShard();
  } catch (error) {
    summary(
      `## ${workspace.name}: mutation testing\n\nStryker failed. This is not a mutation score. See the test log.\n`,
    );
    throw error;
  }
}
