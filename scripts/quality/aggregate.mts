import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

import { shardTargets } from './shard.mts';

interface Options {
  head: string;
  workspace: string;
  count: number;
}

type ObjectValue = Record<string, unknown>;
const statuses = [
  'Killed',
  'Survived',
  'Timeout',
  'NoCoverage',
  'CompileError',
  'RuntimeError',
  'Ignored',
  'Pending',
] as const;
type Status = (typeof statuses)[number];

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown): ObjectValue {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected JSON object',
  );
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  requireValue(Array.isArray(value), 'Expected JSON array');
  return value;
}
function text(value: unknown): string {
  requireValue(typeof value === 'string' && value.length > 0, 'Expected nonempty string');
  return value;
}
function integer(value: unknown, minimum = 0): number {
  requireValue(
    Number.isSafeInteger(value) && typeof value === 'number' && value >= minimum,
    'Expected nonnegative integer',
  );
  return value;
}
function path(value: unknown): string {
  const file = text(value);
  requireValue(
    !file.includes('\\') &&
      !file.startsWith('/') &&
      file.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Expected repository-relative file',
  );
  return file;
}
function location(value: unknown): ObjectValue {
  const span = object(value);
  const start = object(span.start);
  const end = object(span.end);
  const line = integer(start.line, 1);
  const column = integer(start.column, 1);
  const endLine = integer(end.line, 1);
  const endColumn = integer(end.column, 1);
  requireValue(endLine > line || (endLine === line && endColumn >= column), 'Invalid location');
  return span;
}
function targets(value: unknown) {
  const files = new Set<string>();
  return array(value).map((entry) => {
    const target = object(entry);
    const file = path(target.file);
    requireValue(!files.has(file), 'Duplicate target file');
    files.add(file);
    const functions = array(target.functions);
    requireValue(functions.length > 0 && array(target.mutate).length > 0, 'Empty mutation target');
    for (const fn of functions) {
      const row = object(fn);
      text(row.function);
      integer(row.line, 1);
      integer(row.column, 1);
      location(row.location);
    }
    for (const pattern of array(target.mutate)) text(pattern);
    return { file, functions, original: target };
  });
}

/** Validate complete file shards without changing their reports or local test/mutant IDs. */
export function aggregate(inputs: readonly unknown[], options: Options) {
  integer(options.count, 1);
  text(options.head);
  text(options.workspace);
  requireValue(inputs.length === options.count, 'Wrong shard directory count');
  const shards = inputs
    .map((input) => {
      const row = object(input);
      const selection = object(row.selection);
      const shard = object(selection.shard);
      const index = integer(shard.index, 1);
      requireValue(
        index <= options.count && shard.total === options.count,
        'Wrong shard index or count',
      );
      requireValue(selection.head === options.head, 'Wrong selection head');
      requireValue(selection.workspace === options.workspace, 'Wrong selection workspace');
      text(selection.base);
      const files = array(selection.files).map((entry) => path(object(entry).file));
      requireValue(new Set(files).size === files.length, 'Duplicate selected file');
      const all = targets(row.allFunctions);
      requireValue(
        all.every(({ file }) => files.includes(file)),
        'Target outside selected files',
      );
      targets(row.functions);
      const expected = shardTargets(all, { index, total: options.count });
      requireValue(
        isDeepStrictEqual(
          row.functions,
          expected.map(({ original }) => original),
        ),
        'Wrong file/function shard partition',
      );
      return {
        index,
        selection,
        all,
        expected,
        report: object(row.report),
        progress: object(row.progress),
      };
    })
    .sort((a, b) => a.index - b.index);
  requireValue(
    new Set(shards.map(({ index }) => index)).size === options.count,
    'Duplicate shard index',
  );
  const first = shards[0]!;
  const counts: Record<Status, number> = {
    Killed: 0,
    Survived: 0,
    Timeout: 0,
    NoCoverage: 0,
    CompileError: 0,
    RuntimeError: 0,
    Ignored: 0,
    Pending: 0,
  };
  const identities = new Set<string>();
  let staticTotal = 0;
  for (const shard of shards) {
    requireValue(shard.selection.base === first.selection.base, 'Inconsistent selection base');
    requireValue(
      isDeepStrictEqual(shard.selection.files, first.selection.files),
      'Inconsistent original selected files',
    );
    requireValue(
      isDeepStrictEqual(
        shard.all.map(({ original }) => original),
        first.all.map(({ original }) => original),
      ),
      'Inconsistent all-functions manifest',
    );
    requireValue(shard.report.schemaVersion === '1.0', 'Unsupported mutation report schema');
    let total = 0;
    let staticCount = 0;
    const ids = new Set<string>();
    for (const [file, entry] of Object.entries(object(shard.report.files))) {
      path(file);
      requireValue(
        shard.expected.some((target) => target.file === file),
        'Report file outside shard targets',
      );
      for (const value of array(object(entry).mutants)) {
        const mutant = object(value);
        const id = text(mutant.id);
        requireValue(!ids.has(id), 'Duplicate local mutant ID');
        ids.add(id);
        const span = location(mutant.location);
        const mutator = text(mutant.mutatorName);
        requireValue(typeof mutant.replacement === 'string', 'Invalid mutant replacement');
        requireValue(
          mutant.static === undefined || typeof mutant.static === 'boolean',
          'Invalid static flag',
        );
        const status = statuses.find((name) => name === mutant.status);
        requireValue(status, 'Unknown mutant status');
        requireValue(
          status !== 'RuntimeError' && status !== 'Pending',
          'Incomplete mutant outcome',
        );
        const identity = JSON.stringify([
          file,
          object(span.start).line,
          object(span.start).column,
          object(span.end).line,
          object(span.end).column,
          mutator,
          mutant.replacement,
        ]);
        requireValue(!identities.has(identity), 'Duplicate mutation identity');
        identities.add(identity);
        counts[status]++;
        total++;
        if (mutant.static === true) staticCount++;
      }
    }
    const progress = shard.progress;
    requireValue(
      progress.complete === true && progress.completed === total && progress.total === total,
      'Incomplete mutation progress',
    );
    requireValue(
      progress.staticCompleted === staticCount && progress.staticTotal === staticCount,
      'Incomplete static mutation progress',
    );
    staticTotal += staticCount;
  }
  const detected = counts.Killed + counts.Timeout;
  const tested = detected + counts.Survived + counts.NoCoverage;
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    head: options.head,
    base: first.selection.base,
    workspace: options.workspace,
    shardCount: options.count,
    complete: true,
    files: first.selection.files,
    functions: first.all.map(({ original }) => original),
    total,
    completed: total,
    staticTotal,
    staticCompleted: staticTotal,
    counts,
    score: tested ? (100 * detected) / tested : null,
    shards: shards.map(({ index, report, progress }) => ({ index, report, progress })),
  };
}

export function aggregateMarkdown(result: ReturnType<typeof aggregate>): string {
  const score = result.score === null ? 'N/A (no valid mutants)' : `${result.score.toFixed(2)}%`;
  return [
    `## ${result.workspace}: mutation testing (advisory)`,
    '',
    `Complete: ${result.shardCount} shards, ${result.completed}/${result.total} mutants. Static mutations: ${result.staticCompleted}/${result.staticTotal}.`,
    '',
    `Mutation score: ${score}. Compile errors and ignored mutants are excluded from the score, not the report.`,
    '',
    '| Result | Mutants |',
    '| --- | ---: |',
    ...statuses.map((status) => `| ${status} | ${result.counts[status]} |`),
    '',
    'Aggregate JSON retains each shard report, including source, test metadata, and unchanged local IDs.',
    '',
  ].join('\n');
}

function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: 'string' },
      head: { type: 'string' },
      workspace: { type: 'string' },
      count: { type: 'string' },
      output: { type: 'string' },
    },
  });
  requireValue(
    values.directory && values.head && values.workspace && values.count && values.output,
    'Required: --directory --head --workspace --count --output',
  );
  for (const name of ['aggregate.json', 'summary.md']) {
    rmSync(join(values.output, name), { force: true });
  }
  requireValue(/^[1-9]\d*$/u.test(values.count), 'Invalid shard count');
  const entries = readdirSync(values.directory, { withFileTypes: true });
  requireValue(
    entries.length === Number(values.count) && entries.every((entry) => entry.isDirectory()),
    'Wrong shard directory count',
  );
  const inputs = entries.map((entry) => {
    const read = (name: string): unknown => {
      try {
        return JSON.parse(readFileSync(join(values.directory!, entry.name, name), 'utf8'));
      } catch {
        throw new Error(`Missing or malformed shard ${name}`);
      }
    };
    return {
      selection: read('selection.json'),
      allFunctions: read('all-functions.json'),
      functions: read('functions.json'),
      report: read('mutation.json'),
      progress: read('progress.json'),
    };
  });
  const result = aggregate(inputs, {
    head: values.head,
    workspace: values.workspace,
    count: Number(values.count),
  });
  mkdirSync(values.output, { recursive: true });
  writeFileSync(join(values.output, 'aggregate.json'), JSON.stringify(result, null, 2));
  const markdown = aggregateMarkdown(result);
  writeFileSync(join(values.output, 'summary.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    console.error(
      'Mutation aggregation failed: shard evidence is missing, inconsistent, malformed, or incomplete.',
    );
    process.exitCode = 1;
  }
}
