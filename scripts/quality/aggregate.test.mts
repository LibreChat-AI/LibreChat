import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { aggregate, aggregateMarkdown } from './aggregate.mts';
import { shardTargets } from './shard.mts';

const options = { head: 'head-sha', workspace: 'api', count: 3 };
const point = (line: number) => ({ line, column: 1 });
const span = (line: number) => ({ start: point(line), end: point(line + 1) });
const functions = Array.from({ length: 5 }, (_, index) => ({
  file: `packages/api/src/file${index}.ts`,
  functions: Array.from({ length: [2, 4, 1, 3, 2][index] }, (_, fn) => fn * 2 + 1).map((line) => ({
    function: `f${line}`,
    line,
    column: 1,
    location: span(line),
  })),
  mutate: [`packages/api/src/file${index}.ts:1:0-4:0`],
}));
const files = functions.map(({ file }) => ({ file, ranges: [{ start: 1, count: 4 }] }));
const outcomes = ['Killed', 'Survived', 'Timeout', 'NoCoverage', 'CompileError', 'Ignored'];
function fixtures() {
  return Array.from({ length: 3 }, (_, shard) => {
    const chosen = shardTargets(functions, { index: shard + 1, total: 3 });
    const reportFiles = Object.fromEntries(
      chosen.map(({ file }, index) => [
        file,
        {
          source: 'function source() {}',
          language: 'typescript',
          mutants: [0, 1].map((position) => ({
            id: String(index * 2 + position),
            location: span(position + 1),
            mutatorName: 'BooleanLiteral',
            replacement: 'false',
            status: outcomes[(shard * 2 + position) % outcomes.length],
            static: position === 1,
            coveredBy: ['0'],
            killedBy: position === 0 ? ['0'] : [],
            statusReason: 'preserve reason',
          })),
        },
      ]),
    );
    const total = chosen.length * 2;
    return {
      selection: {
        head: options.head,
        base: 'base-sha',
        workspace: options.workspace,
        files: structuredClone(files),
        shard: { index: shard + 1, total: 3 },
      },
      allFunctions: structuredClone(functions),
      functions: structuredClone([...chosen]),
      report: {
        schemaVersion: '1.0',
        files: reportFiles,
        testFiles: { 'tests/file.ts': { tests: [{ id: '0', name: 'test' }] } },
        framework: { name: 'Stryker' },
      },
      progress: {
        complete: true,
        completed: total,
        total,
        staticCompleted: chosen.length,
        staticTotal: chosen.length,
      },
    };
  });
}

test('aggregates every file, function, outcome, static mutant, and unchanged raw report', () => {
  const inputs = fixtures();
  const snapshot = structuredClone(inputs);
  const result = aggregate(inputs, options);
  assert.equal(result.complete, true);
  assert.equal(result.total, 10);
  assert.equal(result.completed, 10);
  assert.equal(result.staticTotal, 5);
  assert.equal(result.staticCompleted, 5);
  assert.deepEqual(result.functions, functions);
  assert.deepEqual(result.files, files);
  assert.deepEqual(result.counts, {
    Killed: 2,
    Survived: 2,
    Timeout: 2,
    NoCoverage: 2,
    CompileError: 1,
    RuntimeError: 0,
    Ignored: 1,
    Pending: 0,
  });
  assert.equal(result.score, 50);
  assert.deepEqual(
    result.shards.map(({ report }) => report),
    inputs.map(({ report }) => report),
  );
  assert.deepEqual(inputs, snapshot);
  assert.match(aggregateMarkdown(result), /CompileError \| 1/);
  assert.match(aggregateMarkdown(result), /Static mutations: 5\/5/);
});

test('shard directory ordering does not affect results or identities', () => {
  const inputs = fixtures();
  assert.deepEqual(
    aggregate([inputs[2], inputs[0], inputs[1]], options),
    aggregate(inputs, options),
  );
});

const invalid: [string, (inputs: ReturnType<typeof fixtures>) => void][] = [
  [
    'missing shard',
    (inputs) => {
      inputs.pop();
    },
  ],
  [
    'extra shard',
    (inputs) => {
      inputs.push(structuredClone(inputs[0]!));
    },
  ],
  [
    'duplicate shard index',
    (inputs) => {
      inputs[1]!.selection.shard.index = 1;
    },
  ],
  [
    'wrong shard count',
    (inputs) => {
      inputs[0]!.selection.shard.total = 4;
    },
  ],
  [
    'wrong head',
    (inputs) => {
      inputs[0]!.selection.head = 'other';
    },
  ],
  [
    'inconsistent base',
    (inputs) => {
      inputs[1]!.selection.base = 'other';
    },
  ],
  [
    'wrong workspace',
    (inputs) => {
      inputs[0]!.selection.workspace = 'client';
    },
  ],
  [
    'inconsistent original files',
    (inputs) => {
      inputs[0]!.selection.files.pop();
    },
  ],
  [
    'inconsistent full manifest',
    (inputs) => {
      inputs[1]!.allFunctions[0]!.functions[0]!.function = 'other';
    },
  ],
  [
    'dropped target file',
    (inputs) => {
      inputs[0]!.functions.pop();
    },
  ],
  [
    'dropped target function',
    (inputs) => {
      inputs[0]!.functions[0]!.functions.pop();
    },
  ],
  [
    'wrong round-robin partition',
    (inputs) => {
      inputs[0]!.functions.reverse();
    },
  ],
  [
    'out-of-shard report file',
    (inputs) => {
      inputs[0]!.report.files['packages/api/src/other.ts'] = structuredClone(
        Object.values(inputs[0]!.report.files)[0]!,
      );
    },
  ],
  [
    'runtime error',
    (inputs) => {
      Object.values(inputs[0]!.report.files)[0]!.mutants[0]!.status = 'RuntimeError';
    },
  ],
  [
    'pending mutant',
    (inputs) => {
      Object.values(inputs[0]!.report.files)[0]!.mutants[0]!.status = 'Pending';
    },
  ],
  [
    'unknown status',
    (inputs) => {
      Object.values(inputs[0]!.report.files)[0]!.mutants[0]!.status = 'Unknown';
    },
  ],
  [
    'incomplete progress',
    (inputs) => {
      inputs[0]!.progress.complete = false;
    },
  ],
  [
    'wrong completed count',
    (inputs) => {
      inputs[0]!.progress.completed--;
    },
  ],
  [
    'wrong planned count',
    (inputs) => {
      inputs[0]!.progress.total++;
    },
  ],
  [
    'wrong static completed count',
    (inputs) => {
      inputs[0]!.progress.staticCompleted--;
    },
  ],
  [
    'wrong static total count',
    (inputs) => {
      inputs[0]!.progress.staticTotal++;
    },
  ],
  [
    'duplicate mutant identity',
    (inputs) => {
      const mutants = Object.values(inputs[0]!.report.files)[0]!.mutants;
      mutants[1] = { ...mutants[0]!, id: 'new' };
    },
  ],
  [
    'duplicate local ID',
    (inputs) => {
      Object.values(inputs[0]!.report.files)[0]!.mutants[1]!.id = '0';
    },
  ],
];
for (const [name, change] of invalid) {
  test(`fails closed: ${name}`, () => {
    const inputs = fixtures();
    change(inputs);
    assert.throws(() => aggregate(inputs, options));
  });
}

test('requires explicit complete evidence for zero-mutant shards', () => {
  const inputs = fixtures();
  for (const input of inputs) {
    input.allFunctions = [];
    input.functions = [];
    input.report.files = {};
    input.progress = { complete: true, completed: 0, total: 0, staticCompleted: 0, staticTotal: 0 };
  }
  const result = aggregate(inputs, options);
  assert.equal(result.total, 0);
  assert.equal(result.score, null);
  assert.deepEqual(result.functions, []);
  const missing: unknown[] = structuredClone(inputs);
  missing[0] = { ...inputs[0], progress: undefined };
  assert.throws(() => aggregate(missing, options));
});

test('chosen function files may legitimately produce no mutants', () => {
  const inputs = fixtures();
  inputs[0]!.report.files = {};
  inputs[0]!.progress = {
    complete: true,
    completed: 0,
    total: 0,
    staticCompleted: 0,
    staticTotal: 0,
  };
  assert.equal(aggregate(inputs, options).total, 6);
});

test('malformed evidence is rejected without trusting TypeScript casts', () => {
  for (const bad of [null, [], {}, { selection: null }]) {
    assert.throws(() => aggregate([bad, bad, bad], options));
  }
  const inputs = fixtures();
  assert.throws(() => aggregate(inputs, { ...options, count: 0 }));
  assert.throws(() => aggregate(inputs, { ...options, head: '' }));
});

test('CLI uses only built-ins, reads unmerged directories, and fails without a green output', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mutation-aggregate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = join(directory, 'reports');
  const output = join(directory, 'output');
  for (const [index, shard] of fixtures().entries()) {
    const folder = join(input, `artifact-${2 - index}`);
    mkdirSync(folder, { recursive: true });
    for (const [name, value] of Object.entries({
      selection: shard.selection,
      'all-functions': shard.allFunctions,
      functions: shard.functions,
      mutation: shard.report,
      progress: shard.progress,
    })) {
      writeFileSync(join(folder, `${name}.json`), JSON.stringify(value));
    }
  }
  const args = [
    'scripts/quality/aggregate.mts',
    '--directory',
    input,
    '--head',
    options.head,
    '--workspace',
    options.workspace,
    '--count',
    '3',
    '--output',
    output,
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(output, 'aggregate.json'), 'utf8')).total, 10);
  assert.match(readFileSync(join(output, 'summary.md'), 'utf8'), /50.00%/);
  writeFileSync(join(input, 'artifact-0', 'progress.json'), 'not-json-secret-payload');
  const failed = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.doesNotMatch(failed.stderr, /secret-payload/);
  assert.throws(() => readFileSync(join(output, 'summary.md')));
});
