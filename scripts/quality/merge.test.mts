import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import type { ShardResult } from './merge.mts';
import type { ShardPlan } from './shards.mts';

import {
  BUDGET_INCOMPLETE_MESSAGE,
  collectUnfinished,
  mergeReports,
  mergeStatus,
} from './merge.mts';
import { mutantKey } from './shards.mts';
import { validateFindings } from './inline.mts';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function mutant(
  id: string,
  line: number,
  status: 'Killed' | 'Survived' | 'RuntimeError' | 'CompileError' = 'Killed',
) {
  return {
    id,
    status,
    mutatorName: 'BooleanLiteral',
    replacement: 'false',
    location: { start: { line, column: 1 }, end: { line, column: 5 } },
  };
}

/** A reconstructed shard's stand-in for a mutant it never finished (run.mts): same location,
 * mutator, and replacement a finished result would have, status `Pending`. mutantKey ignores id
 * and status, so this still produces the same key as the matching `mutant(...)` call. */
function pendingMutant(id: string, line: number) {
  return { ...mutant(id, line), status: 'Pending' as const };
}

/** Four shards, two expected mutants each, sharing one plan — the shape merge.mts requires. */
function fixture() {
  const plan: ShardPlan = {
    base: BASE,
    head: HEAD,
    workspace: 'data-schemas',
    digest: 'deadbeef',
    staticMutants: true,
    shards: [1, 2, 3, 4].map((index) => ({
      index,
      targets: [],
      expected: [
        mutantKey('a.js', mutant(`${index}-1`, index * 10)),
        mutantKey('a.js', mutant(`${index}-2`, index * 10 + 1)),
      ].sort(),
    })),
  };
  return plan;
}

function completeShard(plan: ShardPlan, index: number): ShardResult {
  const shard = plan.shards.find((item) => item.index === index)!;
  return {
    plan,
    completion: { digest: plan.digest, index, complete: true, total: shard.expected.length },
    report: {
      schemaVersion: '1.0',
      thresholds: { high: 90, low: 70 },
      files: {
        'a.js': {
          source: 'source',
          language: 'javascript',
          mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
        },
      },
    },
  };
}

test('a partial shard is accepted when finished + unfinished exactly cover its plan', () => {
  const plan = fixture();
  const results: ShardResult[] = [1, 2, 3].map((index) => completeShard(plan, index));
  const shard4 = plan.shards.find((item) => item.index === 4)!;
  const [finishedKey, unfinishedKey] = shard4.expected;
  results.push({
    plan,
    completion: {
      digest: plan.digest,
      index: 4,
      complete: false,
      total: shard4.expected.length,
      status: 'partial',
      unfinished: [unfinishedKey],
    },
    report: {
      schemaVersion: '1.0',
      thresholds: { high: 90, low: 70 },
      files: {
        'a.js': {
          source: 'source',
          language: 'javascript',
          mutants: [mutant('4-1', 40, 'Survived'), pendingMutant('4-2', 41)],
        },
      },
    },
  });
  assert.equal(mergeStatus(results), 'partial');
  const merged = mergeReports(results);
  const keys = Object.values(merged.files)
    .flatMap((file) => file.mutants)
    .map((mutant) => mutantKey('a.js', { ...mutant, replacement: mutant.replacement! }));
  // The finished mutant and the unfinished one's `Pending` stub are both in the report, so
  // buildFindings's ordinal sequence accounts for the whole plan, not just what finished.
  assert.ok(keys.includes(finishedKey));
  assert.ok(keys.includes(unfinishedKey));
  const unfinished = collectUnfinished(results);
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0].file, 'a.js');
  assert.equal(unfinished[0].location.start.line, 41);
});

test('a partial shard is rejected if finished and unfinished together miss, duplicate, or add a mutant', () => {
  const plan = fixture();
  const results: ShardResult[] = [1, 2, 3].map((index) => completeShard(plan, index));
  const shard4 = plan.shards.find((item) => item.index === 4)!;
  const [finishedKey, unfinishedKey] = shard4.expected;
  const base: ShardResult = {
    plan,
    completion: {
      digest: plan.digest,
      index: 4,
      complete: false,
      total: shard4.expected.length,
      status: 'partial',
      unfinished: [unfinishedKey],
    },
    report: {
      schemaVersion: '1.0',
      thresholds: { high: 90, low: 70 },
      files: {
        'a.js': {
          source: 'source',
          language: 'javascript',
          mutants: [mutant('4-1', 40, 'Survived'), pendingMutant('4-2', 41)],
        },
      },
    },
  };
  assert.doesNotThrow(() => mergeReports([...results, base]));

  const missing = { ...base, completion: { ...base.completion, unfinished: [] } };
  assert.throws(() => mergeReports([...results, missing]), /Mutation set differs/);

  const duplicate = {
    ...base,
    completion: { ...base.completion, unfinished: [unfinishedKey, unfinishedKey] },
  };
  assert.throws(() => mergeReports([...results, duplicate]), /Mutation set differs/);

  const extra = {
    ...base,
    completion: {
      ...base.completion,
      unfinished: [unfinishedKey, mutantKey('a.js', mutant('unexpected', 999))],
    },
  };
  assert.throws(() => mergeReports([...results, extra]), /Mutation set differs/);
});

test('mergeReports accepts RuntimeError and CompileError mutants as terminal (Invalid) results, not incomplete ones', () => {
  const plan = fixture();
  const results: ShardResult[] = [1, 2, 3].map((index) => completeShard(plan, index));
  const shard4 = plan.shards.find((item) => item.index === 4)!;
  results.push({
    plan,
    completion: { digest: plan.digest, index: 4, complete: true, total: shard4.expected.length },
    report: {
      schemaVersion: '1.0',
      thresholds: { high: 90, low: 70 },
      files: {
        'a.js': {
          source: 'source',
          language: 'javascript',
          mutants: [mutant('4-1', 40, 'RuntimeError'), mutant('4-2', 41, 'CompileError')],
        },
      },
    },
  });
  // Before RuntimeError was added to merge.mts's terminalStatuses set, this threw "Incomplete
  // mutation result" for a shard that had actually finished every planned mutant.
  assert.equal(mergeStatus(results), 'complete');
  const merged = mergeReports(results);
  const statuses = Object.values(merged.files).flatMap((file) =>
    file.mutants.map((item) => item.status),
  );
  assert.ok(statuses.includes('RuntimeError'));
  assert.ok(statuses.includes('CompileError'));
});

test('the merge CLI reports a partial run, exits non-zero with a distinct message, and skips the legacy summary', () => {
  const plan = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'quality-merge-'));
  try {
    for (const index of [1, 2, 3]) {
      const shard = plan.shards.find((item) => item.index === index)!;
      const shardDirectory = join(directory, `shard-${index}`);
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
      writeFileSync(
        join(shardDirectory, 'completion.json'),
        JSON.stringify({
          digest: plan.digest,
          index,
          complete: true,
          total: shard.expected.length,
        }),
      );
      writeFileSync(
        join(shardDirectory, 'mutation.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: {
            'a.js': {
              source: 'source',
              language: 'javascript',
              mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
            },
          },
        }),
      );
    }
    const shard4 = plan.shards.find((item) => item.index === 4)!;
    const shardDirectory = join(directory, 'shard-4');
    mkdirSync(shardDirectory);
    writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(
      join(shardDirectory, 'completion.json'),
      JSON.stringify({
        digest: plan.digest,
        index: 4,
        complete: false,
        total: shard4.expected.length,
        status: 'partial',
        unfinished: [shard4.expected[1]],
      }),
    );
    writeFileSync(
      join(shardDirectory, 'mutation.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        thresholds: { high: 90, low: 70 },
        files: {
          'a.js': {
            source: 'source',
            language: 'javascript',
            mutants: [mutant('4-1', 40, 'Survived'), pendingMutant('4-2', 41)],
          },
        },
      }),
    );
    const run = spawnSync(
      process.execPath,
      [
        'scripts/quality/merge.mts',
        '--directory',
        directory,
        '--workspace',
        'data-schemas',
        '--head',
        HEAD,
        '--repository',
        'owner/repo',
        '--pr',
        '7',
        '--base',
        BASE,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(run.status, 0);
    assert.match(run.stdout + run.stderr, new RegExp(BUDGET_INCOMPLETE_MESSAGE));
    // A budget-incomplete run gets its own annotation and heading, distinct from a tool error or
    // a low score, even though the gate outcome (non-zero exit) is the same either way.
    assert.match(
      run.stdout,
      /::error title=Quality incomplete::execution budget reached \(1 of 8 mutants unfinished\)/,
    );
    assert.match(run.stdout, /^## Incomplete: execution budget reached$/m);
    const output = 'coverage/changes/data-schemas/mutation';
    const findings = JSON.parse(readFileSync(join(output, 'findings.json'), 'utf8'));
    assert.equal(findings.status, 'partial');
    const markdown = readFileSync(join(output, 'report.md'), 'utf8');
    assert.match(markdown, /Execution budget reached/);
    assert.throws(() => readFileSync(join(output, 'summary.md'), 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync('coverage/changes/data-schemas/mutation', { recursive: true, force: true });
  }
});

test('the merge CLI writes findings against the request base tip, not the merge base, and they validate', () => {
  const plan = fixture();
  const TIP = 'f'.repeat(40);
  assert.notEqual(TIP, plan.base);
  const directory = mkdtempSync(join(tmpdir(), 'quality-merge-'));
  try {
    for (const index of [1, 2, 3, 4]) {
      const shard = plan.shards.find((item) => item.index === index)!;
      const shardDirectory = join(directory, `shard-${index}`);
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
      writeFileSync(
        join(shardDirectory, 'completion.json'),
        JSON.stringify({
          digest: plan.digest,
          index,
          complete: true,
          total: shard.expected.length,
        }),
      );
      writeFileSync(
        join(shardDirectory, 'mutation.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: {
            'a.js': {
              source: 'source',
              language: 'javascript',
              mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
            },
          },
        }),
      );
    }
    const run = spawnSync(
      process.execPath,
      [
        'scripts/quality/merge.mts',
        '--directory',
        directory,
        '--workspace',
        'data-schemas',
        '--head',
        HEAD,
        '--repository',
        'owner/repo',
        '--pr',
        '7',
        '--base',
        TIP,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const output = 'coverage/changes/data-schemas/mutation';
    const findings = JSON.parse(readFileSync(join(output, 'findings.json'), 'utf8'));
    assert.equal(findings.status, 'complete');
    assert.equal(findings.base, TIP);
    const validated = validateFindings(findings, {
      repository: 'owner/repo',
      pr: 7,
      base: TIP,
      head: HEAD,
    });
    assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync('coverage/changes/data-schemas/mutation', { recursive: true, force: true });
  }
});

test('the merge CLI combines a shard containing RuntimeError mutants into a full report: status complete, an Invalid section, scores that exclude them, and findings holding only real survivors', () => {
  const plan = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'quality-merge-'));
  try {
    for (const index of [1, 2, 3]) {
      const shard = plan.shards.find((item) => item.index === index)!;
      const shardDirectory = join(directory, `shard-${index}`);
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
      writeFileSync(
        join(shardDirectory, 'completion.json'),
        JSON.stringify({
          digest: plan.digest,
          index,
          complete: true,
          total: shard.expected.length,
        }),
      );
      writeFileSync(
        join(shardDirectory, 'mutation.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: {
            'a.js': {
              source: 'source',
              language: 'javascript',
              mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
            },
          },
        }),
      );
    }
    // Shard 4 finished both its planned mutants: one real survivor, one RuntimeError. Per the
    // fix, a finished shard with runtime errors still writes `complete: true`.
    const shard4 = plan.shards.find((item) => item.index === 4)!;
    const shardDirectory = join(directory, 'shard-4');
    mkdirSync(shardDirectory);
    writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(
      join(shardDirectory, 'completion.json'),
      JSON.stringify({
        digest: plan.digest,
        index: 4,
        complete: true,
        total: shard4.expected.length,
      }),
    );
    writeFileSync(
      join(shardDirectory, 'mutation.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        thresholds: { high: 90, low: 70 },
        files: {
          'a.js': {
            source: 'source',
            language: 'javascript',
            mutants: [mutant('4-1', 40, 'Survived'), mutant('4-2', 41, 'RuntimeError')],
          },
        },
      }),
    );
    const run = spawnSync(
      process.execPath,
      [
        'scripts/quality/merge.mts',
        '--directory',
        directory,
        '--workspace',
        'data-schemas',
        '--head',
        HEAD,
        '--repository',
        'owner/repo',
        '--pr',
        '7',
        '--base',
        BASE,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const output = 'coverage/changes/data-schemas/mutation';
    const findings = JSON.parse(readFileSync(join(output, 'findings.json'), 'utf8'));
    assert.equal(findings.status, 'complete');
    // Only the real survivor is a finding; the RuntimeError mutant is neither a finding nor
    // `detected`, so it can never mark a prior comment stale.
    assert.equal(findings.findings.length, 1);
    assert.equal(findings.findings[0].status, 'Survived');
    assert.equal(findings.findings[0].line, 40);
    const markdown = readFileSync(join(output, 'report.md'), 'utf8');
    assert.match(markdown, /### Invalid mutants/);
    assert.match(markdown, /\| Invalid \| 1 \|/);
    // The score denominator excludes the RuntimeError mutant: one Killed-equivalent-free
    // survivor out of (Killed=6, Survived=1), never counting the invalid one.
    assert.doesNotMatch(markdown, /Stryker mutation score[^\n]*N\/A/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync('coverage/changes/data-schemas/mutation', { recursive: true, force: true });
  }
});

test('the merge CLI names the specific missing shard when its completion.json is absent, without crashing on ENOENT', () => {
  const plan = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'quality-merge-'));
  try {
    for (const index of [1, 3, 4]) {
      const shard = plan.shards.find((item) => item.index === index)!;
      const shardDirectory = join(directory, `shard-${index}`);
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
      writeFileSync(
        join(shardDirectory, 'completion.json'),
        JSON.stringify({
          digest: plan.digest,
          index,
          complete: true,
          total: shard.expected.length,
        }),
      );
      writeFileSync(
        join(shardDirectory, 'mutation.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: {
            'a.js': {
              source: 'source',
              language: 'javascript',
              mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
            },
          },
        }),
      );
    }
    // Shard 2's directory (and artifact) exists — its report job ran — but its completion.json
    // never landed, e.g. the upload step dropped it. This must not crash with a bare ENOENT.
    const shard2Directory = join(directory, 'shard-2');
    mkdirSync(shard2Directory);
    writeFileSync(join(shard2Directory, 'plan.json'), JSON.stringify(plan));
    writeFileSync(
      join(shard2Directory, 'mutation.json'),
      JSON.stringify({ schemaVersion: '1.0', thresholds: { high: 90, low: 70 }, files: {} }),
    );
    const run = spawnSync(
      process.execPath,
      [
        'scripts/quality/merge.mts',
        '--directory',
        directory,
        '--workspace',
        'data-schemas',
        '--head',
        HEAD,
        '--repository',
        'owner/repo',
        '--pr',
        '7',
        '--base',
        BASE,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /ENOENT/);
    const summaryPath = join('coverage/changes/data-schemas/mutation', 'summary.md');
    const summary = readFileSync(summaryPath, 'utf8');
    assert.match(summary, /mutation testing incomplete/);
    assert.match(summary, /Missing completion\.json for shard\(s\): 2/);
    const findings = JSON.parse(
      readFileSync(join('coverage/changes/data-schemas/mutation', 'findings.json'), 'utf8'),
    );
    assert.equal(findings.status, 'unavailable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync('coverage/changes/data-schemas/mutation', { recursive: true, force: true });
  }
});

test('a missing-shard (tool error) run keeps its own message, distinct from the budget-incomplete one', () => {
  const plan = fixture();
  const directory = mkdtempSync(join(tmpdir(), 'quality-merge-'));
  try {
    // Only three of the four required shards are written, so mergeReports throws its own
    // "Expected all four shards" tool error instead of a budget-incomplete status.
    for (const index of [1, 2, 3]) {
      const shard = plan.shards.find((item) => item.index === index)!;
      const shardDirectory = join(directory, `shard-${index}`);
      mkdirSync(shardDirectory);
      writeFileSync(join(shardDirectory, 'plan.json'), JSON.stringify(plan));
      writeFileSync(
        join(shardDirectory, 'completion.json'),
        JSON.stringify({
          digest: plan.digest,
          index,
          complete: true,
          total: shard.expected.length,
        }),
      );
      writeFileSync(
        join(shardDirectory, 'mutation.json'),
        JSON.stringify({
          schemaVersion: '1.0',
          thresholds: { high: 90, low: 70 },
          files: {
            'a.js': {
              source: 'source',
              language: 'javascript',
              mutants: [mutant(`${index}-1`, index * 10), mutant(`${index}-2`, index * 10 + 1)],
            },
          },
        }),
      );
    }
    const run = spawnSync(
      process.execPath,
      [
        'scripts/quality/merge.mts',
        '--directory',
        directory,
        '--workspace',
        'data-schemas',
        '--head',
        HEAD,
        '--repository',
        'owner/repo',
        '--pr',
        '7',
        '--base',
        BASE,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 },
    );
    assert.notEqual(run.status, 0);
    assert.doesNotMatch(run.stdout + run.stderr, /Quality incomplete/);
    assert.doesNotMatch(run.stdout + run.stderr, /Incomplete: execution budget reached/);
    const markdown = readFileSync(
      join('coverage/changes/data-schemas/mutation', 'summary.md'),
      'utf8',
    );
    assert.match(markdown, /mutation testing incomplete/);
    // The trusted step still identifies this request, so a downstream consumer can tell a tool
    // failure here apart from a run with nothing to report, rather than seeing no artifact at all.
    const findings = JSON.parse(
      readFileSync(join('coverage/changes/data-schemas/mutation', 'findings.json'), 'utf8'),
    );
    assert.equal(findings.status, 'unavailable');
    assert.equal(findings.findings.length, 0);
    assert.equal(findings.base, BASE);
    assert.equal(findings.head, HEAD);
    const validated = validateFindings(findings, {
      repository: 'owner/repo',
      pr: 7,
      base: BASE,
      head: HEAD,
    });
    assert.equal(validated.ok, true, validated.ok ? undefined : validated.error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync('coverage/changes/data-schemas/mutation', { recursive: true, force: true });
  }
});
