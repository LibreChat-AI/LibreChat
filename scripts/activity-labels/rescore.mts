/**
 * Offline rescore: recompute checks over a stored results JSON after a
 * metric change, without re-calling the API. Chains are rebuilt from the
 * stored labels in push order (steps within a case ran serially).
 *
 * Usage: node scripts/activity-labels/rescore.mts [results/<file>.json]
 */
import { fileURLToPath } from 'node:url';
import { basename, join, resolve } from 'node:path';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

import type { EvalStep, StoredResults } from './types.mts';
import { aggregate, markdownReport } from './report.mts';
import { cases, stepEntries } from './corpus.mts';
import { checkLabel } from './checks.mts';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

function newestResults(): string {
  const files = readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const newest = files.at(-1);
  if (newest == null) {
    throw new Error('no stored results to rescore');
  }
  return join(RESULTS_DIR, newest);
}

const sourcePath = process.argv[2] ? resolve(process.argv[2]) : newestResults();
const { args, records } = JSON.parse(readFileSync(sourcePath, 'utf8')) as StoredResults;

const stepsByCase = new Map<string, Map<string, EvalStep>>(
  cases.map((testCase) => [
    testCase.id,
    new Map(testCase.steps.map((step) => [step.id ?? testCase.id, step])),
  ]),
);

const chains = new Map<string, string[]>();
for (const record of records) {
  if ('error' in record) {
    continue;
  }
  const key = `${record.variant}\0${record.sample}\0${record.caseId}`;
  let chain = chains.get(key);
  if (chain == null) {
    chain = [];
    chains.set(key, chain);
  }
  const step = stepsByCase.get(record.caseId)?.get(record.stepId);
  const { flags, wordCount, firstWord } = checkLabel(record.label, {
    entries: step != null ? stepEntries(step) : [],
    previousLabels: chain,
  });
  record.flags = flags;
  record.wordCount = wordCount;
  record.firstWord = firstWord;
  chain.push(record.label);
}

const variantNames = [...new Set(records.map((record) => record.variant))];
const runCases = cases.filter((testCase) =>
  records.some((record) => record.caseId === testCase.id),
);
const report = markdownReport({
  records,
  aggregates: aggregate(records, args.model),
  runCases,
  variantNames,
  model: args.model,
  samples: args.samples,
});
writeFileSync(join(RESULTS_DIR, 'latest.md'), report);
console.log(`rescored ${basename(sourcePath)}`);
console.log(report.split('## Per-case')[0]);
console.log('full per-case tables: scripts/activity-labels/results/latest.md');
