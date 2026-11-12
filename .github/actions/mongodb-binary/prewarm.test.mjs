import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

/**
 * Runs the real script against the installed mongodb-memory-server: its own
 * resolver, lookup order, memoisation, download, archive checksum, extraction
 * and checksum sidecar. Only the network is replaced, by pointing the library's
 * MONGOMS_DOWNLOAD_MIRROR at a local server. It hands out an archive whose
 * `bin/mongod` is a shell script, plus the `.md5` the library verifies that
 * archive against, and records each archive request, so a test also knows how
 * many downloads the script caused.
 */
const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('./prewarm.mjs', import.meta.url));
const LIBRARY = path.dirname(require.resolve('mongodb-memory-server/package.json'));
const posixOnly = { skip: process.platform === 'win32' && 'the stand-in mongod is a shell script' };

/** The library discards a binary under 1 MiB as a truncated extraction. */
const PADDING = `\n# ${'-'.repeat(76)}`.repeat(14_000);
const GOOD = `#!/bin/sh\necho "db version v9.9.9"\necho "Build Info: {}"\nexit 0${PADDING}\n`;
const BROKEN = `#!/bin/sh\necho "cannot execute" >&2\nexit 3${PADDING}\n`;

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), 'mongodb-binary-archives-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

function archive(label, content) {
  const root = path.join(SCRATCH, label);
  mkdirSync(path.join(root, 'mongodb-fixture', 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'mongodb-fixture', 'bin', 'mongod'), content, { mode: 0o755 });
  const file = path.join(SCRATCH, `${label}.tgz`);
  const packed = spawnSync('tar', ['-czf', file, '-C', root, 'mongodb-fixture']);
  assert.equal(packed.status, 0, String(packed.stderr));
  return readFileSync(file);
}

const ARCHIVES = posixOnly.skip
  ? {}
  : { good: archive('good', GOOD), broken: archive('broken', BROKEN) };

/** What the installed library calls the binary on this machine, e.g. `mongod-x64-ubuntu-8.2.6`. */
async function binaryName() {
  const { DryMongoBinary } = require('mongodb-memory-server');
  return DryMongoBinary.getBinaryName(await DryMongoBinary.generateOptions());
}

async function fixture(t, { serve = 'good', installed = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mongodb-binary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const homeCache = path.join(home, '.cache', 'mongodb-binaries');
  const modulesCache = path.join(work, 'node_modules', '.cache', 'mongodb-memory-server');
  const name = await binaryName();
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  writeFileSync(path.join(work, 'package.json'), '{"name":"fixture","private":true}');
  if (installed) {
    symlinkSync(LIBRARY, path.join(work, 'node_modules', 'mongodb-memory-server'), 'dir');
  }

  const downloads = [];
  const server = http.createServer((request, response) => {
    const packed = ARCHIVES[serve];
    const checksum = request.url.endsWith('.md5');
    if (!checksum) {
      downloads.push(request.url);
    }
    if (!packed) {
      response.writeHead(404).end();
      return;
    }
    const body = checksum
      ? Buffer.from(`${createHash('md5').update(packed).digest('hex')}  mongod.tgz\n`)
      : packed;
    response.writeHead(200, { 'content-length': body.length });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const place = (directory, content = GOOD, file = name) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, file), content);
    chmodSync(path.join(directory, file), 0o755);
    writeFileSync(path.join(directory, `${file}.md5`), `0 *${file}\n`);
    return path.join(directory, file);
  };

  /** A child process, not spawnSync: the mirror above answers from this process's event loop. */
  const run = (env = {}) =>
    new Promise((resolve) => {
      const inherited = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('MONGOMS_') && key !== 'INIT_CWD',
        ),
      );
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: work,
        env: {
          ...inherited,
          HOME: home,
          MONGOMS_DOWNLOAD_MIRROR: `http://127.0.0.1:${server.address().port}`,
          MONGOMS_USE_HTTP: 'true',
          MONGOMS_MAX_RETRIES: '1',
          ...env,
        },
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('close', (status) => resolve({ status, output }));
    });

  const cached = () => (existsSync(homeCache) ? readdirSync(homeCache).sort() : []);
  return { root, name, homeCache, modulesCache, downloads, place, run, cached };
}

const firstLine = (file) => readFileSync(file, 'utf8').split('\n', 2).join('\n');
const RUNS = '#!/bin/sh\necho "db version v9.9.9"';

test(
  'a binary already in the home cache is verified and nothing is downloaded',
  posixOnly,
  async (t) => {
    const { homeCache, downloads, place, run, cached } = await fixture(t);
    place(homeCache);
    place(homeCache, GOOD, 'mongod-x64-ubuntu-7.0.14');
    const { status, output } = await run();
    assert.equal(status, 0, output);
    assert.match(output, /db version v9\.9\.9 \(already present\)/);
    assert.equal(downloads.length, 0);
    assert.ok(
      cached().includes('mongod-x64-ubuntu-7.0.14'),
      'an untouched cache is left as it was',
    );
  },
);

test('a missing binary is downloaded once, before anything else needs it', posixOnly, async (t) => {
  const { name, homeCache, downloads, run, cached } = await fixture(t);
  const { status, output } = await run();
  assert.equal(status, 0, output);
  assert.ok(output.includes(`mongod ready: ${path.join(homeCache, name)}`), output);
  assert.match(output, /db version v9\.9\.9 \(downloaded\)/);
  assert.equal(downloads.length, 1);
  assert.deepEqual(cached(), [name, `${name}.md5`]);

  const again = await run();
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /\(already present\)/);
  assert.equal(downloads.length, 1, 'the second run finds what the first one left');
});

test(
  'a binary only the repository root can see is copied into the home cache',
  posixOnly,
  async (t) => {
    const { name, homeCache, modulesCache, downloads, place, run, cached } = await fixture(t);
    const postinstall = place(modulesCache);
    const { status, output } = await run();
    assert.equal(status, 0, output);
    assert.match(output, /\(copied from .*node_modules\/\.cache\/mongodb-memory-server\//);
    assert.equal(downloads.length, 0);
    assert.deepEqual(cached(), [name, `${name}.md5`]);
    assert.equal(firstLine(path.join(homeCache, name)), RUNS);
    assert.ok(existsSync(postinstall), 'the original stays where npm ci put it');
  },
);

test(
  'a cached binary that does not run is replaced by one fresh download',
  posixOnly,
  async (t) => {
    const { name, homeCache, downloads, place, run } = await fixture(t);
    place(homeCache, BROKEN);
    const { status, output } = await run({ MONGODB_BINARY_CACHE_HIT: 'true' });
    assert.equal(status, 0, output);
    assert.match(output, /::warning::.*does not run: cannot execute\. Discarded it; resolving/);
    assert.match(output, /db version v9\.9\.9 \(downloaded\)/);
    assert.match(output, /::warning::The restored MongoDB binary cache had no runnable mongod/);
    assert.equal(downloads.length, 1);
    assert.equal(firstLine(path.join(homeCache, name)), RUNS);
  },
);

test(
  'a broken binary outside the home cache is not copied back on the retry',
  posixOnly,
  async (t) => {
    const { name, homeCache, modulesCache, downloads, place, run } = await fixture(t);
    const postinstall = place(modulesCache, BROKEN);
    const { status, output } = await run();
    assert.equal(status, 0, output);
    assert.equal(downloads.length, 1);
    assert.ok(!existsSync(postinstall));
    assert.equal(firstLine(path.join(homeCache, name)), RUNS);
  },
);

test(
  'broken copies in both places are discarded without using up the download',
  posixOnly,
  async (t) => {
    const { name, homeCache, modulesCache, downloads, place, run } = await fixture(t);
    place(homeCache, BROKEN);
    const postinstall = place(modulesCache, BROKEN);
    const { status, output } = await run();
    assert.equal(status, 0, output);
    assert.equal(output.match(/Discarded it; resolving again/g)?.length, 2, output);
    assert.match(output, /db version v9\.9\.9 \(downloaded\)/);
    assert.equal(downloads.length, 1);
    assert.ok(!existsSync(postinstall));
    assert.equal(firstLine(path.join(homeCache, name)), RUNS);
  },
);

test(
  'the job fails when the download keeps producing a binary that does not run',
  posixOnly,
  async (t) => {
    const { downloads, run, cached } = await fixture(t, { serve: 'broken' });
    const { status, output } = await run();
    assert.equal(status, 1, output);
    assert.match(output, /::error title=MongoDB binary::.*does not run: cannot execute/);
    assert.equal(downloads.length, 2, 'two downloads, not a loop');
    assert.deepEqual(
      cached().filter((file) => file.startsWith('mongod-')),
      [],
      'nothing unusable is left behind to be cached',
    );
  },
);

test(
  'the job fails with the whole reason on one line when the download fails',
  posixOnly,
  async (t) => {
    const { downloads, run } = await fixture(t, { serve: 'nothing' });
    const { status, output } = await run();
    assert.equal(status, 1, output);
    const annotation = output.split('\n').find((line) => line.startsWith('::error '));
    assert.match(
      annotation,
      /^::error title=MongoDB binary::Download failed for url "http:\/\/127\.0\.0\.1:\d+\//,
    );
    assert.match(annotation, /404/, 'the status the library reports on its second line is kept');
    assert.equal(downloads.length, 2);
  },
);

test('the job fails when dependencies are not installed', posixOnly, async (t) => {
  const { downloads, run } = await fixture(t, { installed: false });
  const { status, output } = await run();
  assert.equal(status, 1, output);
  assert.match(
    output,
    /::error title=MongoDB binary::mongodb-memory-server is not installed under /,
  );
  assert.equal(downloads.length, 0);
});

test(
  'a new binary removes the versions an older cache carried over, and nothing else',
  posixOnly,
  async (t) => {
    const { name, homeCache, place, run, cached } = await fixture(t);
    place(homeCache, GOOD, 'mongod-x64-ubuntu-7.0.14');
    writeFileSync(path.join(homeCache, 'unrelated.txt'), 'keep');
    const { status, output } = await run();
    assert.equal(status, 0, output);
    assert.match(
      output,
      /removed superseded binaries: mongod-x64-ubuntu-7\.0\.14, mongod-x64-ubuntu-7\.0\.14\.md5/,
    );
    assert.deepEqual(cached(), [name, `${name}.md5`, 'unrelated.txt'].sort());
  },
);

test(
  'MONGOMS_DOWNLOAD_DIR names the shared directory instead of the home cache',
  posixOnly,
  async (t) => {
    const { root, name, modulesCache, downloads, place, run, cached } = await fixture(t);
    const directory = path.join(root, 'elsewhere');
    place(modulesCache);
    const { status, output } = await run({ MONGOMS_DOWNLOAD_DIR: directory });
    assert.equal(status, 0, output);
    assert.ok(output.includes(`mongod ready: ${path.join(directory, name)}`), output);
    assert.match(output, /so the binary cache does not cover it/);
    assert.equal(downloads.length, 0);
    assert.deepEqual(readdirSync(directory).sort(), [name, `${name}.md5`]);
    assert.deepEqual(cached(), []);
  },
);

test('a system binary is checked where it is and never copied or deleted', posixOnly, async (t) => {
  const { root, downloads, place, run, cached } = await fixture(t);
  const working = place(path.join(root, 'system'), GOOD, 'mongod');
  const good = await run({ MONGOMS_SYSTEM_BINARY: working });
  assert.equal(good.status, 0, good.output);
  assert.ok(good.output.includes(`mongod ready: ${working}`), good.output);
  assert.match(good.output, /\(MONGOMS_SYSTEM_BINARY\)/);

  /** Rejected by the library's own version probe, then by this script's exit-status check. */
  const failures = { silent: BROKEN, 'exits-non-zero': GOOD.replace('exit 0', 'exit 3') };
  for (const [label, content] of Object.entries(failures)) {
    const failing = place(path.join(root, label), content, 'mongod');
    const bad = await run({ MONGOMS_SYSTEM_BINARY: failing });
    assert.equal(bad.status, 1, bad.output);
    assert.match(bad.output, /::error title=MongoDB binary::/);
    assert.ok(existsSync(failing), `${label}: a file the job named is not ours to delete`);
  }
  assert.equal(downloads.length, 0);
  assert.deepEqual(cached(), []);
});
