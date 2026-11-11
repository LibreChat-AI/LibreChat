import { literalGlob } from './changes.mts';

/** Jest accepts one JSON string for collectCoverageFrom, not separate file arguments. */
export function coverageArgs(
  config: string,
  files: string[],
  output: string,
  tests: string[],
): string[] {
  return [
    '--config',
    config,
    '--ci',
    '--runInBand',
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
