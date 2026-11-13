import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import type { Reporter } from '@stryker-mutator/api/report';
import type { ShardPlan } from './shards.mts';

import { assertMutants, mutantKey } from './shards.mts';

export type MutationReport = Parameters<NonNullable<Reporter['onMutationTestReportReady']>>[0];
export interface ShardResult {
  plan: ShardPlan;
  completion: { digest: string; index: number; complete: boolean; total: number };
  report?: MutationReport;
}

const terminalStatuses = new Set([
  'Killed',
  'Survived',
  'Timeout',
  'NoCoverage',
  'CompileError',
  'Ignored',
]);

/** Only publish a score after every shard proves that its assigned mutations finished. */
export function mergeReports(results: ShardResult[]) {
  const plan = results[0]?.plan;
  if (!plan || plan.shards.length !== 4 || results.length !== 4)
    throw new Error('Expected all four shards');
  if (typeof plan.staticMutants !== 'boolean') throw new Error('Missing static mutation mode');
  const seen = new Set<number>();
  const merged: MutationReport = {
    schemaVersion: results.find(({ report }) => report)?.report?.schemaVersion ?? '1.0',
    thresholds: { high: 90, low: 70 },
    files: {},
    testFiles: {},
  };
  const allKeys: string[] = [];
  for (const { plan: other, completion, report } of results) {
    const shard = plan.shards.find(({ index }) => index === completion.index);
    if (
      JSON.stringify(other) !== JSON.stringify(plan) ||
      completion.digest !== plan.digest ||
      !completion.complete ||
      !shard ||
      seen.has(shard.index) ||
      completion.total !== shard.expected.length
    ) {
      throw new Error('Missing, duplicate, incomplete, or mismatched shard');
    }
    seen.add(shard.index);
    if (!report) {
      if (shard.expected.length) throw new Error('Missing mutation report');
      continue;
    }
    if (report.schemaVersion !== merged.schemaVersion) throw new Error('Mismatched report schema');
    const prefix = (id: string) => `${shard.index}:${id}`;
    const keys: string[] = [];
    for (const [file, value] of Object.entries(report.files)) {
      const existing = merged.files[file];
      if (existing && (existing.source !== value.source || existing.language !== value.language)) {
        throw new Error(`Mismatched source: ${file}`);
      }
      const destination = existing ?? { ...value, mutants: [] };
      merged.files[file] = destination;
      for (const mutant of value.mutants) {
        if (!terminalStatuses.has(mutant.status)) throw new Error('Incomplete mutation result');
        if (mutant.replacement === undefined) throw new Error('Missing mutation replacement');
        keys.push(mutantKey(file, { ...mutant, replacement: mutant.replacement }));
        destination.mutants.push({
          ...mutant,
          id: prefix(mutant.id),
          coveredBy: mutant.coveredBy?.map(prefix),
          killedBy: mutant.killedBy?.map(prefix),
        });
      }
    }
    assertMutants(shard.expected, keys);
    allKeys.push(...keys);
    for (const [file, value] of Object.entries(report.testFiles ?? {})) {
      const existing = merged.testFiles![file];
      if (existing && existing.source !== value.source)
        throw new Error(`Mismatched test source: ${file}`);
      merged.testFiles![file] = {
        ...value,
        tests: [
          ...(existing?.tests ?? []),
          ...value.tests.map((test) => ({ ...test, id: prefix(test.id) })),
        ],
      };
    }
  }
  assertMutants(
    plan.shards.flatMap(({ expected }) => expected),
    allKeys,
  );
  return merged;
}

export function mutationSummary(report: MutationReport, workspace: string, staticMutants = true) {
  const counts = new Map<string, number>();
  for (const file of Object.values(report.files))
    for (const mutant of file.mutants) {
      counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
    }
  const detected = (counts.get('Killed') ?? 0) + (counts.get('Timeout') ?? 0);
  const tested = detected + (counts.get('Survived') ?? 0) + (counts.get('NoCoverage') ?? 0);
  const score = tested ? `${((100 * detected) / tested).toFixed(2)}%` : 'N/A (no valid mutants)';
  return [
    `## ${workspace}: mutation testing (advisory)`,
    '',
    'All four shards completed. Every planned mutation appears exactly once.',
    staticMutants
      ? 'Static=on. Static mutations are included.'
      : 'Static=off. Static-only mutations are ignored. Hybrid mutations use per-test coverage.',
    'Ignored and invalid mutants are excluded from the score.',
    '',
    `Mutation score: ${score}. Calculated from combined counts, not averaged shard scores.`,
    '',
    '| Result | Mutants |',
    '| --- | ---: |',
    ...[...counts].sort().map(([status, count]) => `| ${status} | ${count} |`),
    '',
    'The combined JSON report contains all mutations. Each shard artifact includes its HTML report and progress logs.',
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      workspace: { type: 'string' },
      head: { type: 'string' },
      prefix: { type: 'string', default: '' },
    },
  });
  if (!values.directory || !values.workspace || !values.head)
    throw new Error('Expected --directory, --workspace and --head');
  const output = resolve('coverage/changes', values.workspace, 'mutation');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  try {
    const results = [1, 2, 3, 4].map((index): ShardResult => {
      const directory = resolve(values.directory!, `${values.prefix}shard-${index}`);
      return {
        plan: JSON.parse(readFileSync(`${directory}/plan.json`, 'utf8')),
        completion: JSON.parse(readFileSync(`${directory}/completion.json`, 'utf8')),
        report: existsSync(`${directory}/mutation.json`)
          ? JSON.parse(readFileSync(`${directory}/mutation.json`, 'utf8'))
          : undefined,
      };
    });
    const report = mergeReports(results);
    if (results[0].plan.workspace !== values.workspace || results[0].plan.head !== values.head)
      throw new Error('Mismatched workspace or head');
    writeFileSync(`${output}/mutation.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${output}/plan.json`, JSON.stringify(results[0].plan, null, 2));
    const summary = mutationSummary(report, values.workspace, results[0].plan.staticMutants);
    writeFileSync(`${output}/summary.md`, summary);
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    const summary = `## ${values.workspace}: mutation testing incomplete\n\nA shard failed, is missing, or has mismatched results. No combined mutation score is available.\n`;
    writeFileSync(`${output}/summary.md`, summary);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    throw error;
  }
}
