import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { PlanKind } from '@stryker-mutator/api/core';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

import type { MutantResult, MutantTestPlan } from '@stryker-mutator/api/core';

import { FunctionProgressReporter } from './progress.mts';
import { mutationTarget } from './risk.mts';

test('live progress separates nested functions and static results, and retains partial evidence', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  const output = mkdtempSync(join(tmpdir(), 'quality-progress-'));
  const source = `function outer() {
  const inner = () => true;
  return false;
}
function empty() {}`;
  const target = mutationTarget('fixture.js', source, [{ start: 1, count: 5 }]);
  writeFileSync(join(output, 'functions.json'), JSON.stringify([target]));
  const reporter = new FunctionProgressReporter({
    jsonReporter: { fileName: join(output, 'mutation.json') },
  });
  const result = (
    id: string,
    token: string,
    status: MutantResult['status'],
    isStatic: boolean,
  ): MutantResult => {
    const lines = source.slice(0, source.indexOf(token)).split('\n');
    return {
      id,
      fileName: 'fixture.js',
      static: isStatic,
      status,
      mutatorName: 'BooleanLiteral',
      replacement: token === 'true' ? 'false' : 'true',
      location: {
        start: { line: lines.length, column: lines.at(-1)!.length + 1 },
        end: { line: lines.length, column: lines.at(-1)!.length + token.length + 1 },
      },
    };
  };
  const results = [
    result('0', 'true', 'Killed', false),
    result('1', 'false', 'Survived', true),
    result('2', 'false', 'NoCoverage', false),
  ];
  const plans: MutantTestPlan[] = results
    .map((result) => ({
      ...result,
      location: {
        start: { line: result.location.start.line - 1, column: result.location.start.column - 1 },
        end: { line: result.location.end.line - 1, column: result.location.end.column - 1 },
      },
    }))
    .map((mutant) =>
      mutant.status === 'NoCoverage'
        ? { plan: PlanKind.EarlyResult, mutant }
        : {
            plan: PlanKind.Run,
            mutant,
            netTime: 100,
            runOptions: {
              activeMutant: mutant,
              sandboxFileName: mutant.fileName,
              mutantActivation: mutant.static ? 'static' : 'runtime',
              reloadEnvironment: !!mutant.static,
              timeout: 1000,
              disableBail: false,
            },
          },
    );
  try {
    assert.ok(logs[0].includes('Preparing mutants and running baseline tests'));
    assert.ok(!logs[0].includes('0/0'));
    reporter.onDryRunCompleted();
    reporter.onMutationTestingPlanReady({ mutantPlans: plans });
    reporter.onMutantTested(results[2]);
    reporter.onMutantTested(results[0]);
    reporter.onMutantTested(results[0]);
    t.mock.timers.tick(30000);
    const partial = JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8'));
    assert.equal(partial.complete, false);
    assert.equal(partial.completed, 2);
    assert.equal(partial.total, 3);
    assert.equal(partial.staticCompleted, 0);
    assert.equal(partial.staticTotal, 1);
    assert.equal(partial.lastResultAgeMs, 30000);
    assert.equal(
      partial.functions.find((fn: { function: string }) => fn.function === 'inner').completed,
      1,
    );
    assert.equal(
      partial.functions.find((fn: { function: string }) => fn.function === 'outer').total,
      2,
    );
    assert.equal(
      partial.functions.find((fn: { function: string }) => fn.function === 'empty').total,
      0,
    );
    assert.ok(logs.some((line) => line.includes('DONE "fixture.js:2:17 inner"')));
    assert.ok(logs.some((line) => line.includes('PENDING "fixture.js:1:1 outer"')));
    assert.equal(readFileSync(join(output, 'progress.jsonl'), 'utf8').trim().split('\n').length, 2);
    reporter.onMutantTested(results[1]);
    reporter.onMutationTestReportReady();
    const complete = JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8'));
    assert.equal(complete.complete, true);
    assert.equal(complete.completed, 3);
    assert.equal(complete.staticCompleted, 1);
    const count = logs.length;
    t.mock.timers.tick(60000);
    assert.equal(logs.length, count, 'completed reporters stop their heartbeat');
  } finally {
    reporter.wrapUp();
    rmSync(output, { recursive: true, force: true });
  }
});

test('stopping before a report keeps the snapshot incomplete and stops the heartbeat', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const logs: string[] = [];
  t.mock.method(console, 'log', (line: string) => logs.push(line));
  const output = mkdtempSync(join(tmpdir(), 'quality-progress-stop-'));
  writeFileSync(join(output, 'functions.json'), '[]');
  const reporter = new FunctionProgressReporter({
    jsonReporter: { fileName: join(output, 'mutation.json') },
  });
  try {
    reporter.wrapUp();
    const partial = JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8'));
    assert.equal(partial.complete, false);
    assert.equal(partial.phase, 'Stopped before completion');
    const count = logs.length;
    t.mock.timers.tick(60000);
    assert.equal(logs.length, count);
  } finally {
    reporter.wrapUp();
    rmSync(output, { recursive: true, force: true });
  }
});

test('a real Stryker run loads the reporter plugin and records every result', () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'quality-progress-run-')));
  const source = 'function positive(value) { return value > 0; }\nmodule.exports = positive;\n';
  const target = mutationTarget('subject.js', source, [{ start: 1, count: 2 }]);
  const report = join(output, 'mutation.json');
  writeFileSync(join(output, 'subject.js'), source);
  writeFileSync(
    join(output, 'test.cjs'),
    "const assert = require('node:assert/strict'); const positive = require('./subject.js'); assert.equal(positive(1), true); assert.equal(positive(0), false);\n",
  );
  writeFileSync(join(output, 'functions.json'), JSON.stringify([target]));
  const options = {
    plugins: [new URL('./progress.mts', import.meta.url).href],
    testRunner: 'command',
    commandRunner: { command: `${JSON.stringify(process.execPath)} test.cjs` },
    ignorePatterns: ['**', '!subject.js', '!test.cjs'],
    mutate: target.mutate,
    reporters: ['function-progress', 'json'],
    jsonReporter: { fileName: report },
    coverageAnalysis: 'off',
    concurrency: 1,
    timeoutMS: 1000,
    thresholds: { break: 0 },
  };
  writeFileSync(
    join(output, 'run.mjs'),
    `import { Stryker } from ${JSON.stringify(import.meta.resolve('@stryker-mutator/core'))}; await new Stryker(${JSON.stringify(options)}).runMutationTest();\n`,
  );
  try {
    const run = spawnSync(process.execPath, ['run.mjs'], {
      cwd: output,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const progress = JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8'));
    const mutation = JSON.parse(readFileSync(report, 'utf8'));
    const mutants = Object.values(mutation.files).flatMap(
      (file) => (file as { mutants: unknown[] }).mutants,
    );
    assert.ok(mutants.length > 0);
    assert.equal(progress.complete, true, run.stdout + run.stderr + JSON.stringify(progress));
    assert.equal(progress.completed, mutants.length);
    assert.equal(progress.total, mutants.length);
    assert.equal(progress.functions.length, 1);
    assert.equal(progress.functions[0].function, 'positive');
    assert.match(run.stdout, /DONE .*positive/);
    assert.equal(
      readFileSync(join(output, 'progress.jsonl'), 'utf8').trim().split('\n').length,
      mutants.length,
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
