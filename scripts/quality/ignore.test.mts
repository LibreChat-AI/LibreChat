import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { Instrumenter } from '@stryker-mutator/instrumenter';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';

import { LoggingIgnorer, LOGGER_IGNORER_NAME, REASON } from './ignore.mts';

const disabled = () => false;
const silent = () => {};
const log = {
  isTraceEnabled: disabled,
  isDebugEnabled: disabled,
  isInfoEnabled: disabled,
  isWarnEnabled: disabled,
  isErrorEnabled: disabled,
  isFatalEnabled: disabled,
  trace: silent,
  debug: silent,
  info: silent,
  warn: silent,
  error: silent,
  fatal: silent,
};

async function instrumentWithIgnorer(source: string) {
  const instrumenter = new Instrumenter(log);
  const { mutants } = await instrumenter.instrument(
    [
      {
        name: '/tmp/fixture.js',
        content: source,
        mutate: [{ start: { line: 0, column: 0 }, end: { line: 50, column: 0 } }],
      },
    ],
    { plugins: null, ignorers: [new LoggingIgnorer()], excludedMutations: [] },
  );
  return mutants;
}

test('a standalone logger call is ignored, including the mutant that empties its statement', async () => {
  const mutants = await instrumentWithIgnorer("logger.error('failed', flag);\n");
  assert.ok(mutants.length >= 2);
  for (const mutant of mutants) {
    assert.equal(mutant.status, 'Ignored', mutant.mutatorName);
    assert.equal(mutant.statusReason, REASON);
  }
});

test('a logger call with a side-effecting argument is not ignored', async () => {
  const mutants = await instrumentWithIgnorer('logger.error(compute());\n');
  assert.ok(mutants.some((mutant) => mutant.status !== 'Ignored'));
});

test('a logger call with an optional call, tagged template, delete, or dynamic import argument is not ignored', async () => {
  for (const source of [
    "logger.info('x', o?.drain());\n",
    'logger.info(tag`x`);\n',
    "logger.info('y', delete o.k);\n",
    "logger.info('z', import('m'));\n",
  ]) {
    const mutants = await instrumentWithIgnorer(source);
    assert.ok(
      mutants.some((mutant) => mutant.status !== 'Ignored'),
      source,
    );
  }
});

test('a throw, a non-logger call and an audit call are not ignored', async () => {
  for (const source of [
    "throw new Error('failed');\n",
    "audit.record('x');\n",
    "console.log('x');\n",
  ]) {
    const mutants = await instrumentWithIgnorer(source);
    assert.ok(
      mutants.some((mutant) => mutant.status !== 'Ignored'),
      source,
    );
  }
});

test('a block of only logger calls is ignored in full; one non-logger statement keeps it live', async () => {
  const onlyLogging = await instrumentWithIgnorer(
    "function f() {\n  logger.warn('a');\n  logger.info('b');\n}\n",
  );
  const block = onlyLogging.find((mutant) => mutant.mutatorName === 'BlockStatement');
  assert.ok(block);
  assert.equal(block!.status, 'Ignored');

  const mixed = await instrumentWithIgnorer(
    "function f() {\n  logger.warn('a');\n  doThing();\n}\n",
  );
  const mixedBlock = mixed.find((mutant) => mutant.mutatorName === 'BlockStatement');
  assert.ok(mixedBlock);
  assert.notEqual(mixedBlock!.status, 'Ignored');
  // The logger call itself, and its own argument, stay ignored inside the live block.
  const mixedCall = mixed.filter((mutant) => mutant.mutatorName === 'CallExpression');
  assert.ok(mixedCall.some((mutant) => mutant.status === 'Ignored'));
});

test('a real plan and a real Stryker run agree on every mutant, including logger- and comment-ignored ones', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'quality-ignore-')));
  try {
    const source = `const logger = { info: () => {} };
function subject(value) {
  // Stryker disable next-line EqualityOperator: known safe comparison
  if (value === 1) {
    logger.info('checked', value);
    return true;
  }
  return false;
}
module.exports = { subject };
`;
    writeFileSync(join(directory, 'subject.js'), source);
    writeFileSync(join(directory, 'package-lock.json'), '{}');
    writeFileSync(
      join(directory, 'test.cjs'),
      `const assert = require('node:assert/strict');
const { subject } = require('./subject.js');
assert.equal(subject(1), true);
assert.equal(subject(2), false);\n`,
    );
    const script = `import { Stryker } from ${JSON.stringify(import.meta.resolve('@stryker-mutator/core'))};
import { mutationTarget } from ${JSON.stringify(new URL('./risk.mts', import.meta.url).href)};
import { planShards, mutantKey, assertMutants, mutationPatterns } from ${JSON.stringify(new URL('./shards.mts', import.meta.url).href)};
import { LOGGER_IGNORER_NAME } from ${JSON.stringify(new URL('./ignore.mts', import.meta.url).href)};
import { writeFileSync, readFileSync } from 'node:fs';
const source = readFileSync('subject.js', 'utf8');
const target = mutationTarget('subject.js', source, [{ start: 1, count: 9 }]);
const plan = await planShards([target], 'base', 'head', 'fixture', 1, true);
writeFileSync('plan.json', JSON.stringify(plan));
const results = await new Stryker({
  plugins: [${JSON.stringify(new URL('./ignore.mts', import.meta.url).href)}],
  ignorers: [LOGGER_IGNORER_NAME],
  testRunner: 'command',
  commandRunner: { command: ${JSON.stringify(JSON.stringify(process.execPath) + ' test.cjs')} },
  ignorePatterns: ['**', '!subject.js', '!test.cjs'],
  mutate: mutationPatterns([target]),
  reporters: ['json'],
  jsonReporter: { fileName: 'mutation.json' },
  coverageAnalysis: 'off', concurrency: 1, timeoutMS: 1000, thresholds: { break: 0 },
}).runMutationTest();
writeFileSync('results.json', JSON.stringify(results));
const shard = plan.shards[0];
assertMutants(shard.expected, results.map((m) => mutantKey('subject.js', m)));
`;
    writeFileSync(join(directory, 'run.mjs'), script);
    const run = spawnSync(process.execPath, ['run.mjs'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 60000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const results: { mutatorName: string; status: string; statusReason?: string }[] = JSON.parse(
      readFileSync(join(directory, 'results.json'), 'utf8'),
    );
    const loggerIgnored = results.filter((mutant) => mutant.statusReason === REASON);
    assert.ok(loggerIgnored.length > 0);
    assert.ok(loggerIgnored.every((mutant) => mutant.status === 'Ignored'));
    const commentIgnored = results.filter(
      (mutant) => mutant.mutatorName === 'EqualityOperator' && mutant.status === 'Ignored',
    );
    assert.ok(commentIgnored.length > 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('exported plugin declares the ignorer under its stable name', () => {
  assert.equal(LOGGER_IGNORER_NAME, 'quality-logger');
});
