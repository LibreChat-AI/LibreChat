import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { unsafeSymlinks } from './check-symlinks.mjs';

const script = fileURLToPath(new URL('./check-symlinks.mjs', import.meta.url));

function fixture(t, links) {
  const cwd = mkdtempSync(join(tmpdir(), 'librechat-symlinks-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'core.symlinks', 'false');
  writeFileSync(join(cwd, 'file'), 'fixture');
  git('add', 'file');
  for (const [path, target] of Object.entries(links)) {
    const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      input: target,
      encoding: 'utf8',
    }).trim();
    git('update-index', '--add', '--cacheinfo', `120000,${hash},${path}`);
  }
  return cwd;
}

test('allows ordinary files and confined relative links', (t) => {
  const cwd = fixture(t, {
    alias: 'file',
    'nested/link': '../alias',
    directory: 'nested',
    chain: 'directory/link',
    // An untracked or missing target cannot escape by itself.
    dangling: 'missing',
  });
  assert.deepEqual(unsafeSymlinks(cwd), []);
});

test('rejects the absolute developer-worktree link even without filesystem symlinks', (t) => {
  const cwd = fixture(t, { 'prep-stream-dev-restack': '/home/developer/worktrees/restack' });
  assert.deepEqual(unsafeSymlinks(cwd), ['prep-stream-dev-restack']);
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsafe tracked symlink: "prep-stream-dev-restack"/);
});

test('rejects parent traversal, including paths with whitespace and newlines', (t) => {
  const cwd = fixture(t, {
    'nested/escape link\n': '../../outside',
    sibling: '../repository-other/file',
  });
  assert.deepEqual(unsafeSymlinks(cwd), ['nested/escape link\n', 'sibling']);
});

test('follows directory links before interpreting subsequent parent components', (t) => {
  const cwd = fixture(t, { directory: '.', escape: 'directory/../outside' });
  assert.deepEqual(unsafeSymlinks(cwd), ['escape']);
});

test('rejects transitive escapes and cycles', (t) => {
  const cwd = fixture(t, {
    outside: '../outside',
    indirect: 'outside/file',
    cycle: 'nested/cycle',
    'nested/cycle': '../cycle',
  });
  assert.deepEqual(unsafeSymlinks(cwd), ['cycle', 'indirect', 'nested/cycle', 'outside']);
});

test('checks tracked links only and exits successfully for a safe index', (t) => {
  const cwd = fixture(t, { alias: 'file' });
  writeFileSync(join(cwd, 'untracked'), '/outside');
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All tracked symlinks stay within the repository/);
});
