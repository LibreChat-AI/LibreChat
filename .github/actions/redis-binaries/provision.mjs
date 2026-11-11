#!/usr/bin/env node
/**
 * Puts `redis-server` and `redis-cli` at the pinned Redis version into
 * `~/.cache/redis-binaries/bin`, proves they run, and adds that directory to
 * PATH for the steps that follow.
 *
 * Nothing here talks to a package manager. A job that installed Redis with
 * apt needed the distro mirror to resolve at test time, and got whichever
 * version the mirror served that day. The binaries are instead restored from
 * the Actions cache; when the cache has none that match the pin, they are
 * built once from the pinned upstream commit. That fetch goes to the host the
 * job's own checkout already depended on, and git only accepts an object
 * whose content hashes to the commit asked for, so the pin is the checksum.
 *
 * `pin.json` holds everything that decides which binaries come out: version,
 * commit, repository and make flags. `key` prints the cache key derived from
 * it, from this file and from the runner's OS release, because a binary
 * linked against one release's libc is not trusted on another.
 *
 * Exits non-zero, with one `::error` line, when no runnable pinned binaries
 * could be put in place: a later step never meets a missing `redis-cli`.
 */
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';

const SCRIPT = fileURLToPath(import.meta.url);
const PIN_FILE = path.join(path.dirname(SCRIPT), 'pin.json');
const BINARIES = ['redis-server', 'redis-cli'];
const HOME_CACHE = path.join(os.homedir(), '.cache', 'redis-binaries');
const BIN = path.join(HOME_CACHE, 'bin');

/**
 * An unreachable host fails within 30 + 2 + 30 + 6 + 30 s. Hosted runners
 * needed 49 to 103 s for the whole cold path, so the build may take about
 * three times the slowest of those; fetch and build together stay inside an
 * eight-minute step.
 */
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_BACKOFF_MS = [2_000, 6_000];
const FETCH_ATTEMPTS = FETCH_BACKOFF_MS.length + 1;
const BUILD_TIMEOUT_MS = 300_000;
const VERSION_TIMEOUT_MS = 10_000;
const BUILD_LOG_TAIL = 40;

/** A workflow command ends at the first newline, so a multi-line message is folded into one. */
const headline = (error) =>
  String(error?.message ?? error)
    .split(/\s*\n\s*/)
    .filter(Boolean)
    .join(' ');

function readPin() {
  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  const valid =
    typeof pin.version === 'string' &&
    /^[0-9a-f]{40}$/.test(pin.commit) &&
    typeof pin.repository === 'string' &&
    Array.isArray(pin.flags);
  if (!valid) {
    throw new Error(`${PIN_FILE} must name a version, a full commit SHA, a repository and flags`);
  }
  return pin;
}

function fail(error) {
  console.error(error);
  console.error(`::error title=Redis binaries::${headline(error)}`);
  process.exit(1);
}

function loadPin() {
  try {
    return readPin();
  } catch (error) {
    return fail(error);
  }
}

const PIN = loadPin();
const SHORT_COMMIT = PIN.commit.slice(0, 8);

/** Best effort: a compiler orphaned by a timeout may still be writing into the directory. */
function discard(directory) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    return;
  }
}

/** Runs a command to completion; throws with the reason when it fails, is missing or times out. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    killSignal: 'SIGKILL',
    ...options,
  });
  if (result.status === 0) {
    return result.stdout ?? '';
  }
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const reason = timedOut
    ? `timed out after ${options.timeout / 1000}s`
    : result.error?.message ||
      result.stderr?.trim() ||
      `exit ${result.status ?? result.signal ?? 'unknown'}`;
  throw new Error(`${command} ${args[0]}: ${reason}`);
}

function osRelease() {
  if (process.platform !== 'linux') {
    return `${process.platform}-${os.release().split('.')[0]}`;
  }
  try {
    const release = readFileSync('/etc/os-release', 'utf8');
    const field = (name) => release.match(new RegExp(`^${name}="?([^"\\n]+)"?$`, 'm'))?.[1];
    return `${field('ID') ?? 'linux'}-${field('VERSION_ID') ?? os.release()}`;
  } catch {
    return `linux-${os.release()}`;
  }
}

function cacheKey() {
  const recipe = createHash('sha256')
    .update(readFileSync(SCRIPT))
    .update(readFileSync(PIN_FILE))
    .digest('hex')
    .slice(0, 16);
  return `redis-binaries-${osRelease()}-${process.arch}-${PIN.version}-${recipe}`;
}

/** The version line of one cached binary; throws unless it runs and is the pinned build. */
function identify(name) {
  const binary = path.join(BIN, name);
  const line = run(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS }).split('\n', 1)[0].trim();
  const match =
    name === 'redis-server'
      ? line.match(/^Redis server v=(\S+) sha=([0-9a-f]{8})/)
      : line.match(/^redis-cli (\S+) \(git:([0-9a-f]{8})\)/);
  if (match?.[1] !== PIN.version || match?.[2] !== SHORT_COMMIT) {
    throw new Error(
      `${binary} is not Redis ${PIN.version} built from ${SHORT_COMMIT}: ${line || 'no version line'}`,
    );
  }
  return line;
}

function git(args, directory, timeout) {
  return run('git', args, {
    cwd: directory,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** Each attempt gets its own repository, so a fetch killed by its timeout leaves no lock behind. */
function fetchCommit(root, attempt) {
  const directory = path.join(root, `attempt-${attempt}`);
  mkdirSync(directory);
  git(['init', '--quiet'], directory);
  git(
    ['fetch', '--quiet', '--depth', '1', '--no-tags', PIN.repository, PIN.commit],
    directory,
    FETCH_TIMEOUT_MS,
  );
  git(
    ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', 'FETCH_HEAD'],
    directory,
  );
  const head = git(['rev-parse', 'HEAD'], directory).trim();
  if (head !== PIN.commit) {
    throw new Error(`${PIN.repository} answered with ${head}, not the pinned ${PIN.commit}`);
  }
  return directory;
}

async function checkout(root, attempt = 1) {
  try {
    return fetchCommit(root, attempt);
  } catch (error) {
    if (attempt === FETCH_ATTEMPTS) {
      throw new Error(
        `Could not fetch Redis ${PIN.version} (${PIN.commit}) from ${PIN.repository} after ${FETCH_ATTEMPTS} attempts: ${headline(error)}`,
      );
    }
    const delay = FETCH_BACKOFF_MS[attempt - 1];
    console.log(
      `::warning::${headline(error)}. Retrying in ${delay / 1000}s (attempt ${attempt + 1} of ${FETCH_ATTEMPTS}).`,
    );
    await sleep(delay);
  }
  return checkout(root, attempt + 1);
}

/** Compiler output goes to a file; only its tail is shown, and only when the build fails. */
function build(directory) {
  const log = path.join(directory, 'redis-binaries-build.log');
  const output = openSync(log, 'w');
  const jobs = String(os.availableParallelism());
  try {
    run('make', ['-C', 'src', '-j', jobs, ...PIN.flags, ...BINARIES], {
      cwd: directory,
      timeout: BUILD_TIMEOUT_MS,
      stdio: ['ignore', output, output],
    });
  } catch (error) {
    const tail = readFileSync(log, 'utf8').trimEnd().split('\n').slice(-BUILD_LOG_TAIL);
    console.log(`::group::Last ${tail.length} lines of the Redis build`);
    console.log(tail.join('\n'));
    console.log('::endgroup::');
    throw new Error(`Building Redis ${PIN.version} failed: ${headline(error)}`);
  } finally {
    closeSync(output);
  }
}

function install(directory) {
  discard(BIN);
  mkdirSync(BIN, { recursive: true });
  for (const name of BINARIES) {
    copyFileSync(path.join(directory, 'src', name), path.join(BIN, name));
    chmodSync(path.join(BIN, name), 0o755);
  }
}

/** Nothing unusable stays behind: a failed build leaves the cache directory without binaries. */
async function buildFromSource() {
  const started = Date.now();
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'redis-source-'));
  try {
    const directory = await checkout(root);
    const fetched = Date.now();
    build(directory);
    install(directory);
    const lines = BINARIES.map(identify);
    const seconds = (from, to) => Math.round((to - from) / 1000);
    const took = `fetch ${seconds(started, fetched)}s, build ${seconds(fetched, Date.now())}s`;
    return { lines, source: `built from ${PIN.repository} at ${SHORT_COMMIT}: ${took}` };
  } catch (error) {
    discard(BIN);
    throw error;
  } finally {
    discard(root);
  }
}

async function provision() {
  if (!BINARIES.some((name) => existsSync(path.join(BIN, name)))) {
    console.log(`No Redis binaries in ${BIN}; building ${PIN.version} from ${SHORT_COMMIT}.`);
    return buildFromSource();
  }
  try {
    return { lines: BINARIES.map(identify), source: 'already present' };
  } catch (error) {
    console.log(`Rebuilding Redis ${PIN.version}: ${headline(error)}`);
    return buildFromSource();
  }
}

function exportPath() {
  if (!process.env.GITHUB_PATH) {
    console.log(`  GITHUB_PATH is not set; add ${BIN} to PATH yourself`);
    return;
  }
  appendFileSync(process.env.GITHUB_PATH, `${BIN}\n`);
}

async function main() {
  const result = await provision();
  console.log(`Redis ${PIN.version} ready in ${BIN} (${result.source})`);
  for (const line of result.lines) {
    console.log(`  ${line}`);
  }
  exportPath();
  if (result.source !== 'already present' && process.env.REDIS_BINARIES_CACHE_HIT === 'true') {
    console.log(
      '::warning::The restored Redis binary cache had no runnable pinned build, and an exact cache hit is never re-saved: every job rebuilds Redis until the cache entry is deleted or the pin changes.',
    );
  }
}

function printKey() {
  const key = cacheKey();
  console.log(key);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `key=${key}\n`);
  }
}

const command = process.argv[2] ?? 'provision';
const commands = { key: printKey, provision: main };

Promise.resolve()
  .then(() => {
    if (!Object.hasOwn(commands, command)) {
      throw new Error(`Unknown command "${command}"; expected "provision" or "key"`);
    }
    return commands[command]();
  })
  .catch(fail);
