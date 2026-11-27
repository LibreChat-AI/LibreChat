/** Aggregation + markdown rendering, shared by the live runner and the
 *  offline rescorer so metric fixes never require re-spending on the API. */
import type { Aggregate, ErrorRecord, EvalCase, EvalRecord, FlagType } from './types.mts';
import { FLAG_TYPES } from './types.mts';

interface Price {
  input: number;
  output: number;
}

interface AggregateState {
  steps: number;
  errors: number;
  flagCounts: Partial<Record<FlagType, number>>;
  firstWords: Record<string, number>;
  totalWords: number;
  latencies: number[];
  inputTokens: number;
  outputTokens: number;
}

interface MarkdownReportOptions {
  records: readonly EvalRecord[];
  aggregates: readonly Aggregate[];
  runCases: readonly EvalCase[];
  variantNames: readonly string[];
  model: string;
  samples: number;
}

const PRICES: Readonly<Record<string, Price>> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
};
const FLAG_TYPE_SET = new Set<string>(FLAG_TYPES);

function flagType(flag: string): FlagType {
  const type = flag.split(':')[0] ?? '';
  if (!FLAG_TYPE_SET.has(type)) {
    throw new Error(`unknown flag type: ${type}`);
  }
  return type as FlagType;
}

function isErrorRecord(record: EvalRecord): record is ErrorRecord {
  return 'error' in record;
}

export function aggregate(records: readonly EvalRecord[], model: string): Aggregate[] {
  const byVariant = new Map<string, AggregateState>();
  for (const record of records) {
    let agg = byVariant.get(record.variant);
    if (agg == null) {
      agg = {
        steps: 0,
        errors: 0,
        flagCounts: {},
        firstWords: {},
        totalWords: 0,
        latencies: [],
        inputTokens: 0,
        outputTokens: 0,
      };
      byVariant.set(record.variant, agg);
    }
    if (isErrorRecord(record)) {
      agg.errors += 1;
      continue;
    }
    agg.steps += 1;
    agg.totalWords += record.wordCount;
    agg.latencies.push(record.latencyMs);
    agg.inputTokens += record.inputTokens;
    agg.outputTokens += record.outputTokens;
    agg.firstWords[record.firstWord] = (agg.firstWords[record.firstWord] ?? 0) + 1;
    for (const flag of record.flags) {
      const type = flagType(flag);
      agg.flagCounts[type] = (agg.flagCounts[type] ?? 0) + 1;
    }
  }
  const price = PRICES[model];
  return [...byVariant.entries()].map(([name, agg]) => {
    const sortedFirst = Object.entries(agg.firstWords).sort((a, b) => b[1] - a[1]);
    const topOpener: [string, number] = sortedFirst[0] ?? ['—', 0];
    return {
      variant: name,
      steps: agg.steps,
      errors: agg.errors,
      flagCounts: agg.flagCounts,
      distinctOpeners: sortedFirst.length,
      topOpener: `${topOpener[0]} ×${topOpener[1]}`,
      avgWords: agg.steps > 0 ? (agg.totalWords / agg.steps).toFixed(1) : '—',
      meanLatencyMs: agg.latencies.length
        ? Math.round(agg.latencies.reduce((a, b) => a + b, 0) / agg.latencies.length)
        : 0,
      inputTokens: agg.inputTokens,
      outputTokens: agg.outputTokens,
      costUsd: price
        ? ((agg.inputTokens * price.input + agg.outputTokens * price.output) / 1e6).toFixed(4)
        : 'n/a',
    };
  });
}

export function markdownReport({
  records,
  aggregates,
  runCases,
  variantNames,
  model,
  samples,
}: MarkdownReportOptions): string {
  const lines: string[] = [];
  lines.push(`# Activity-label eval — ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`model: \`${model}\` · samples: ${samples} · cases: ${runCases.length}`);
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(
    `| variant | steps | ${FLAG_TYPES.join(' | ')} | distinct openers | top opener | avg words | mean ms | cost |`,
  );
  lines.push(`|---|---:|${FLAG_TYPES.map(() => '---:').join('|')}|---:|---|---:|---:|---:|`);
  for (const agg of aggregates) {
    lines.push(
      `| ${agg.variant} | ${agg.steps}${agg.errors ? ` (+${agg.errors} err)` : ''} | ` +
        FLAG_TYPES.map((type) => agg.flagCounts[type] ?? 0).join(' | ') +
        ` | ${agg.distinctOpeners} | ${agg.topOpener} | ${agg.avgWords} | ${agg.meanLatencyMs} | $${agg.costUsd} |`,
    );
  }
  lines.push('');
  lines.push('## Per-case');
  for (const testCase of runCases) {
    lines.push('');
    lines.push(`### ${testCase.id}`);
    lines.push('');
    lines.push(`*${testCase.notes}*`);
    lines.push('');
    const sampleList = [...new Set(records.map((record) => record.sample))].sort(
      (first, second) => first - second,
    );
    const header = ['step'];
    if (samples > 1) {
      header.push('s');
    }
    if (testCase.steps.some((step) => step.productionLabel)) {
      header.push('production');
    }
    header.push(...variantNames);
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`|${header.map(() => '---').join('|')}|`);
    for (const step of testCase.steps) {
      const stepId = step.id ?? testCase.id;
      for (const sample of sampleList) {
        const row = [stepId];
        if (samples > 1) {
          row.push(String(sample));
        }
        if (header.includes('production')) {
          row.push(step.productionLabel ?? '');
        }
        for (const variantName of variantNames) {
          const record = records.find(
            (r) =>
              r.variant === variantName &&
              r.sample === sample &&
              r.caseId === testCase.id &&
              r.stepId === stepId,
          );
          if (!record) {
            row.push('');
          } else if (isErrorRecord(record)) {
            row.push(`⛔ ${record.error}`);
          } else {
            const flagNote = record.flags.length > 0 ? ` ⚠${record.flags.join(' ⚠')}` : '';
            row.push(`${record.label}${flagNote}`);
          }
        }
        lines.push(`| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
