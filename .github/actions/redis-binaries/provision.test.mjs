import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

/**
 * Runs the real script, with real git and real make, against a stand-in for
 * the Redis repository: a local repository whose `src/Makefile` "builds"
 * `redis-server` and `redis-cli` as shell scripts that print the version lines
 * the real binaries print, embedding the commit they were built from the way
 * the Redis build does. The script reads the pin from the file beside it, so
 * each test runs a copy of it next to a pin for that stand-in. Only the
 * network is replaced: a `git` first on PATH counts fetches and can fail the
 * first few before handing over to the real one.
 */
const SCRIPT = fileURLToPath(new URL('./provision.mjs', import.meta.url));
const VERSION = '9.9.9';
const posixOnly = {
  skip: process.platform === 'win32' && 'the stand-in binaries are shell scripts',
};

const MAKEFILE = `
SHA := $(shell git rev-parse --short=8 HEAD)
VERSION := __VERSION__
redis-server:
\t@printf '#!/bin/sh\\necho "Redis server v=%s sha=%s:0 malloc=libc bits=64 build=tls-%s-systemd-%s"\\n' '$(VERSION)' '$(SHA)' '$(BUILD_TLS)' '$(USE_SYSTEMD)' > $@
\t@chmod +x $@
redis-cli:
\t@printf '#!/bin/sh\\necho "redis-cli %s (git:%s)"\\n' '$(VERSION)' '$(SHA)' > $@
\t@chmod +x $@
`;

const BROKEN_MAKEFILE = `
redis-server redis-cli:
\t@echo "cc: fatal error: no input files" >&2
\t@exit 2
`;

const GIT_SHIM = `#!/bin/sh
if [ "$1" = fetch ]; then
  echo fetch >> "$FAKE_FETCH_LOG"
  if [ "$(wc -l < "$FAKE_FETCH_LOG")" -le "\${FAKE_FETCH_FAILURES:-0}" ]; then
    echo "fatal: unable to access 'https://example.invalid/': Could not resolve host" >&2
    exit 128
  fi
fi
exec "$REAL_GIT" "$@"
`;

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

/** The developer's own git configuration (signing, hooks, templates) stays out of the stand-in. */
const HERMETIC_GIT = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function sh(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: HERMETIC_GIT });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t, { makefile = MAKEFILE.replace('__VERSION__', VERSION) } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redis-binaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const action = path.join(root, 'action');
  const upstream = path.join(root, 'upstream');
  const shim = path.join(root, 'shim');
  const bin = path.join(home, '.cache', 'redis-binaries', 'bin');
  const fetchLog = path.join(root, 'fetches.log');
  const githubPath = path.join(root, 'github-path');
  const githubOutput = path.join(root, 'github-output');
  for (const directory of [home, action, path.join(upstream, 'src'), shim]) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(path.join(upstream, 'src', 'Makefile'), makefile);
  sh('git', ['init', '--quiet', '--initial-branch', 'main'], upstream);
  sh('git', ['add', '.'], upstream);
  sh(
    'git',
    ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'x'],
    upstream,
  );
  const commit = sh('git', ['rev-parse', 'HEAD'], upstream);

  writeFileSync(path.join(shim, 'git'), GIT_SHIM);
  chmodSync(path.join(shim, 'git'), 0o755);
  copyFileSync(SCRIPT, path.join(action, 'provision.mjs'));
  const pin = (overrides = {}) =>
    writeFileSync(
      path.join(action, 'pin.json'),
      JSON.stringify({
        version: VERSION,
        commit,
        repository: upstream,
        flags: ['BUILD_TLS=no', 'USE_SYSTEMD=no'],
        ...overrides,
      }),
    );
  pin();

  const run = (args = [], env = {}) => {
    const result = spawnSync(process.execPath, [path.join(action, 'provision.mjs'), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: `${shim}${path.delimiter}${process.env.PATH}`,
        RUNNER_TEMP: root,
        REAL_GIT,
        FAKE_FETCH_LOG: fetchLog,
        GITHUB_PATH: githubPath,
        GITHUB_OUTPUT: githubOutput,
        REDIS_BINARIES_CACHE_HIT: '',
        ...env,
      },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const place = (version, sha) => {
    mkdirSync(bin, { recursive: true });
    const lines = {
      'redis-server': `Redis server v=${version} sha=${sha}:0 malloc=libc bits=64 build=old`,
      'redis-cli': `redis-cli ${version} (git:${sha})`,
    };
    for (const [name, line] of Object.entries(lines)) {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${line}"\n`);
      chmodSync(path.join(bin, name), 0o755);
    }
  };
  const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
  const fetches = () => read(fetchLog).split('\n').filter(Boolean).length;
  const cached = () => (existsSync(bin) ? readdirSync(bin).sort() : []);
  const leftovers = () => readdirSync(root).filter((name) => name.startsWith('redis-source-'));
  const exported = () => read(githubPath);
  const output = () => read(githubOutput);
  return { bin, commit, pin, run, place, fetches, cached, leftovers, exported, output };
}

test('a cold cache is filled by one fetch of the pinned commit and one build', posixOnly, (t) => {
  const { bin, commit, run, fetches, cached, leftovers, exported } = fixture(t);
  const { status, output } = run();
  assert.equal(status, 0, output);
  assert.match(
    output,
    new RegExp(
      `Redis 9\\.9\\.9 ready in ${bin} \\(built from .* at ${commit.slice(0, 8)}: fetch \\d+s, build \\d+s\\)`,
    ),
  );
  assert.match(output, new RegExp(`Redis server v=9\\.9\\.9 sha=${commit.slice(0, 8)}:0`));
  assert.match(output, /build=tls-no-systemd-no/, 'the pinned flags reach make');
  assert.match(output, new RegExp(`redis-cli 9\\.9\\.9 \\(git:${commit.slice(0, 8)}\\)`));
  assert.match(output, new RegExp(`No Redis binaries in ${bin}; building 9\\.9\\.9 from`));
  assert.doesNotMatch(output, /::warning::|::error/);
  assert.equal(fetches(), 1);
  assert.deepEqual(cached(), ['redis-cli', 'redis-server']);
  assert.equal(exported(), `${bin}\n`);
  assert.deepEqual(leftovers(), [], 'the source tree is removed once the binaries are in place');
});

test('binaries already in the cache are verified and nothing is fetched', posixOnly, (t) => {
  const { bin, run, fetches, exported } = fixture(t);
  assert.equal(run().status, 0);
  const { status, output } = run([], {
    FAKE_FETCH_FAILURES: '99',
    REDIS_BINARIES_CACHE_HIT: 'true',
  });
  assert.equal(status, 0, output);
  assert.match(output, /Redis 9\.9\.9 ready in .* \(already present\)/);
  assert.doesNotMatch(output, /::warning::/);
  assert.equal(fetches(), 1, 'the second run needs no network');
  assert.equal(exported(), `${bin}\n${bin}\n`);
});

test('cached binaries of another version or commit are rebuilt, with a warning', posixOnly, (t) => {
  const { commit, run, place, fetches } = fixture(t);
  for (const [version, sha] of [
    ['9.9.8', commit.slice(0, 8)],
    [VERSION, '0badc0de'],
  ]) {
    place(version, sha);
    const { status, output } = run([], { REDIS_BINARIES_CACHE_HIT: 'true' });
    assert.equal(status, 0, output);
    assert.match(output, /Rebuilding Redis 9\.9\.9: .* is not Redis 9\.9\.9 built from/);
    assert.match(output, /\(built from /);
    assert.match(output, /::warning::The restored Redis binary cache had no runnable pinned build/);
  }
  assert.equal(fetches(), 2);
});

test('a fetch that fails once is retried and the build goes ahead', posixOnly, (t) => {
  const { run, fetches, cached } = fixture(t);
  const { status, output } = run([], { FAKE_FETCH_FAILURES: '1' });
  assert.equal(status, 0, output);
  assert.match(
    output,
    /::warning::git fetch: fatal: unable to access .* Retrying in 2s \(attempt 2 of 3\)/,
  );
  assert.equal(fetches(), 2);
  assert.deepEqual(cached(), ['redis-cli', 'redis-server']);
});

test(
  'the job fails after three attempts when the pinned commit cannot be fetched',
  posixOnly,
  (t) => {
    const { pin, run, fetches, cached, leftovers, exported } = fixture(t);
    const missing = 'f'.repeat(40);
    pin({ commit: missing });
    const { status, output } = run();
    assert.equal(status, 1, output);
    assert.match(
      output,
      new RegExp(
        `^::error title=Redis binaries::Could not fetch Redis 9\\.9\\.9 \\(${missing}\\) from .* after 3 attempts: git fetch: `,
        'm',
      ),
    );
    assert.equal(fetches(), 3, 'bounded, not a loop');
    assert.deepEqual(cached(), []);
    assert.deepEqual(leftovers(), []);
    assert.equal(exported(), '', 'no later step is pointed at binaries that do not exist');
  },
);

test('the job fails with the end of the build log when Redis does not compile', posixOnly, (t) => {
  const { run, cached, leftovers, exported } = fixture(t, { makefile: BROKEN_MAKEFILE });
  const { status, output } = run();
  assert.equal(status, 1, output);
  assert.match(output, /::group::Last \d+ lines of the Redis build/);
  assert.match(output, /cc: fatal error: no input files/);
  assert.match(output, /^::error title=Redis binaries::Building Redis 9\.9\.9 failed: make -C: /m);
  assert.deepEqual(cached(), []);
  assert.deepEqual(leftovers(), []);
  assert.equal(exported(), '');
});

test(
  'a build that is not the pinned version is rejected and not left in the cache',
  posixOnly,
  (t) => {
    const { run, cached, exported } = fixture(t, {
      makefile: MAKEFILE.replace('__VERSION__', '9.9.8'),
    });
    const { status, output } = run();
    assert.equal(status, 1, output);
    assert.match(
      output,
      /^::error title=Redis binaries::.*redis-server is not Redis 9\.9\.9 built from/m,
    );
    assert.deepEqual(cached(), []);
    assert.equal(exported(), '');
  },
);

test('the cache key follows the pin and the script, and is stable otherwise', posixOnly, (t) => {
  const { commit, pin, run, output } = fixture(t);
  const key = () => {
    const result = run(['key']);
    assert.equal(result.status, 0, result.output);
    return result.output.trim();
  };
  const first = key();
  assert.match(first, new RegExp(`^redis-binaries-.+-${process.arch}-9\\.9\\.9-[0-9a-f]{16}$`));
  assert.equal(key(), first);
  assert.equal(output(), `key=${first}\nkey=${first}\n`);
  pin({ flags: ['BUILD_TLS=yes', 'USE_SYSTEMD=no'] });
  const flagged = key();
  assert.notEqual(flagged, first);
  pin({ commit: commit.replace(/.$/, (last) => (last === '0' ? '1' : '0')) });
  assert.notEqual(key(), first);
  assert.notEqual(key(), flagged);
});

test('a malformed pin or an unknown command fails with one error line', posixOnly, (t) => {
  const { pin, run } = fixture(t);
  const unknown = run(['install']);
  assert.equal(unknown.status, 1, unknown.output);
  assert.match(unknown.output, /^::error title=Redis binaries::Unknown command "install"/m);
  pin({ commit: 'main' });
  const malformed = run();
  assert.equal(malformed.status, 1, malformed.output);
  assert.match(
    malformed.output,
    /^::error title=Redis binaries::.*pin\.json must name a version, a full commit SHA/m,
  );
});
