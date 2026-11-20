#!/usr/bin/env node
/**
 * Puts the mongod build the installed mongodb-memory-server asks for into
 * `~/.cache/mongodb-binaries` before any test starts, and proves it runs.
 *
 * Left to itself the library downloads the ~120 MB archive the first time a
 * test calls `MongoMemoryServer.create()`: inside a `beforeAll` with a 15 s
 * budget. On a slow mirror that hook times out while the download carries on,
 * and whatever starts next spawns a file that is still being written
 * (`spawn ETXTBSY`).
 *
 * The home cache is the one location every consumer resolves no matter where
 * it runs. The copy `npm ci` leaves in the root `node_modules/.cache` is only
 * seen from the repository root: the library derives that directory from
 * INIT_CWD or the working directory, so suites run from `api`,
 * `packages/api` or `packages/data-schemas` look in their own, find nothing
 * and download. A binary found anywhere else is therefore copied into the
 * shared directory rather than trusted.
 *
 * The version, platform and archive are the library's own answer
 * (`MongoBinary.getPath()`), read from the working directory's install, so a
 * dependency bump moves the binary with it. Exits non-zero when no runnable
 * binary could be put in place.
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';

const HOME_CACHE = path.join(os.homedir(), '.cache', 'mongodb-binaries');
const CHECKSUM = '.md5';
const DOWNLOAD_ATTEMPTS = 2;

/**
 * Where the library looks for an existing binary: MONGOMS_DOWNLOAD_DIR, the
 * home cache, `node_modules/.cache` and `./mongodb-binaries`.
 */
const LOOKUP_LOCATIONS = 4;

/**
 * The directory the library checks first from any working directory: the home
 * cache, unless the job points MONGOMS_DOWNLOAD_DIR somewhere else for its tests too.
 */
const SHARED = process.env.MONGOMS_DOWNLOAD_DIR
  ? path.resolve(process.env.MONGOMS_DOWNLOAD_DIR)
  : HOME_CACHE;

/** A job that names its own mongod owns that file: it is checked, never copied or replaced. */
const SYSTEM_BINARY = process.env.MONGOMS_SYSTEM_BINARY;

/** A workflow command ends at the first newline, so a multi-line message is folded into one. */
const headline = (error) =>
  String(error?.message ?? error)
    .split(/\s*\n\s*/)
    .filter(Boolean)
    .join(' ');

function loadLibrary() {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  try {
    return require('mongodb-memory-server');
  } catch (error) {
    throw new Error(
      `mongodb-memory-server is not installed under ${process.cwd()}; run this action after dependencies are installed (${headline(error)})`,
    );
  }
}

function entries(directory) {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** Modification time per file, so a binary the library replaced is not mistaken for the cached one. */
function snapshot(directory) {
  return new Map(
    entries(directory).map((name) => [name, statSync(path.join(directory, name)).mtimeMs]),
  );
}

function remove(binary) {
  rmSync(binary, { force: true });
  rmSync(binary + CHECKSUM, { force: true });
}

/** The checksum sidecar travels with the binary: the library discards a binary that lacks one. */
function copy(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  if (existsSync(source + CHECKSUM)) {
    copyFileSync(source + CHECKSUM, target + CHECKSUM);
  }
}

/** The first line of `mongod --version`; throws with the reason when the binary cannot run. */
function version(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  if (result.status === 0) {
    return result.stdout.split('\n', 1)[0].trim();
  }
  const reason =
    result.error?.message ||
    result.stderr?.trim() ||
    `exit ${result.status ?? result.signal ?? 'unknown'}`;
  throw new Error(`${binary} does not run: ${reason}`);
}

function describe(located, binary, cached) {
  if (SYSTEM_BINARY) {
    return 'MONGOMS_SYSTEM_BINARY';
  }
  if (located !== binary) {
    return `copied from ${located}`;
  }
  return cached.get(path.basename(binary)) === statSync(binary).mtimeMs
    ? 'already present'
    : 'downloaded';
}

/**
 * Checks whatever the library resolves. A binary that does not run is deleted
 * wherever it was found, so the next call resolves something else: another
 * copy that was already on disk, or a fresh download.
 */
async function provision({ MongoBinary, DryMongoBinary }) {
  const cached = snapshot(SHARED);
  const located = await MongoBinary.getPath();
  const inPlace = Boolean(SYSTEM_BINARY) || path.dirname(located) === SHARED;
  const binary = inPlace ? located : path.join(SHARED, path.basename(located));
  if (!inPlace) {
    copy(located, binary);
  }
  const source = describe(located, binary, cached);
  try {
    return { binary, source, version: version(binary) };
  } catch (error) {
    if (!SYSTEM_BINARY) {
      remove(binary);
      remove(located);
      DryMongoBinary.binaryCache.clear();
    }
    throw Object.assign(error, { preexisting: source !== 'downloaded' });
  }
}

/**
 * Copies that were already on disk and do not run are discarded one at a time
 * without spending a download, so a broken file in one location cannot hide a
 * good one, or the download, behind it. The download itself gets two attempts:
 * a second failure is the mirror or the archive, not chance.
 */
async function provisionWithRecovery(library) {
  let discarded = 0;
  let downloads = 0;
  for (;;) {
    try {
      return await provision(library);
    } catch (error) {
      if (error.preexisting) {
        discarded += 1;
      } else {
        downloads += 1;
      }
      if (SYSTEM_BINARY || downloads >= DOWNLOAD_ATTEMPTS || discarded > LOOKUP_LOCATIONS) {
        throw error;
      }
      const next = error.preexisting ? 'Discarded it; resolving again' : 'Retrying the download';
      console.log(`::warning::${headline(error)}. ${next}.`);
    }
  }
}

/** A newer binary supersedes the ones an older lockfile's cache carried over. */
function prune(binary) {
  const keep = new Set([path.basename(binary), path.basename(binary) + CHECKSUM]);
  return entries(SHARED).filter((name) => {
    if (!name.startsWith('mongod-') || keep.has(name)) {
      return false;
    }
    rmSync(path.join(SHARED, name), { force: true });
    return true;
  });
}

async function main() {
  const library = loadLibrary();
  const result = await provisionWithRecovery(library);
  console.log(`mongod ready: ${result.binary}`);
  console.log(`  ${result.version} (${result.source})`);

  if (SYSTEM_BINARY || SHARED !== HOME_CACHE) {
    console.log(`  outside ${HOME_CACHE}, so the binary cache does not cover it`);
  }
  if (SYSTEM_BINARY || result.source === 'already present') {
    return;
  }
  const stale = prune(result.binary);
  if (stale.length > 0) {
    console.log(`  removed superseded binaries: ${stale.join(', ')}`);
  }
  if (process.env.MONGODB_BINARY_CACHE_HIT === 'true') {
    console.log(
      '::warning::The restored MongoDB binary cache had no runnable mongod for this install, and an exact cache hit is never re-saved: every job repeats this until the cache entry is deleted or package-lock.json changes.',
    );
  }
}

main().catch((error) => {
  console.error(error);
  console.error(`::error title=MongoDB binary::${headline(error)}`);
  process.exit(1);
});
