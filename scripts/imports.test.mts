import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { importedPackages, packageName, packagesInSource } from './imports.mts';

const SCRIPT = fileURLToPath(new URL('./imports.mts', import.meta.url));

// Hooks inherit GIT_DIR and friends, which would point every fixture below at the real repository.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('GIT_')) delete process.env[name];
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

/** A throwaway repository: `files` committed, `untracked` left uncommitted, `removed` deleted after the commit. */
function fixture(
  files: Record<string, string>,
  untracked: Record<string, string> = {},
  removed: string[] = [],
): string {
  const root = mkdtempSync(join(tmpdir(), 'imports-'));
  const write = (entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
  };
  write(files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  write(untracked);
  for (const path of removed) rmSync(join(root, path));
  return root;
}

test('reduces specifiers to their package and drops relative ones', () => {
  assert.equal(packageName('react'), 'react');
  assert.equal(packageName('lodash/get'), 'lodash');
  assert.equal(packageName('@scope/pkg'), '@scope/pkg');
  assert.equal(packageName('@scope/pkg/sub/path'), '@scope/pkg');
  assert.equal(packageName('@scope'), null);
  assert.equal(packageName('./local'), null);
  assert.equal(packageName('../up'), null);
  assert.equal(packageName('/abs'), null);
});

test('recognizes every import form the gate relies on', () => {
  const source = [
    "const a = require('cjs-pkg');",
    "const b = require( 'spaced-cjs' );",
    "import def from 'default-pkg';",
    "import { named } from '@scope/named/sub';",
    "import * as ns from 'namespace-pkg';",
    "import type { T } from 'type-only';",
    "import 'side-effect';",
    "import'no-space-side-effect';",
    "export * from 'star-reexport';",
    "export { x } from 'named-reexport/deep';",
    "export type { Y } from 'type-reexport';",
    "import local from './local';",
  ].join('\n');
  assert.deepEqual([...packagesInSource(source)].sort(), [
    '@scope/named',
    'cjs-pkg',
    'default-pkg',
    'named-reexport',
    'namespace-pkg',
    'no-space-side-effect',
    'side-effect',
    'spaced-cjs',
    'star-reexport',
    'type-only',
    'type-reexport',
  ]);
});

test('counts source usage and ignores installed dependencies and build output', async () => {
  const root = fixture(
    {
      '.gitignore': 'node_modules/\ndist\n/.claude/\n',
      'client/src/app.tsx': "import React from 'react';\nimport '@scope/ui/styles';",
      'client/vite.config.mts': "import { defineConfig } from 'vite';",
      'api/server.js': "const express = require('express');",
      'api/types.cts': "import type { Request } from 'express-types';",
      'packages/api/src/index.ts': "export * from 'api-reexport';",
      '.github/scripts/gate.mjs': "import yaml from 'js-yaml';",
      'config/tool.cjs': "require('root-only');",
      'client/README.md': "import nope from 'markdown-pkg';",
      'api/removed.js': "require('deleted-pkg');",
    },
    {
      'client/src/new.ts': "import fresh from 'untracked-pkg';",
      'node_modules/ghost/index.js': "require('ghost-dependency');",
      'client/node_modules/nested/index.mjs': "import 'nested-ghost';",
      'packages/api/dist/index.js': "require('built-only');",
      '.claude/worktrees/other/client/a.ts': "import 'worktree-pkg';",
    },
    ['api/removed.js'],
  );
  try {
    const found = await importedPackages(root, ['.', 'client', 'api', 'packages/api']);
    const sorted = (dir: string) => [...found.get(dir)!].sort();
    assert.deepEqual(sorted('client'), ['@scope/ui', 'react', 'untracked-pkg', 'vite']);
    assert.deepEqual(sorted('api'), ['express', 'express-types']);
    assert.deepEqual(sorted('packages/api'), ['api-reexport']);
    assert.deepEqual(sorted('.'), [
      '@scope/ui',
      'api-reexport',
      'express',
      'express-types',
      'js-yaml',
      'react',
      'root-only',
      'untracked-pkg',
      'vite',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI writes each directory as a sorted list', () => {
  const root = fixture({
    'client/a.ts': "import 'zeta';\nimport 'alpha';",
    'api/b.js': '// no imports',
  });
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'client=client.txt', 'api=api.txt', '.=root.txt'],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'client.txt'), 'utf8'), 'alpha\nzeta\n');
    assert.equal(readFileSync(join(root, 'api.txt'), 'utf8'), '');
    assert.equal(readFileSync(join(root, 'root.txt'), 'utf8'), 'alpha\nzeta\n');

    const bad = spawnSync(process.execPath, [SCRIPT, 'client'], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails instead of reporting nothing outside a git checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'imports-nogit-'));
  try {
    writeFileSync(join(root, 'a.js'), "require('x');");
    await assert.rejects(importedPackages(root, ['.']), /git ls-files failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
