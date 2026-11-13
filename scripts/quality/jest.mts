import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { literalGlob } from './changes.mts';
import { runWithinBudget } from './budget.mts';

/** Jest accepts one JSON string for collectCoverageFrom, not separate file arguments. */
export function coverageArgs(
  config: string,
  files: string[],
  output: string,
  tests: string[],
  serial = false,
): string[] {
  return [
    '--config',
    config,
    '--ci',
    ...(serial ? ['--runInBand'] : []),
    '--forceExit',
    '--coverage',
    '--coverageProvider=babel',
    '--coverageReporters=json',
    '--coverageDirectory',
    output,
    '--coverageThreshold={}',
    '--json',
    '--outputFile',
    `${output}/tests.json`,
    '--passWithNoTests',
    '--collectCoverageFrom',
    JSON.stringify(files.map(literalGlob)),
    '--runTestsByPath',
    ...tests,
  ];
}

/** Redis integration suites use the same environment and ordering as the cache CI lane. */
export function coverageGroups(workspace: string, tests: string[]) {
  const groups = [
    { name: 'unit', tests: [] as string[], redis: false, serial: false },
    { name: 'cache-core', tests: [] as string[], redis: true, serial: false },
    { name: 'cache-cluster', tests: [] as string[], redis: true, serial: true },
    { name: 'cache-mcp', tests: [] as string[], redis: true, serial: false },
    { name: 'cache-stream', tests: [] as string[], redis: true, serial: true },
  ];
  for (const test of tests) {
    const path = test.replaceAll('\\', '/');
    let group = 0;
    if (workspace === 'api') {
      if (path.includes('.stream_integration.')) group = 4;
      else if (path.includes('.cache_integration.')) {
        group = path.includes('/src/cluster/') ? 2 : path.includes('/src/mcp/') ? 3 : 1;
      }
    }
    groups[group].tests.push(test);
  }
  return groups.filter(({ tests }) => tests.length);
}

export function runCoverage(options: {
  workspace: string;
  config: string;
  cwd: string;
  jestBin: string;
  files: string[];
  tests: string[];
  output: string;
  env: NodeJS.ProcessEnv;
}) {
  const { workspace, config, cwd, jestBin, files, tests, output, env } = options;
  // Use the coverage merger installed with the measured head's Jest.
  const { createCoverageMap } = createRequire(jestBin)(
    'istanbul-lib-coverage',
  ) as typeof import('istanbul-lib-coverage');
  mkdirSync(output, { recursive: true });
  const combined = createCoverageMap({});
  const groups = coverageGroups(workspace, tests);
  writeFileSync(`${output}/test-groups.json`, JSON.stringify(groups, null, 2));
  for (const group of groups) {
    const directory = groups.length === 1 ? output : `${output}/${group.name}`;
    mkdirSync(directory, { recursive: true });
    const reports = ['coverage-final.json', 'tests.json'];
    for (const name of reports) rmSync(`${output}/${name}`, { force: true });
    console.log(`Coverage group: ${group.name}; ${group.tests.length} test files`);
    const result = spawnSync(
      process.execPath,
      // Jest includes coverageDirectory in its transform-cache key. Keep it stable across groups.
      [jestBin, ...coverageArgs(config, files, output, group.tests, group.serial)],
      {
        cwd,
        stdio: 'inherit',
        env: { ...env, ...(group.redis ? { USE_REDIS: 'true', USE_REDIS_CLUSTER: 'false' } : {}) },
      },
    );
    if (directory !== output) {
      for (const name of reports) {
        if (existsSync(`${output}/${name}`))
          renameSync(`${output}/${name}`, `${directory}/${name}`);
      }
    }
    if (result.error || result.status !== 0) {
      throw (
        result.error ??
        new Error(`Jest ${group.name} exited with ${result.status ?? result.signal}`)
      );
    }
    const file = `${directory}/coverage-final.json`;
    if (!existsSync(file)) throw new Error('Jest did not produce coverage');
    combined.merge(JSON.parse(readFileSync(file, 'utf8')));
  }
  writeFileSync(`${output}/coverage-final.json`, JSON.stringify(combined.toJSON()));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Concatenates every coverage group's `--json` results into one `AggregatedResult`-shaped object. */
export function readGroupResults(output: string, groups: { name: string }[]): unknown {
  const testResults: unknown[] = [];
  for (const group of groups) {
    const directory = groups.length === 1 ? output : `${output}/${group.name}`;
    const file = `${directory}/tests.json`;
    if (!existsSync(file)) continue;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && Array.isArray(parsed.testResults))
      testResults.push(...parsed.testResults);
  }
  return { testResults };
}

/** Lists Jest specs related to `files`, resolved against `config` from `cwd`. No coverage run. */
export function listRelatedTests(options: {
  jestBin: string;
  config: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  files: string[];
}): string[] {
  const { jestBin, config, cwd, env, files } = options;
  if (!files.length) return [];
  const listed = spawnSync(
    process.execPath,
    [
      jestBin,
      '--config',
      config,
      '--listTests',
      '--json',
      '--runInBand',
      '--findRelatedTests',
      ...files,
    ],
    { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (listed.error || listed.status !== 0) {
    throw listed.error ?? new Error(`Jest test selection failed: ${listed.stderr}`);
  }
  const tests: unknown = JSON.parse(listed.stdout);
  if (!Array.isArray(tests) || tests.some((test) => typeof test !== 'string')) {
    throw new Error('Invalid Jest test selection');
  }
  return tests;
}

/** Validates `QUALITY_ALIAS_BUDGET_MINUTES` against the risk job's 45-minute timeout. */
export function resolveAliasBudgetMinutes(raw: string | undefined): number {
  const value = raw === undefined || raw === '' ? '20' : raw;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 25) {
    throw new Error(
      `QUALITY_ALIAS_BUDGET_MINUTES must be an integer from 1 to 25 minutes (got ${JSON.stringify(raw)})`,
    );
  }
  return minutes;
}

export interface AliasCoverageResult {
  /** Parsed Jest `AggregatedResult` JSON. */
  results: unknown;
  /** Parsed `coverage-final.json`, or `{}` when the run produced none. */
  coverage: Record<string, unknown>;
}

export interface AliasCoverageFailure {
  code: 'timeout' | 'crashed';
  message: string;
}

export type AliasCoverageOutcome =
  | { ok: true; value: AliasCoverageResult }
  | { ok: false; error: AliasCoverageFailure };

const { mirrorDir } = createRequire(import.meta.url)('./jest.source.resolver.cjs') as {
  mirrorDir: (root: string) => string;
};

/** Source-alias pass: a one-shot Babel coverage run against `tests`, limited to `collectFrom`
 * and bounded by `budgetMinutes`. Timeout, crash or missing output return a failure value
 * instead of throwing; a failing or runtime-errored suite is a normal, successful run. */
export async function runAliasCoverage(options: {
  config: string;
  cwd: string;
  jestBin: string;
  tests: string[];
  collectFrom: string[];
  output: string;
  env: NodeJS.ProcessEnv;
  budgetMinutes: number;
}): Promise<AliasCoverageOutcome> {
  const { config, cwd, jestBin, tests, collectFrom, output, env, budgetMinutes } = options;
  mkdirSync(output, { recursive: true });
  // A spec's relative imports of packages/api/src load the resolver's mirror copy. Istanbul
  // instruments that copy only when collectCoverageFrom names its mirror path, and then records
  // its hits under the real path with the same hash, so both copies add to one entry.
  const root = realpathSync(cwd);
  const src = join(root, 'packages/api/src');
  const mirror = mirrorDir(root);
  const mirrorFrom = collectFrom
    .map((file) => resolve(root, file))
    .filter((file) => file.startsWith(src + sep))
    .map((file) => relative(root, mirror + file.slice(src.length)));
  const resultsFile = `${output}/tests.json`;
  const coverageFile = `${output}/coverage-final.json`;
  for (const file of [resultsFile, coverageFile]) rmSync(file, { force: true });
  // The config links the mirror; removing it afterwards keeps a second copy of packages/api/src
  // out of later directory walks over the checkout.
  const { timedOut, exitCode } = await runWithinBudget(
    process.execPath,
    [jestBin, ...coverageArgs(config, [...collectFrom, ...mirrorFrom], output, tests)],
    budgetMinutes * 60_000,
    { cwd, env },
  ).finally(() => rmSync(mirror, { force: true }));
  if (timedOut) {
    return {
      ok: false,
      error: {
        code: 'timeout',
        message: `api/ source-alias pass exceeded ${budgetMinutes} min budget`,
      },
    };
  }
  try {
    if (!existsSync(resultsFile)) {
      throw new Error(`no results file (exit ${exitCode === null ? 'signal' : exitCode})`);
    }
    const results: unknown = JSON.parse(readFileSync(resultsFile, 'utf8'));
    const coverage: unknown = existsSync(coverageFile)
      ? JSON.parse(readFileSync(coverageFile, 'utf8'))
      : {};
    if (!isRecord(coverage)) throw new Error('coverage-final.json is not an object');
    return { ok: true, value: { results, coverage } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'crashed',
        message: `api/ source-alias pass crashed: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
