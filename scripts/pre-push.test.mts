/**
 * Drives the real `.husky/pre-push` hook through `git push` against local bare
 * remotes. Each fixture commits the hook and scripts/pre-push.mts as they are
 * in this checkout, plus a stand-in for scripts/static-checks.mts that fails
 * when the working tree's `app.txt` says `error` and logs every invocation, so
 * a test can tell which content the checks read and against which base.
 *
 *   node --test scripts/pre-push.test.mts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STUB = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const app = readFileSync('app.txt', 'utf8').trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args: process.argv.slice(2), app, head }) + '\\n');
const scratch = process.env.STUB_SCRATCH_REPO;
if (scratch) {
  mkdirSync(scratch);
  writeFileSync(scratch + '/scratch.txt', 'scratch\\n');
  const git = (...args) => execFileSync('git', args, { cwd: scratch });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=s', '-c', 'user.email=s@s', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'scratch');
}
if (app === 'error') {
  console.error('stub: app.txt has an error');
  process.exit(1);
}
`;

interface Push {
  status: number;
  output: string;
  calls: { args: string[]; app: string; head: string }[];
}

interface Fixture {
  dir: string;
  work: string;
  git: (...args: string[]) => string;
  commit: (content: string, message?: string) => string;
  push: (args: string[], env?: Record<string, string>) => Push;
  remoteSha: (ref: string, remote?: string) => string | null;
  addRemote: (name: string) => string;
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '', HUSKY: '', LIBRECHAT_PRE_PUSH_BASE: '', ...env },
  });
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

function createFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-'));
  const work = join(dir, 'work');
  const log = join(dir, 'checks.log');
  const git = (...args: string[]): string => {
    const result = run('git', args, work);
    assert.equal(result.status, 0, `git ${args.join(' ')}:\n${result.output}`);
    return result.output.trim();
  };
  const addRemote = (name: string): string => {
    const bare = join(dir, `${name}.git`);
    assert.equal(run('git', ['init', '-q', '--bare', bare], dir).status, 0);
    git('remote', 'add', name, bare);
    return bare;
  };

  mkdirSync(join(work, 'scripts'), { recursive: true });
  mkdirSync(join(work, '.husky'));
  git('init', '-q', '-b', 'dev');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.husky');
  copyFileSync(join(ROOT, 'scripts/pre-push.mts'), join(work, 'scripts/pre-push.mts'));
  copyFileSync(join(ROOT, '.husky/pre-push'), join(work, '.husky/pre-push'));
  chmodSync(join(work, '.husky/pre-push'), 0o755);
  writeFileSync(join(work, 'scripts/static-checks.mts'), STUB);
  writeFileSync(join(work, 'app.txt'), 'ok\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  addRemote('origin');
  git('push', '-q', '--no-verify', 'origin', 'dev');
  git('checkout', '-q', '-b', 'feature');

  return {
    dir,
    work,
    git,
    addRemote,
    commit(content, message = content) {
      writeFileSync(join(work, 'app.txt'), `${content}\n`);
      git('commit', '-q', '-am', message);
      return git('rev-parse', 'HEAD');
    },
    push(args, env = {}) {
      rmSync(log, { force: true });
      const result = run('git', ['push', ...args], work, { STUB_LOG: log, ...env });
      const calls = existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
      return { ...result, calls };
    },
    remoteSha(ref, remote = 'origin') {
      const result = run('git', ['ls-remote', remote, ref], work);
      return result.output.trim().split(/\s+/)[0] || null;
    },
  };
}

function withFixture(body: (fixture: Fixture) => void): () => void {
  return () => {
    const fixture = createFixture();
    try {
      body(fixture);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  };
}

test(
  'checks a new branch once, at the pushed commit, against its merge base with dev',
  withFixture((fixture) => {
    const base = fixture.git('rev-parse', 'dev');
    fixture.commit('one');
    const head = fixture.commit('two');

    const pushed = fixture.push(['origin', 'feature']);
    assert.equal(pushed.status, 0, pushed.output);
    assert.equal(pushed.calls.length, 1);
    assert.deepEqual(pushed.calls[0], {
      args: ['--against', base, '--full', '--skip', 'config-tests'],
      app: 'two',
      head,
    });
    assert.equal(fixture.remoteSha('refs/heads/feature'), head);

    // A normal fast-forward of the now-existing branch is checked the same way.
    const next = fixture.commit('three');
    const again = fixture.push(['origin', 'feature']);
    assert.equal(again.status, 0, again.output);
    assert.deepEqual(
      again.calls.map((call) => [call.args[1], call.head]),
      [[base, next]],
    );
  }),
);

test(
  'a failing check rejects the push and leaves the remote ref where it was',
  withFixture((fixture) => {
    const good = fixture.commit('good');
    assert.equal(fixture.push(['origin', 'feature']).status, 0);
    fixture.commit('error');

    const pushed = fixture.push(['origin', 'feature']);
    assert.notEqual(pushed.status, 0);
    assert.match(pushed.output, /stub: app\.txt has an error/);
    assert.match(pushed.output, /static checks failed/);
    assert.equal(fixture.remoteSha('refs/heads/feature'), good);

    // The failure is not remembered: the retry runs the checks again.
    const retry = fixture.push(['origin', 'feature']);
    assert.notEqual(retry.status, 0);
    assert.equal(retry.calls.length, 1);
  }),
);

test(
  'an uncommitted fix cannot mask a broken pushed commit, and nothing is stashed or reset',
  withFixture((fixture) => {
    fixture.commit('error');
    writeFileSync(join(fixture.work, 'app.txt'), 'fixed\n');

    const pushed = fixture.push(['origin', 'feature']);
    assert.notEqual(pushed.status, 0);
    assert.equal(pushed.calls.length, 0);
    assert.match(pushed.output, /worktree differs/);
    assert.match(pushed.output, /M app\.txt/);
    assert.equal(fixture.remoteSha('refs/heads/feature'), null);
    assert.equal(readFileSync(join(fixture.work, 'app.txt'), 'utf8'), 'fixed\n');
    assert.equal(fixture.git('stash', 'list'), '');

    // Staged-only and untracked changes count too.
    fixture.git('add', 'app.txt');
    assert.notEqual(fixture.push(['origin', 'feature']).status, 0);
    fixture.git('reset', '-q', 'app.txt');
    fixture.git('checkout', '--', 'app.txt');
    writeFileSync(join(fixture.work, 'new.ts'), 'export {};\n');
    const untracked = fixture.push(['origin', 'feature']);
    assert.notEqual(untracked.status, 0);
    assert.match(untracked.output, /\?\? new\.ts/);
    assert.ok(existsSync(join(fixture.work, 'new.ts')));
  }),
);

test(
  'refuses refs that are not the checked-out commit, and checks refs sharing HEAD once',
  withFixture((fixture) => {
    const other = fixture.commit('other');
    fixture.git('branch', 'side');
    fixture.git('reset', '-q', '--hard', 'dev');
    const head = fixture.commit('head');

    const elsewhere = fixture.push(['origin', 'side']);
    assert.notEqual(elsewhere.status, 0);
    assert.equal(elsewhere.calls.length, 0);
    assert.match(elsewhere.output, new RegExp(`refs/heads/side \\(${other.slice(0, 10)}\\)`));

    // One unverifiable ref rejects the whole push, including the valid one.
    const mixed = fixture.push(['origin', 'feature', 'side']);
    assert.notEqual(mixed.status, 0);
    assert.equal(fixture.remoteSha('refs/heads/feature'), null);

    fixture.git('tag', '-a', 'v1', '-m', 'v1');
    const shared = fixture.push(['origin', 'feature', 'v1']);
    assert.equal(shared.status, 0, shared.output);
    assert.equal(shared.calls.length, 1);
    assert.equal(shared.calls[0].head, head);
  }),
);

test(
  'a deletion-only push runs no checks',
  withFixture((fixture) => {
    fixture.commit('one');
    assert.equal(fixture.push(['origin', 'feature']).status, 0);
    fixture.commit('error');
    writeFileSync(join(fixture.work, 'dirty.txt'), 'wip\n');

    const deleted = fixture.push(['origin', '--delete', 'feature']);
    assert.equal(deleted.status, 0, deleted.output);
    assert.equal(deleted.calls.length, 0);
    assert.match(deleted.output, /deletions only/);
    assert.equal(fixture.remoteSha('refs/heads/feature'), null);
  }),
);

test(
  'diffs against the pushed remote dev, then origin/dev, then an explicit base, else refuses',
  withFixture((fixture) => {
    const originBase = fixture.git('rev-parse', 'dev');
    fixture.addRemote('fork');
    fixture.git('checkout', '-q', 'dev');
    const forkBase = fixture.commit('fork-dev');
    fixture.git('push', '-q', '--no-verify', 'fork', 'dev');
    fixture.git('fetch', '-q', 'fork');
    fixture.git('checkout', '-q', 'feature');
    fixture.git('reset', '-q', '--hard', 'dev');
    fixture.commit('feature');

    const toFork = fixture.push(['fork', 'feature']);
    assert.equal(toFork.status, 0, toFork.output);
    assert.equal(toFork.calls[0].args[1], forkBase);

    const toOrigin = fixture.push(['origin', 'feature']);
    assert.equal(toOrigin.status, 0, toOrigin.output);
    assert.equal(toOrigin.calls[0].args[1], originBase);

    // A remote with no dev of its own falls back to origin/dev.
    const mirror = fixture.addRemote('mirror');
    fixture.commit('mirror');
    const toMirror = fixture.push(['mirror', 'feature']);
    assert.equal(toMirror.status, 0, toMirror.output);
    assert.equal(toMirror.calls[0].args[1], originBase);

    fixture.commit('explicit');
    const explicit = fixture.push(['origin', 'feature'], { LIBRECHAT_PRE_PUSH_BASE: 'fork/dev' });
    assert.equal(explicit.status, 0, explicit.output);
    assert.equal(explicit.calls[0].args[1], forkBase);

    // An explicit base that does not resolve refuses rather than falling back to dev.
    fixture.commit('canary');
    const missing = fixture.push(['origin', 'feature'], { LIBRECHAT_PRE_PUSH_BASE: 'fork/canary' });
    assert.notEqual(missing.status, 0, missing.output);
    assert.equal(missing.calls.length, 0);
    assert.match(missing.output, /LIBRECHAT_PRE_PUSH_BASE=fork\/canary does not name a commit/);

    fixture.git('update-ref', '-d', 'refs/remotes/origin/dev');
    fixture.commit('baseless');
    const baseless = fixture.push([mirror, 'feature']);
    assert.notEqual(baseless.status, 0);
    assert.equal(baseless.calls.length, 0);
    assert.match(baseless.output, /no base branch/);
  }),
);

test(
  'reuses a pass for the same tree and base, including a commit no longer checked out',
  withFixture((fixture) => {
    const head = fixture.commit('one');
    assert.equal(fixture.push(['origin', 'feature']).status, 0);
    fixture.addRemote('fork');

    const sameTree = fixture.push(['fork', 'feature']);
    assert.equal(sameTree.status, 0, sameTree.output);
    assert.equal(sameTree.calls.length, 0);
    assert.match(sameTree.output, /already passed/);

    fixture.git('checkout', '-q', 'dev');
    const elsewhere = fixture.push(['origin', `${head}:refs/heads/copy`]);
    assert.equal(elsewhere.status, 0, elsewhere.output);
    assert.equal(elsewhere.calls.length, 0);
  }),
);

test(
  'skips under CI, where the workflows run the checks',
  withFixture((fixture) => {
    fixture.commit('error');
    const pushed = fixture.push(['origin', 'feature'], { CI: 'true' });
    assert.equal(pushed.status, 0, pushed.output);
    assert.equal(pushed.calls.length, 0);
  }),
);

/**
 * A `git` first on PATH that delegates to the real one, except that the
 * `subcommand` fails with a diagnostic once it has answered `passes` times. The
 * count lives in a file because every call is a new process.
 */
function failingGit(dir: string, passes: number, subcommand = 'status'): string {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(dir, 'shim');
  const count = join(dir, 'calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(count, '');
  writeFileSync(
    join(bin, 'git'),
    [
      '#!/bin/sh',
      'for arg in "$@"; do',
      `  if [ "$arg" = ${subcommand} ]; then`,
      `    printf x >> '${count}'`,
      `    if [ "$(wc -c < '${count}')" -gt ${passes} ]; then`,
      "      echo 'fatal: shim: index file corrupt' >&2",
      '      exit 128',
      '    fi',
      '  fi',
      'done',
      `exec '${real}' "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'git'), 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

/**
 * Runs the committed hook the way git does for a push of `feature` to origin,
 * with `path` as PATH. Called directly rather than through `git push`, because
 * git puts its own exec-path first on a hook's PATH and that would shadow a shim.
 */
function runHook(fixture: Fixture, path: string): Push {
  const log = join(fixture.dir, 'checks.log');
  rmSync(log, { force: true });
  const sha = fixture.git('rev-parse', 'HEAD');
  const zero = '0'.repeat(40);
  const result = spawnSync('sh', ['.husky/pre-push', 'origin', join(fixture.dir, 'origin.git')], {
    cwd: fixture.work,
    encoding: 'utf8',
    input: `refs/heads/feature ${sha} refs/heads/feature ${zero}\n`,
    env: {
      ...process.env,
      CI: '',
      HUSKY: '',
      LIBRECHAT_PRE_PUSH_BASE: '',
      STUB_LOG: log,
      PATH: path,
    },
  });
  const calls = existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}`, calls };
}

test(
  'a git status that fails refuses the push instead of reading as a clean worktree',
  withFixture((fixture) => {
    const cache = join(fixture.work, '.git', 'librechat-pre-push.cache');
    fixture.commit('error');
    writeFileSync(join(fixture.work, 'app.txt'), 'fixed\n');

    const before = runHook(fixture, failingGit(join(fixture.dir, 'before'), 0));
    assert.notEqual(before.status, 0, before.output);
    assert.equal(before.calls.length, 0);
    assert.match(before.output, /could not read the worktree status/);
    assert.match(before.output, /shim: index file corrupt/);
    assert.equal(existsSync(cache), false);

    // The status read after a passing run fails too: no pass is recorded.
    fixture.git('checkout', '--', 'app.txt');
    fixture.commit('ok');
    const after = runHook(fixture, failingGit(join(fixture.dir, 'after'), 1));
    assert.notEqual(after.status, 0, after.output);
    assert.equal(after.calls.length, 1);
    assert.match(after.output, /could not read the worktree status/);
    assert.equal(existsSync(cache), false);

    // The same push with a working git passes, so the refusals were the status reads.
    const healthy = runHook(fixture, process.env.PATH ?? '');
    assert.equal(healthy.status, 0, healthy.output);
    assert.equal(existsSync(cache), true);
  }),
);

test(
  'a ref git cannot resolve refuses the push instead of being skipped as a deletion',
  withFixture((fixture) => {
    fixture.commit('error');
    const pushed = runHook(fixture, failingGit(join(fixture.dir, 'shim-cat-file'), 0, 'cat-file'));
    assert.notEqual(pushed.status, 0, pushed.output);
    assert.equal(pushed.calls.length, 0);
    assert.doesNotMatch(pushed.output, /deletions only/);
    assert.match(pushed.output, /could not read refs\/heads\/feature: fatal: shim/);
  }),
);

test(
  'a check that creates a scratch repository cannot reach the linked worktree being pushed',
  withFixture((fixture) => {
    const linked = join(fixture.dir, 'linked');
    const scratch = join(fixture.dir, 'scratch');
    const head = fixture.commit('pushed');
    fixture.git('worktree', 'add', '-q', '-b', 'linked', linked);

    // Git exports GIT_DIR to a hook, and in a linked worktree it is absolute.
    const pushed = run('git', ['push', 'origin', 'linked'], linked, {
      STUB_LOG: join(fixture.dir, 'checks.log'),
      STUB_SCRATCH_REPO: scratch,
    });

    assert.equal(pushed.status, 0, pushed.output);
    assert.equal(fixture.remoteSha('refs/heads/linked'), head);
    assert.equal(run('git', ['rev-parse', 'HEAD'], linked).output.trim(), head);
    assert.match(run('git', ['ls-files'], linked).output, /^app\.txt$/m);
    assert.equal(fixture.git('config', 'core.bare'), 'false');
    assert.equal(run('git', ['log', '-1', '--format=%s'], scratch).output.trim(), 'scratch');
  }),
);

test(
  'the imports suite keeps its fixtures out of a repository named by GIT_DIR',
  withFixture((fixture) => {
    const linked = join(fixture.dir, 'linked');
    const head = fixture.commit('pushed');
    fixture.git('worktree', 'add', '-q', '-b', 'linked', linked);
    const gitDir = run('git', ['rev-parse', '--absolute-git-dir'], linked).output.trim();

    // Unset NODE_TEST_CONTEXT, or the nested runner would run nothing and pass.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_DIR: gitDir };
    delete env.NODE_TEST_CONTEXT;
    const suite = spawnSync(process.execPath, ['--test', 'scripts/imports.test.mts'], {
      cwd: ROOT,
      encoding: 'utf8',
      env,
    });

    assert.equal(suite.status, 0, `${suite.stdout}${suite.stderr}`);
    assert.match(suite.stdout, /pass [1-9]/);
    assert.equal(run('git', ['rev-parse', 'HEAD'], linked).output.trim(), head);
    assert.equal(fixture.git('config', 'core.bare'), 'false');
  }),
);
