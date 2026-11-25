#!/usr/bin/env node
/**
 * Pre-push gate: runs the static checks (scripts/static-checks.mts, slow tier
 * included) against the exact commits a push sends, scoped to each commit's
 * diff from the base branch the way CI scopes a pull request.
 *
 * The checks read the working tree, so the gate only runs them when the
 * working tree provably is the pushed commit: every pushed commit must be the
 * checked-out HEAD and the worktree must have no tracked or untracked changes.
 * Anything else is refused rather than checked, because an uncommitted fix
 * would otherwise pass a commit that fails in CI. Nothing is stashed, reset or
 * cleaned; the refusal says what to commit or move aside.
 *
 * A pass is remembered by tree and merge base, so pushing the same content
 * again (another remote, a second branch name, a retried push) does not rerun
 * the checks. Only passes are cached, and only after the worktree is confirmed
 * unchanged by the run.
 *
 * Git passes the remote name and URL as arguments and one line per ref on
 * stdin: `<local ref> <local sha> <remote ref> <remote sha>`. The base is
 * LIBRECHAT_PRE_PUSH_BASE when set, else `<remote>/dev`, else `origin/dev`.
 * Bypass with `git push --no-verify`; CI stays authoritative.
 */

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Everything the Static Checks job runs except the config migration tests,
 * which are Jest suites: unit tests belong to the PR's test lanes, not a hook.
 */
const CHECK_ARGS = ['--full', '--skip', 'config-tests'];
const CACHE_FILE = 'librechat-pre-push.cache';
const CACHE_LIMIT = 200;
const ZERO_SHA = /^0+$/;

interface RefUpdate {
  localRef: string;
  localSha: string;
}

interface GitResult {
  ok: boolean;
  out: string;
  /** stderr, or the spawn error, for a refusal to quote. */
  err: string;
}

function git(args: string[], cwd: string): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr || result.error?.message || `exited with ${result.status}`).trim(),
  };
}

/** A git read the gate cannot continue without: its output, or null after refusing. */
function required(result: GitResult, what: string): string | null {
  if (result.ok && result.out) return result.out;
  refuse(`could not read ${what}: ${result.err}`);
  return null;
}

function refuse(message: string): number {
  console.error(`\npre-push: ${message}\n(bypass with git push --no-verify; CI still runs)`);
  return 1;
}

function parseUpdates(input: string): RefUpdate[] {
  return input
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4)
    .map(([localRef, localSha]) => ({ localRef, localSha }));
}

/**
 * An explicit base is the only candidate: falling back from a canary or
 * stacked-parent base to dev would check a different diff than the PR's.
 */
function resolveBase(remote: string, cwd: string, explicit?: string): string | null {
  const candidates = explicit
    ? [explicit]
    : [`refs/remotes/${remote}/dev`, 'refs/remotes/origin/dev'];
  for (const ref of candidates) {
    const commit = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (commit.ok && commit.out) return commit.out;
  }
  return null;
}

/**
 * Tracked and untracked (not ignored) changes, as porcelain lines, or null when
 * git could not say. Empty output from a failed status is not a clean worktree.
 */
function worktreeChanges(cwd: string): string[] | null {
  const status = git(['status', '--porcelain', '--untracked-files=normal'], cwd);
  if (!status.ok) {
    refuse(`could not read the worktree status: ${status.err}`);
    return null;
  }
  return status.out.split('\n').filter(Boolean);
}

function readCache(path: string): Set<string> {
  return existsSync(path) ? new Set(readFileSync(path, 'utf8').split('\n')) : new Set();
}

function remember(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${key}\n`);
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length > CACHE_LIMIT) writeFileSync(path, `${lines.slice(-CACHE_LIMIT).join('\n')}\n`);
}

export function prePush(remote: string, input: string, cwd = process.cwd()): number {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return refuse('not inside a git worktree');
  const root = top.out;

  // Deletions carry an all-zero local sha; a ref naming a tree or blob has no
  // commit to check. Neither sends code CI would build. Anything else has to
  // peel to a commit: a git error here must not drop the ref from the check.
  const refsByCommit = new Map<string, string[]>();
  for (const update of parseUpdates(input)) {
    if (ZERO_SHA.test(update.localSha)) continue;
    const type = required(git(['cat-file', '-t', update.localSha], root), update.localRef);
    if (type === null) return 1;
    if (type === 'tree' || type === 'blob') continue;
    const commit = required(
      git(['rev-parse', '--verify', `${update.localSha}^{commit}`], root),
      `the commit ${update.localRef} points at`,
    );
    if (commit === null) return 1;
    refsByCommit.set(commit, [...(refsByCommit.get(commit) ?? []), update.localRef]);
  }
  if (refsByCommit.size === 0) {
    console.log('pre-push: no commits to check (deletions only)');
    return 0;
  }

  const explicit = process.env.LIBRECHAT_PRE_PUSH_BASE;
  const base = resolveBase(remote, root, explicit);
  if (!base && explicit) {
    return refuse(
      `LIBRECHAT_PRE_PUSH_BASE=${explicit} does not name a commit; fetch it or fix the ref.`,
    );
  }
  if (!base) {
    return refuse(
      `no base branch to diff against: neither ${remote}/dev nor origin/dev exists. ` +
        'Fetch it, or set LIBRECHAT_PRE_PUSH_BASE to the ref the pull request targets.',
    );
  }

  const cacheFile = required(git(['rev-parse', '--git-path', CACHE_FILE], root), 'the git dir');
  if (cacheFile === null) return 1;
  const cachePath = resolve(root, cacheFile);
  const cache = readCache(cachePath);
  const pending: { commit: string; key: string; mergeBase: string; refs: string[] }[] = [];
  for (const [commit, refs] of refsByCommit) {
    const mergeBase = git(['merge-base', base, commit], root);
    if (!mergeBase.ok) {
      return refuse(`${refs.join(', ')} shares no history with the base ${base.slice(0, 10)}`);
    }
    const tree = required(git(['rev-parse', `${commit}^{tree}`], root), `the tree of ${commit}`);
    if (tree === null) return 1;
    const key = [tree, mergeBase.out, ...CHECK_ARGS].join(' ');
    if (cache.has(key)) {
      console.log(`pre-push: ${refs.join(', ')} (${commit.slice(0, 10)}) already passed`);
      continue;
    }
    pending.push({ commit, key, mergeBase: mergeBase.out, refs });
  }
  if (pending.length === 0) return 0;

  const head = required(git(['rev-parse', '--verify', 'HEAD^{commit}'], root), 'HEAD');
  if (head === null) return 1;
  const elsewhere = pending.filter((entry) => entry.commit !== head);
  if (elsewhere.length > 0) {
    const named = elsewhere.map(
      (entry) => `${entry.refs.join(', ')} (${entry.commit.slice(0, 10)})`,
    );
    return refuse(
      `the checks read the working tree, so they can only verify the checked-out commit ` +
        `(${head.slice(0, 10)}). Not checked out: ${named.join('; ')}. ` +
        'Check each one out and push it from there.',
    );
  }

  const changes = worktreeChanges(root);
  if (changes === null) return 1;
  if (changes.length > 0) {
    const shown = changes.slice(0, 10).map((line) => `  ${line}`);
    if (changes.length > shown.length)
      shown.push(`  ... and ${changes.length - shown.length} more`);
    return refuse(
      `the worktree differs from ${head.slice(0, 10)}, and the checks would read those ` +
        `changes instead of what is being pushed:\n${shown.join('\n')}\n` +
        'Commit them, or move them aside yourself; nothing was stashed or reset.',
    );
  }

  const [{ mergeBase, key, refs }] = pending;
  const started = Date.now();
  console.log(`pre-push: checking ${refs.join(', ')} (${head.slice(0, 10)})`);
  const run = spawnSync(
    process.execPath,
    ['scripts/static-checks.mts', '--against', mergeBase, ...CHECK_ARGS],
    { cwd: root, stdio: 'inherit' },
  );
  const elapsed = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  if (run.status !== 0) {
    return refuse(`static checks failed for ${head.slice(0, 10)} after ${elapsed}`);
  }

  const after = required(git(['rev-parse', '--verify', 'HEAD^{commit}'], root), 'HEAD');
  if (after === null) return 1;
  const changed = worktreeChanges(root);
  if (changed === null) return 1;
  if (after !== head || changed.length > 0) {
    return refuse('the worktree changed while the checks ran; push again to recheck');
  }
  remember(cachePath, key);
  console.log(`pre-push: passed in ${elapsed}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = prePush(process.argv[2] ?? 'origin', readFileSync(0, 'utf8'));
}
