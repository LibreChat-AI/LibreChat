import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

/**
 * Runs the real script against a stand-in for mongodb-memory-server that keeps
 * the three properties of the real resolver the script depends on: it returns
 * the first existing binary from an ordered list of directories (home cache
 * first), it downloads into the home cache when none exists, and it memoises
 * the path it found until `DryMongoBinary.binaryCache` is cleared. Only the
 * network is replaced; "mongod" is a shell script that prints a version line
 * or exits non-zero.
 */
const SCRIPT = fileURLToPath(new URL('./prewarm.mjs', import.meta.url));
const NAME = 'mongod-x64-ubuntu-9.9.9';
const GOOD = '#!/bin/sh\necho "db version v9.9.9"\necho "Build Info: {}"\n';
const BROKEN = '#!/bin/sh\necho "cannot execute" >&2\nexit 3\n';
const posixOnly = { skip: process.platform === 'win32' && 'the stand-in mongod is a shell script' };

const LIBRARY = `
const fs = require('node:fs');
const path = require('node:path');
const plan = JSON.parse(process.env.FAKE_PLAN);
const binaryCache = new Map();
exports.DryMongoBinary = { binaryCache };
exports.MongoBinary = {
  async getPath() {
    if (binaryCache.has('default')) {
      return binaryCache.get('default');
    }
    if (process.env.MONGOMS_SYSTEM_BINARY) {
      return process.env.MONGOMS_SYSTEM_BINARY;
    }
    for (const directory of plan.search) {
      const candidate = path.join(directory, plan.name);
      if (fs.existsSync(candidate)) {
        binaryCache.set('default', candidate);
        return candidate;
      }
    }
    fs.appendFileSync(plan.log, 'download\\n');
    if (plan.download === 'unreachable') {
      throw new Error('Download failed for url "https://example.invalid/mongod.tgz", Details:\\nconnect ECONNREFUSED');
    }
    const target = path.join(plan.search[0], plan.name);
    fs.mkdirSync(plan.search[0], { recursive: true });
    fs.writeFileSync(target, plan.download === 'broken' ? plan.broken : plan.good, { mode: 0o755 });
    fs.writeFileSync(target + '.md5', 'checksum *' + plan.name + '\\n');
    binaryCache.set('default', target);
    return target;
  },
};
`;

function fixture(t, { download = 'good', installed = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mongodb-binary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const work = path.join(root, 'work');
  const homeCache = path.join(home, '.cache', 'mongodb-binaries');
  const modulesCache = path.join(work, 'node_modules', '.cache', 'mongodb-memory-server');
  const log = path.join(root, 'downloads.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'package.json'), '{"name":"fixture","private":true}');
  if (installed) {
    const library = path.join(work, 'node_modules', 'mongodb-memory-server');
    mkdirSync(library, { recursive: true });
    writeFileSync(path.join(library, 'index.js'), LIBRARY);
  }
  const place = (directory, content = GOOD, name = NAME) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, name), content);
    chmodSync(path.join(directory, name), 0o755);
    writeFileSync(path.join(directory, `${name}.md5`), `checksum *${name}\n`);
    return path.join(directory, name);
  };
  const run = (env = {}) => {
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MONGOMS_')),
    );
    const plan = {
      name: NAME,
      search: [env.MONGOMS_DOWNLOAD_DIR ?? homeCache, modulesCache],
      download,
      good: GOOD,
      broken: BROKEN,
      log,
    };
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: work,
      encoding: 'utf8',
      env: { ...inherited, HOME: home, FAKE_PLAN: JSON.stringify(plan), ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const downloads = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
  const cached = () => (existsSync(homeCache) ? readdirSync(homeCache).sort() : []);
  return { root, homeCache, modulesCache, place, run, downloads, cached };
}

test('a binary already in the home cache is verified and nothing is downloaded', posixOnly, (t) => {
  const { homeCache, place, run, downloads, cached } = fixture(t);
  place(homeCache);
  place(homeCache, GOOD, 'mongod-x64-ubuntu-7.0.14');
  const { status, output } = run();
  assert.equal(status, 0, output);
  assert.match(output, /db version v9\.9\.9 \(already present\)/);
  assert.equal(downloads(), 0);
  assert.ok(cached().includes('mongod-x64-ubuntu-7.0.14'), 'an untouched cache is left as it was');
});

test('a missing binary is downloaded once, before anything else needs it', posixOnly, (t) => {
  const { homeCache, run, downloads, cached } = fixture(t);
  const { status, output } = run();
  assert.equal(status, 0, output);
  assert.match(output, new RegExp(`mongod ready: ${path.join(homeCache, NAME)}`));
  assert.match(output, /db version v9\.9\.9 \(downloaded\)/);
  assert.equal(downloads(), 1);
  assert.deepEqual(cached(), [NAME, `${NAME}.md5`]);
  assert.equal(run().status, 0);
  assert.equal(downloads(), 1, 'the second run finds what the first one left');
});

test('a binary only the repository root can see is copied into the home cache', posixOnly, (t) => {
  const { homeCache, modulesCache, place, run, downloads, cached } = fixture(t);
  const postinstall = place(modulesCache);
  const { status, output } = run();
  assert.equal(status, 0, output);
  assert.match(output, new RegExp(`copied from ${postinstall}`));
  assert.equal(downloads(), 0);
  assert.deepEqual(cached(), [NAME, `${NAME}.md5`]);
  assert.equal(readFileSync(path.join(homeCache, NAME), 'utf8'), GOOD);
  assert.ok(existsSync(postinstall), 'the original stays where npm ci put it');
});

test('a cached binary that does not run is replaced by one fresh download', posixOnly, (t) => {
  const { homeCache, place, run, downloads } = fixture(t);
  place(homeCache, BROKEN);
  const { status, output } = run({ MONGODB_BINARY_CACHE_HIT: 'true' });
  assert.equal(status, 0, output);
  assert.match(output, /::warning::.*does not run: cannot execute\. Retrying once/);
  assert.match(output, /db version v9\.9\.9 \(downloaded\)/);
  assert.match(output, /::warning::The restored MongoDB binary cache had no runnable mongod/);
  assert.equal(downloads(), 1);
  assert.equal(readFileSync(path.join(homeCache, NAME), 'utf8'), GOOD);
});

test('a broken binary outside the home cache is not copied back on the retry', posixOnly, (t) => {
  const { homeCache, modulesCache, place, run, downloads } = fixture(t);
  const postinstall = place(modulesCache, BROKEN);
  const { status, output } = run();
  assert.equal(status, 0, output);
  assert.equal(downloads(), 1);
  assert.ok(!existsSync(postinstall));
  assert.equal(readFileSync(path.join(homeCache, NAME), 'utf8'), GOOD);
});

test(
  'the job fails when the download keeps producing a binary that does not run',
  posixOnly,
  (t) => {
    const { run, downloads, cached } = fixture(t, { download: 'broken' });
    const { status, output } = run();
    assert.equal(status, 1, output);
    assert.match(output, /::error title=MongoDB binary::.*does not run: cannot execute/);
    assert.equal(downloads(), 2, 'one retry, not a loop');
    assert.deepEqual(cached(), [], 'nothing unusable is left behind to be cached');
  },
);

test('the job fails with the whole reason on one line when the download fails', posixOnly, (t) => {
  const { run, downloads } = fixture(t, { download: 'unreachable' });
  const { status, output } = run();
  assert.equal(status, 1, output);
  assert.match(
    output,
    /^::error title=MongoDB binary::Download failed for url "https:\/\/example\.invalid\/mongod\.tgz", Details: connect ECONNREFUSED$/m,
  );
  assert.equal(downloads(), 2);
});

test('the job fails when dependencies are not installed', posixOnly, (t) => {
  const { run } = fixture(t, { installed: false });
  const { status, output } = run();
  assert.equal(status, 1, output);
  assert.match(
    output,
    /::error title=MongoDB binary::mongodb-memory-server is not installed under /,
  );
});

test(
  'a new binary removes the versions an older cache carried over, and nothing else',
  posixOnly,
  (t) => {
    const { homeCache, place, run, cached } = fixture(t);
    place(homeCache, GOOD, 'mongod-x64-ubuntu-7.0.14');
    writeFileSync(path.join(homeCache, 'unrelated.txt'), 'keep');
    const { status, output } = run();
    assert.equal(status, 0, output);
    assert.match(
      output,
      /removed superseded binaries: mongod-x64-ubuntu-7\.0\.14, mongod-x64-ubuntu-7\.0\.14\.md5/,
    );
    assert.deepEqual(cached(), [NAME, `${NAME}.md5`, 'unrelated.txt']);
  },
);

test(
  'MONGOMS_DOWNLOAD_DIR names the shared directory instead of the home cache',
  posixOnly,
  (t) => {
    const { root, modulesCache, place, run, downloads, cached } = fixture(t);
    const directory = path.join(root, 'elsewhere');
    place(modulesCache);
    const { status, output } = run({ MONGOMS_DOWNLOAD_DIR: directory });
    assert.equal(status, 0, output);
    assert.match(output, new RegExp(`mongod ready: ${path.join(directory, NAME)}`));
    assert.match(output, /so the binary cache does not cover it/);
    assert.equal(downloads(), 0);
    assert.deepEqual(readdirSync(directory).sort(), [NAME, `${NAME}.md5`]);
    assert.deepEqual(cached(), []);
  },
);

test('a system binary is checked where it is and never copied or deleted', posixOnly, (t) => {
  const { root, place, run, downloads, cached } = fixture(t);
  const working = place(path.join(root, 'system'), GOOD, 'mongod');
  const good = run({ MONGOMS_SYSTEM_BINARY: working });
  assert.equal(good.status, 0, good.output);
  assert.match(good.output, new RegExp(`mongod ready: ${working}`));
  assert.match(good.output, /\(MONGOMS_SYSTEM_BINARY\)/);

  const failing = place(path.join(root, 'broken-system'), BROKEN, 'mongod');
  const bad = run({ MONGOMS_SYSTEM_BINARY: failing });
  assert.equal(bad.status, 1, bad.output);
  assert.ok(existsSync(failing), 'a file the job named is not ours to delete');
  assert.equal(downloads(), 0);
  assert.deepEqual(cached(), []);
});
