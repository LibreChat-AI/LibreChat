import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { literalGlob } from './changes.mts';

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
