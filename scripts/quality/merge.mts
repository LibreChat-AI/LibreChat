import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
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
import type { SuppressionAdvisory } from './risk.mts';
import type { FindingsMeta } from './report.mts';
import type { ShardPlan } from './shards.mts';

import { assertMutants, mutantKey, parseMutantKey } from './shards.mts';
import { writeFindings } from './findings.mts';
import { buildReport } from './report.mts';

export type MutationReport = Parameters<NonNullable<Reporter['onMutationTestReportReady']>>[0];
export interface Completion {
  digest: string;
  index: number;
  complete: boolean;
  total: number;
  /** Absent (or 'complete') for a shard that tested every planned mutant. 'partial' means the
   * execution budget was reached: `unfinished` then lists the exact mutants not run. */
  status?: 'complete' | 'partial';
  unfinished?: string[];
}
export interface ShardResult {
  plan: ShardPlan;
  completion: Completion;
  report?: MutationReport;
}
export type PlanWithSuppressions = ShardPlan & { suppressions?: SuppressionAdvisory[] };

const terminalStatuses = new Set([
  'Killed',
  'Survived',
  'Timeout',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Ignored',
]);

/** Distinct from any Stryker or tool-error message, so a budget-incomplete run is never mistaken
 * for the "run succeeded with a low score" case. */
export const BUDGET_INCOMPLETE_MESSAGE = 'incomplete: execution budget reached';

/** Only publishes a score once every shard, or its finished-plus-unfinished mutants on a
 * budget-incomplete shard, accounts for its whole plan exactly. */
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
  const allUnfinished: string[] = [];
  for (const { plan: other, completion, report } of results) {
    const shard = plan.shards.find(({ index }) => index === completion.index);
    const partial = completion.status === 'partial';
    if (
      JSON.stringify(other) !== JSON.stringify(plan) ||
      completion.digest !== plan.digest ||
      !shard ||
      seen.has(shard.index) ||
      (!partial && (!completion.complete || completion.total !== shard.expected.length))
    ) {
      throw new Error('Missing, duplicate, incomplete, or mismatched shard');
    }
    seen.add(shard.index);
    if (!report) {
      if (shard.expected.length && !partial) throw new Error('Missing mutation report');
      if (!partial) continue;
    }
    if (report && report.schemaVersion !== merged.schemaVersion)
      throw new Error('Mismatched report schema');
    const prefix = (id: string) => `${shard.index}:${id}`;
    const keys: string[] = [];
    // A partial shard's reconstructed report (run.mts) carries a `Pending` stub for each mutant it
    // never ran, so buildFindings's ordinal sequence (report.mts) still accounts for it; tracked
    // separately from `keys` (finished mutants) and checked against `completion.unfinished` below,
    // rather than folded into the overall plan-coverage check, which must still see each mutant
    // exactly once.
    const pendingKeys: string[] = [];
    if (report) {
      for (const [file, value] of Object.entries(report.files)) {
        const existing = merged.files[file];
        if (
          existing &&
          (existing.source !== value.source || existing.language !== value.language)
        ) {
          throw new Error(`Mismatched source: ${file}`);
        }
        const destination = existing ?? { ...value, mutants: [] };
        merged.files[file] = destination;
        for (const mutant of value.mutants) {
          const pending = mutant.status === 'Pending';
          if (pending && !partial) throw new Error('Incomplete mutation result');
          if (!pending && !terminalStatuses.has(mutant.status))
            throw new Error('Incomplete mutation result');
          if (mutant.replacement === undefined) throw new Error('Missing mutation replacement');
          const key = mutantKey(file, { ...mutant, replacement: mutant.replacement });
          (pending ? pendingKeys : keys).push(key);
          destination.mutants.push({
            ...mutant,
            id: prefix(mutant.id),
            coveredBy: mutant.coveredBy?.map(prefix),
            killedBy: mutant.killedBy?.map(prefix),
          });
        }
      }
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
    if (partial) {
      const unfinished = (completion.unfinished ?? []).map((key) => `${shard.index}:${key}`);
      const reportedPending = pendingKeys.map((key) => `${shard.index}:${key}`);
      // The reconstructed report's own `Pending` stubs must exactly match completion.json's own
      // unfinished list: both describe the same mutants this shard never ran.
      assertMutants(unfinished, reportedPending);
      // Reconstruct each key as this shard would have produced it, then check the finished and
      // unfinished sets together cover the plan exactly: no missing, duplicate, or extra mutant.
      assertMutants(
        shard.expected.map((key) => `${shard.index}:${key}`),
        [...keys.map((key) => `${shard.index}:${key}`), ...reportedPending],
      );
      allUnfinished.push(...(completion.unfinished ?? []));
    } else {
      assertMutants(shard.expected, keys);
    }
    allKeys.push(...keys);
  }
  assertMutants(
    plan.shards.flatMap(({ expected }) => expected),
    [...allKeys, ...allUnfinished],
  );
  return merged;
}

export function mergeStatus(results: ShardResult[]): 'complete' | 'partial' {
  return results.some(({ completion }) => completion.status === 'partial') ? 'partial' : 'complete';
}

export interface UnfinishedLocation {
  file: string;
  location: { start: { line: number; column: number }; end: { line: number; column: number } };
  mutatorName: string;
}

export function collectUnfinished(results: ShardResult[]): UnfinishedLocation[] {
  return results.flatMap(({ completion }) =>
    (completion.unfinished ?? []).map((key) => {
      const parsed = parseMutantKey(key);
      return { file: parsed.file, location: parsed.location, mutatorName: parsed.mutatorName };
    }),
  );
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
      repository: { type: 'string' },
      pr: { type: 'string' },
      base: { type: 'string' },
    },
  });
  if (!values.directory || !values.workspace || !values.head || !values.repository || !values.pr)
    throw new Error('Expected --directory, --workspace, --head, --repository and --pr');
  const pr = Number(values.pr);
  // 0 means "no pull request" (a manual workflow_dispatch run with nothing to comment on).
  if (!Number.isInteger(pr) || pr < 0) throw new Error('--pr must be a non-negative integer');
  const output = resolve('coverage/changes', values.workspace, 'mutation');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  try {
    // Named up front: a shard whose report job failed, or whose artifact never uploaded, leaves
    // no completion.json. Reading it directly would throw a bare ENOENT; naming the shard here
    // instead lets the catch below report exactly which one is missing or failed.
    const missingCompletion = [1, 2, 3, 4].filter(
      (index) =>
        !existsSync(
          resolve(values.directory!, `${values.prefix}shard-${index}`, 'completion.json'),
        ),
    );
    if (missingCompletion.length) {
      throw new Error(
        `Missing completion.json for shard(s): ${missingCompletion.join(', ')} (that shard's report job likely failed or its artifact did not upload)`,
      );
    }
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
    const plan: PlanWithSuppressions = results[0].plan;
    if (plan.workspace !== values.workspace || plan.head !== values.head)
      throw new Error('Mismatched workspace or head');
    // plan.base is the merge base used to select mutation targets; --base is the request's base
    // branch tip, which normally differs from it and is what inline.mts validates findings against.
    const base = values.base || plan.base;
    const report = mergeReports(results);
    const status = mergeStatus(results);
    const unfinished = collectUnfinished(results);
    const totalExpected = plan.shards.reduce((total, shard) => total + shard.expected.length, 0);
    const meta: FindingsMeta = {
      repository: values.repository,
      pr,
      base,
      head: values.head,
      workspace: 'packages/data-schemas',
      planDigest: plan.digest,
      status,
    };
    const { findings, markdown, html } = buildReport({
      workspace: values.workspace,
      report,
      plan,
      meta,
      totalExpected,
      unfinished,
    });
    writeFileSync(`${output}/mutation.json`, JSON.stringify(report, null, 2));
    writeFileSync(`${output}/plan.json`, JSON.stringify(plan, null, 2));
    writeFileSync(`${output}/mutation.html`, html);
    writeFileSync(`${output}/report.md`, markdown);
    writeFindings(`${output}/findings.json`, findings);
    // workflow.test.mts reads this; skipped on a partial (budget-incomplete) run.
    if (status === 'complete') {
      writeFileSync(
        `${output}/summary.md`,
        mutationSummary(report, values.workspace, plan.staticMutants),
      );
    }
    // A budget-incomplete run gets its own annotation and heading, distinct from a tool error or
    // a low score, while still failing the gate below via the thrown error.
    const stepSummary =
      status === 'partial' ? `## Incomplete: execution budget reached\n\n${markdown}` : markdown;
    console.log(stepSummary);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary);
    if (status === 'partial') {
      console.log(
        `::error title=Quality incomplete::execution budget reached (${unfinished.length} of ${totalExpected} mutants unfinished)`,
      );
      throw new Error(BUDGET_INCOMPLETE_MESSAGE);
    }
  } catch (error) {
    const budgetIncomplete = error instanceof Error && error.message === BUDGET_INCOMPLETE_MESSAGE;
    if (!budgetIncomplete) {
      const detail = error instanceof Error ? error.message : String(error);
      const summary = `## ${values.workspace}: mutation testing incomplete\n\nA shard failed, is missing, or has mismatched results. No combined mutation score is available.\n\n${detail}\n`;
      writeFileSync(`${output}/summary.md`, summary);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
      // Best effort: still identify this request so inline.mts can tell a tool failure here apart
      // from a run that legitimately found nothing, without masking the error thrown below.
      try {
        writeFindings(`${output}/findings.json`, {
          schema: 'quality-findings/v1',
          repository: values.repository!,
          pr,
          base: values.base || '',
          head: values.head!,
          workspace: 'packages/data-schemas',
          planDigest: '',
          status: 'unavailable',
          findings: [],
          detected: [],
          omitted: 0,
        });
      } catch {
        // No plan or head was ever resolved; leave findings.json absent rather than invalid.
      }
    }
    throw error;
  }
}
