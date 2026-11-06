import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const from = (name) => createRequire(require.resolve(name));
const jestRequire = from('jest');
const globConsumers = ['jest-config', 'jest-runtime', '@jest/reporters'].map((name) => [
  name,
  createRequire(jestRequire.resolve(name)),
]);
globConsumers.push(['test-exclude', from('test-exclude')]);

function fixture(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'librechat-dependencies-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    const path = join(cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return cwd;
}

function patched(consumer, dependency, major) {
  const { version } = consumer(`${dependency}/package.json`);
  const [actualMajor, minor, patch] = version.split('.').map(Number);
  assert.equal(actualMajor, major, `${dependency}: ${version}`);
  assert.ok(minor > 0 || patch >= 3, `${dependency}: ${version}`);
}

test('only selected consumers resolve the patched majors', () => {
  for (const [, consumer] of globConsumers) patched(consumer, 'glob', 14);
  for (const name of ['test-exclude', '@typescript-eslint/typescript-estree']) {
    patched(from(name), 'minimatch', 11);
  }
  const workspaceRequire = createRequire(new URL('../packages/api/package.json', import.meta.url));
  const rimrafRequire = createRequire(workspaceRequire.resolve('rimraf'));
  const oldGlob = createRequire(rimrafRequire.resolve('glob'));
  assert.match(oldGlob('minimatch/package.json').version, /^10\./);
  assert.match(from('workbox-build')('glob/package.json').version, /^11\./);
  assert.match(from('nodemon')('minimatch/package.json').version, /^10\./);
  for (const name of ['eslint-plugin-import', 'eslint-plugin-react', 'eslint-plugin-jsx-a11y']) {
    const minimatch = from(name)('minimatch');
    assert.equal(typeof minimatch, 'function', name);
    assert.equal(minimatch('src/file.ts', '**/*.{js,ts}'), true, name);
  }
});

test('scoped Glob consumers preserve braces, ignores, dotfiles, and cancellation', async (t) => {
  const cwd = fixture(t, {
    'src/a.js': '',
    'src/nested/b.ts': '',
    'src/.hidden.js': '',
    'src/skip/c.js': '',
    'src/readme.txt': '',
  });
  for (const [name, consumer] of globConsumers) {
    const { glob, globSync } = consumer('glob');
    const options = { cwd, dot: true, nodir: true, ignore: ['**/skip/**'], posix: true };
    const expected = ['src/.hidden.js', 'src/a.js', 'src/nested/b.ts'];
    assert.deepEqual(globSync('**/*.{js,ts}', options).sort(), expected, name);
    assert.deepEqual((await glob('**/*.{js,ts}', options)).sort(), expected, name);
    const signal = AbortSignal.abort();
    assert.throws(() => globSync('**/*', { cwd, signal }), { name: 'AbortError' }, name);
    await assert.rejects(glob('**/*', { cwd, signal }), { name: 'AbortError' }, name);
  }
});

test('coverage exclusions preserve negations and sync/async file selection', async (t) => {
  const cwd = fixture(t, {
    'src/a.js': '',
    'src/nested/b.ts': '',
    'src/a.spec.js': '',
    'src/keep.spec.js': '',
    'src/.hidden.js': '',
    'node_modules/ignored.js': '',
  });
  const TestExclude = require('test-exclude');
  const exclude = new TestExclude({
    cwd,
    include: ['src/**'],
    exclude: ['**/*.spec.js', '!src/keep.spec.js'],
    extension: ['.js', '.ts'],
  });
  const expected = ['src/.hidden.js', 'src/a.js', 'src/keep.spec.js', 'src/nested/b.ts'];
  assert.deepEqual(exclude.globSync().sort(), expected);
  assert.deepEqual((await exclude.glob()).sort(), expected);
  assert.equal(exclude.shouldInstrument(join(cwd, 'src/a.spec.js')), false);
  assert.equal(exclude.shouldInstrument(join(cwd, 'node_modules/ignored.js')), false);
});

test('TypeScript project-service default-project globs still admit only matching files', (t) => {
  const cwd = fixture(t, {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true },
      include: ['src/**/*.ts'],
    }),
    'src/index.ts': 'export {};',
    '.config.js': 'const value = 1;',
    'blocked.ts': 'const value = 2;',
  });
  const parser = require('@typescript-eslint/typescript-estree');
  t.after(() => parser.clearCaches());
  const options = { tsconfigRootDir: cwd, projectService: { allowDefaultProject: ['*.js'] } };
  const result = parser.parseAndGenerateServices(readFileSync(join(cwd, '.config.js'), 'utf8'), {
    ...options,
    filePath: join(cwd, '.config.js'),
  });
  assert.ok(result.services.program);
  assert.throws(
    () =>
      parser.parseAndGenerateServices('const value = 2;', {
        ...options,
        filePath: join(cwd, 'blocked.ts'),
      }),
    /does not match/,
  );
});

test('Jest expands project globs and preserves unmatched project paths', async (t) => {
  const cwd = fixture(t, {
    'projects/first/package.json': '{}',
    'projects/second/package.json': '{}',
  });
  const { normalize } = jestRequire('jest-config');
  const result = await normalize(
    { rootDir: cwd, projects: ['<rootDir>/projects/*', '<rootDir>/missing-*'] },
    { _: [], $0: 'jest' },
  );
  assert.deepEqual(
    result.options.projects.sort(),
    [join(cwd, 'projects/first'), join(cwd, 'projects/second'), join(cwd, 'missing-*')].sort(),
  );
});

test('Jest instruments coverage and applies glob-specific thresholds', (t) => {
  const cwd = fixture(t, {
    'sum.js': 'module.exports = (a, b) => a + b;',
    'sum.test.js': "test('sum', () => { expect(require('./sum')(1, 2)).toBe(3); });",
  });
  const config = {
    rootDir: cwd,
    testEnvironment: 'node',
    collectCoverage: true,
    collectCoverageFrom: ['*.js', '!*.test.js'],
    coverageThreshold: { './s*.js': { statements: 100 } },
    coverageDirectory: join(cwd, 'coverage'),
    coverageReporters: ['json'],
    transform: {},
  };
  execFileSync(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--config',
      JSON.stringify(config),
      '--runInBand',
      '--no-cache',
    ],
    { cwd, timeout: 30000, stdio: 'pipe' },
  );
  const coverage = JSON.parse(readFileSync(join(cwd, 'coverage/coverage-final.json'), 'utf8'));
  assert.ok(coverage[join(cwd, 'sum.js')]);
  assert.equal(
    Object.keys(coverage).some((file) => file.endsWith('.test.js')),
    false,
  );
});

test('Jest retains extension hints for missing modules', (t) => {
  const cwd = fixture(t, {
    'sibling.ts': 'export {};',
    'missing.test.js': "require('./sibling');",
  });
  const config = {
    rootDir: cwd,
    testEnvironment: 'node',
    moduleFileExtensions: ['js', 'json'],
    transform: {},
  };
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--config',
          JSON.stringify(config),
          '--runInBand',
          '--no-cache',
        ],
        { cwd, timeout: 30000, stdio: 'pipe' },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /sibling\.ts/);
      assert.match(error.stderr.toString(), /moduleFileExtensions/);
      return true;
    },
  );
});
