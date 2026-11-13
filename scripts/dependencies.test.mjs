import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const from = (name) => createRequire(require.resolve(name));
const jestRequire = from('jest');
const globConsumers = ['jest-config', 'jest-runtime', '@jest/reporters'].map((name) => [
  name,
  createRequire(jestRequire.resolve(name)),
]);
globConsumers.push(
  ['test-exclude', from('test-exclude')],
  ['workbox-build', from('workbox-build')],
);
const workspaceRequires = ['api', 'chat', 'client', 'data-provider', 'data-schemas'].map((name) => [
  name,
  createRequire(new URL(`../packages/${name}/package.json`, import.meta.url)),
]);
for (const [name, consumer] of workspaceRequires) {
  globConsumers.push([`${name}/rimraf`, createRequire(consumer.resolve('rimraf'))]);
}

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

test('Glob consumers resolve patched majors without changing unrelated matchers', () => {
  for (const [, consumer] of globConsumers) patched(consumer, 'glob', 14);
  for (const name of [
    'test-exclude',
    '@typescript-eslint/typescript-estree',
    'nodemon',
    'eslint-plugin-sonarjs',
  ]) {
    patched(from(name), 'minimatch', 11);
  }
  for (const name of ['eslint-plugin-import', 'eslint-plugin-react', 'eslint-plugin-jsx-a11y']) {
    const minimatch = from(name)('minimatch');
    assert.equal(typeof minimatch, 'function', name);
    assert.equal(minimatch('src/file.ts', '**/*.{js,ts}'), true, name);
  }
});

test('the lockfile contains no vulnerable Glob or follow-redirects versions', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const [path, { version }] of Object.entries(lock.packages)) {
    const [major, minor, patch] = (version ?? '').split('.').map(Number);
    if (path.endsWith('/node_modules/glob') || path === 'node_modules/glob') {
      assert.ok(major < 9 || major > 14 || (major === 14 && (minor > 0 || patch >= 2)), path);
    }
    if (
      path.endsWith('/node_modules/follow-redirects') ||
      path === 'node_modules/follow-redirects'
    ) {
      assert.ok(major > 1 || (major === 1 && (minor > 16 || (minor === 16 && patch >= 2))), path);
    }
  }
});

test('Glob consumers preserve braces, ignores, dotfiles, and cancellation', async (t) => {
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

test('aborting an active Glob walk stops further filesystem traversal', async (t) => {
  const cwd = fixture(t, {
    'first/nested/a.js': '',
    'second/nested/b.js': '',
  });
  for (const [name, consumer] of globConsumers) {
    const controller = new AbortController();
    const reason = new Error('stop traversal');
    let reads = 0;
    const fs = {
      readdir(path, options, callback) {
        reads++;
        queueMicrotask(() => {
          const entries = readdirSync(path, options);
          controller.abort(reason);
          callback(null, entries);
        });
      },
    };
    await assert.rejects(
      consumer('glob').glob('**/*', { cwd, fs, signal: controller.signal }),
      reason,
    );
    await new Promise(setImmediate);
    assert.equal(reads, 1, name);
  }
});

test('follow-redirects strips cross-realm sensitive headers on cross-origin redirects', async (t) => {
  async function listen(handler) {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server.address().port;
  }
  const received = [];
  const target = await listen((req, res) => {
    received.push(req.headers);
    res.end();
  });
  const source = await listen((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${target}/` });
    res.end();
  });
  const sensitiveHeaders = runInNewContext("['X-API-Key']");
  assert.equal(Array.isArray(sensitiveHeaders), true);
  assert.equal(sensitiveHeaders instanceof Array, false);
  for (const headers of [
    { 'X-API-Key': 'test-secret', 'X-Harmless': 'retained' },
    ['X-API-Key', 'test-secret', 'X-Harmless', 'retained'],
  ]) {
    await new Promise((resolve, reject) => {
      const req = require('follow-redirects').http.get(
        `http://127.0.0.1:${source}/`,
        { headers, sensitiveHeaders },
        (res) => {
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });
  }
  assert.equal(received.length, 2);
  for (const headers of received) {
    assert.equal(headers['x-api-key'], undefined);
    assert.equal(headers['x-harmless'], 'retained');
  }
});

test('Node and Undici enforce integrity metadata separated by ASCII whitespace', async (t) => {
  const server = createServer((req, res) => res.end('security-regression'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const digest = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

  for (const [name, fetch] of [
    ['Node', globalThis.fetch],
    ['Undici', require('undici').fetch],
  ]) {
    for (const whitespace of [' ', '\t', '\n', '\f', '\r']) {
      await assert.rejects(
        fetch(url, { integrity: `${whitespace}${digest}${whitespace}` }),
        (error) => error.cause?.message === 'integrity mismatch',
        `${name}: ${JSON.stringify(whitespace)}`,
      );
    }
  }
});

test('Workbox preserves precache globs and ignores', async (t) => {
  const cwd = fixture(t, {
    'index.html': '<html></html>',
    'assets/app.js': 'console.log(1);',
    'assets/skip.js': '',
    'assets/app.js.map': '{}',
  });
  const { getManifest } = require('workbox-build');
  const result = await getManifest({
    globDirectory: cwd,
    globPatterns: ['**/*.{html,js}'],
    globIgnores: ['**/skip.js'],
  });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.manifestEntries.map(({ url }) => url).sort(), [
    'assets/app.js',
    'index.html',
  ]);
  assert.ok(result.manifestEntries.every(({ revision }) => revision));
});

test('Rimraf preserves globbed removal in every workspace', async (t) => {
  for (const [name, consumer] of workspaceRequires) {
    const cwd = fixture(t, { 'remove.js': '', 'nested/remove.ts': '', 'keep.txt': '' });
    await consumer('rimraf').rimraf('**/*.{js,ts}', { glob: { cwd } });
    assert.deepEqual(readdirSync(cwd).sort(), ['keep.txt', 'nested'], name);
    assert.deepEqual(readdirSync(join(cwd, 'nested')), [], name);
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

test('the lockfile retains patched database, HTTP, XML, and matcher dependencies', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const { satisfies } = require('semver');
  const ranges = {
    mongoose: '^8.24.7',
    hono: '^4.13.16',
    '@hono/node-server': '^2.1.6',
    'fast-xml-parser': '>=5.11.3',
    minimatch: '<7 || >=11.0.1',
  };
  for (const [name, range] of Object.entries(ranges)) {
    const entries = Object.entries(lock.packages).filter(
      ([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`,
    );
    assert.ok(entries.length, name);
    for (const [path, { version }] of entries) {
      assert.ok(satisfies(version, range), `${path}: ${version}`);
    }
  }
});

test('Mongoose sanitizes countDocuments and connection-level query filters before dispatch', async () => {
  const { Mongoose } = require('mongoose');
  for (const level of ['query', 'connection']) {
    const db = new Mongoose();
    const connection = db.createConnection();
    if (level === 'connection') connection.set('sanitizeFilter', true);
    const Model = connection.model(
      'Sanitized',
      new db.Schema(
        { password: String },
        {
          bufferCommands: false,
        },
      ),
    );
    for (const operation of ['findOne', 'countDocuments']) {
      const query = Model[operation]({ password: { $ne: null } });
      if (level === 'query') query.setOptions({ sanitizeFilter: true });
      await assert.rejects(
        query.exec(),
        { name: 'CastError', path: 'password' },
        `${level}/${operation}`,
      );
      assert.deepEqual(query.getFilter(), { password: { $eq: { $ne: null } } });
    }
    await connection.destroy();
  }
});

test('Mongoose keeps inherited discriminator names subject to casting and strict schemas', () => {
  const { Mongoose } = require('mongoose');
  const db = new Mongoose();
  const Base = db.model('Base', new db.Schema({ age: Number }));
  Base.discriminator('Child', new db.Schema({ extra: String }));
  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    const doc = new Base({ __t: name, age: '42', notInSchema: true });
    assert.ok(doc instanceof db.Document, name);
    assert.equal(doc.age, 42, name);
    assert.equal(doc.toObject().notInSchema, undefined, name);
  }
});

test('Mongoose rejects virtual prototype paths and does not mutate inherited functions', (t) => {
  const { Mongoose } = require('mongoose');
  const db = new Mongoose();
  const schema = new db.Schema({ meta: {} });
  const marker = 'dependencySecurityMarker';
  t.after(() => {
    delete Object.prototype[marker];
    delete Object.prototype.toString[marker];
  });
  assert.throws(() => schema.virtual(`__proto__.${marker}`), /Cannot set special property/);
  assert.equal(Object.hasOwn(Object.prototype, marker), false);
  const Model = db.model('Inherited', schema);
  new Model({ [`meta.toString.${marker}`]: true });
  Model.hydrate({ toString: { [marker]: true } });
  Model.findOneAndReplace({}, { toString: { [marker]: true } });
  assert.equal(Object.hasOwn(Object.prototype.toString, marker), false);
});

test('Hono rejects cross-origin hyperlink auditing but permits same-origin pings', async () => {
  const { Hono } = require('hono');
  const { csrf } = require('hono/csrf');
  const app = new Hono();
  app.use('*', csrf());
  app.post('/action', (c) => c.text('accepted'));
  for (const [origin, status] of [
    ['https://attacker.example', 403],
    ['https://app.example', 200],
  ]) {
    const res = await app.request('https://app.example/action', {
      method: 'POST',
      headers: { 'Content-Type': 'text/ping', Origin: origin },
      body: 'PING',
    });
    assert.equal(res.status, status, origin);
  }
});

test('Hono validates multipart form fields with additional content-type parameters', async () => {
  const { Hono } = require('hono');
  const { validator } = require('hono/validator');
  const app = new Hono();
  app.post(
    '/form',
    validator('form', (value) => value),
    (c) => c.json(c.req.valid('form')),
  );
  const body =
    '--boundary\r\nContent-Disposition: form-data; name="role"\r\n\r\nuser\r\n--boundary--\r\n';
  for (const contentType of [
    'multipart/form-data; boundary=boundary',
    'multipart/form-data; charset=utf-8; boundary=boundary',
    'multipart/form-data;  boundary=boundary',
  ]) {
    const res = await app.request('/form', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(res.status, 200, contentType);
    assert.deepEqual(await res.json(), { role: 'user' }, contentType);
  }
});

test('Hono node-server rejects raw path backslashes without rejecting encoded or query backslashes', async (t) => {
  const { Hono } = require('hono');
  const { serve } = require('@hono/node-server');
  const app = new Hono();
  app.get('*', (c) => c.text('accepted'));
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const [path, status] of [
    ['/public\\..\\admin/secret', 400],
    ['/admin%5csecret', 200],
    ['/?path=\\admin', 200],
  ]) {
    const actual = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: server.address().port, path }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(actual, status, path);
  }
});
