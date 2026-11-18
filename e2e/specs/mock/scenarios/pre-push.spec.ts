import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * The pre-push gate has no viewport: each scenario is one case of
 * scripts/pre-push.test.mts, which pushes through the real `.husky/pre-push`
 * hook to local bare remotes in a scratch directory. Running the case by name
 * keeps a single fixture implementation, and the verdict observed here is the
 * hook's own exit status and output as those cases assert them.
 */

const SUITE = resolve(repoRoot, 'scripts/pre-push.test.mts');
const STATIC_CHECKS = resolve(repoRoot, 'scripts/static-checks.mts');

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Runs exactly one named case of the hook suite and expects it to pass. */
function hookCase(name: string): void {
  const result = run(process.execPath, [
    '--test',
    '--test-reporter=tap',
    `--test-name-pattern=^${escape(name)}$`,
    SUITE,
  ]);
  expect(result.output, result.output).toMatch(/^# pass 1$/m);
  expect(result.output).toMatch(/^# fail 0$/m);
  expect(result.status, result.output).toBe(0);
}

test.describe('the pre-push gate', () => {
  test.beforeEach(inOneProject);

  test('a pushed branch is checked once, at the pushed commit, against its merge base @scenario:pre-push-checks-the-pushed-commit', () => {
    hookCase('checks a new branch once, at the pushed commit, against its merge base with dev');
  });

  test('a failing check rejects the push and the remote keeps its old commit @scenario:pre-push-failure-rejects-the-push', () => {
    hookCase('a failing check rejects the push and leaves the remote ref where it was');
  });

  test('uncommitted changes refuse the push instead of masking the pushed commit @scenario:pre-push-dirty-worktree-refuses', () => {
    hookCase(
      'an uncommitted fix cannot mask a broken pushed commit, and nothing is stashed or reset',
    );
  });

  test('a ref other than the checked-out commit refuses the push @scenario:pre-push-non-head-refs-refuse', () => {
    hookCase('refuses refs that are not the checked-out commit, and checks refs sharing HEAD once');
  });

  test('a deletion-only push runs no checks @scenario:pre-push-deletion-only-passes', () => {
    hookCase('a deletion-only push runs no checks');
  });

  test('the base follows the pushed remote, then origin, then an explicit ref @scenario:pre-push-base-follows-the-remote', () => {
    hookCase(
      'diffs against the pushed remote dev, then origin/dev, then an explicit base, else refuses',
    );
  });

  test('pushing content that already passed does not rerun the checks @scenario:pre-push-reuses-a-pass', () => {
    hookCase('reuses a pass for the same tree and base, including a commit no longer checked out');
  });

  test('a git status that fails refuses the push and records no pass @scenario:pre-push-status-failure-refuses', () => {
    hookCase('a git status that fails refuses the push instead of reading as a clean worktree');
  });

  test('a ref git cannot resolve refuses the push instead of passing as a deletion @scenario:pre-push-unresolved-ref-refuses', () => {
    hookCase('a ref git cannot resolve refuses the push instead of being skipped as a deletion');
  });

  test('a push from a linked worktree leaves its branch, index and config alone @scenario:pre-push-leaves-the-pushing-repository-alone', () => {
    hookCase(
      'a check that creates a scratch repository cannot reach the linked worktree being pushed',
    );
  });

  test('the imports suite builds its fixtures outside a repository named by GIT_DIR @scenario:imports-suite-ignores-inherited-git-dir', () => {
    hookCase('the imports suite keeps its fixtures out of a repository named by GIT_DIR');
  });

  test('a chat change typechecks the chat consumer specs, as the chat workspace does in CI @scenario:static-checks-typecheck-chat-consumer-specs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lc-pre-push-bun-'));
    try {
      const bin = join(dir, 'bin');
      const log = join(dir, 'bun.log');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'bun'),
        ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, 'exit 0', ''].join('\n'),
      );
      chmodSync(join(bin, 'bun'), 0o755);
      writeFileSync(log, '');

      // A stand-in `bun` first on PATH: the planner's choice of projects is
      // what is observed, and the real builds they require still run.
      const result = spawnSync(
        process.execPath,
        [STATIC_CHECKS, 'packages/chat/src/index.ts', '--only', 'typecheck'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      const checked = readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('check -p'));
      expect(checked).toEqual([
        'check -p packages/chat/tsconfig.json',
        'check -p packages/chat/test/tsconfig.json',
        'check -p client/tsconfig.json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
