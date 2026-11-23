/**
 * Finds paths that are distinct on Linux but are one path on a file system that ignores case
 * (macOS, Windows). Two kinds of name collide there:
 *
 * - Module names: an import has no extension, so `import './Files'` tries `Files.ts` before
 *   `Files.tsx`, and on macOS `Files.ts` opens `files.ts`. `Files.tsx` beside `files.ts` builds on
 *   Linux CI and fails on a Mac.
 * - Plain paths: `Row.tsx` beside `row/`, or `README.md` beside `readme.md`.
 *
 * A changed path is checked against every tracked path, so a collision fails the change that
 * adds it and an unrelated change is never blamed for one already on the base branch.
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extensions a module resolver adds to an import that names none. */
const MODULE_EXTENSION = /\.(?:d\.)?[mc]?[jt]sx?$/;

/** Each name a path takes on disk or in an import: its directories, itself, and its module name. */
function namesOf(path: string): string[] {
  const parts = path.split('/');
  const names = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
  const module = path.replace(MODULE_EXTENSION, '');
  if (module !== path) names.push(module);
  return names;
}

/**
 * Returns one line per collision a `changed` path takes part in, as `a <-> b`, sorted.
 * `tracked` is every path in the tree and should already include the changed paths.
 */
export function findCasingCollisions(tracked: string[], changed: string[]): string[] {
  const spellings = new Map<string, Set<string>>();
  for (const path of new Set([...tracked, ...changed])) {
    for (const name of namesOf(path)) {
      const key = name.toLowerCase();
      const set = spellings.get(key) ?? new Set<string>();
      set.add(name);
      spellings.set(key, set);
    }
  }

  const collisions = new Set<string>();
  for (const path of changed) {
    for (const name of namesOf(path)) {
      const set = spellings.get(name.toLowerCase());
      if (set && set.size > 1) collisions.add([...set].sort().join(' <-> '));
    }
  }
  return [...collisions].sort();
}

/** Every path in the index, which holds the committed tree plus staged additions. */
export function trackedPaths(root: string): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tracked = trackedPaths(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  const changed = process.argv.slice(2);
  const collisions = findCasingCollisions(tracked, changed.length > 0 ? changed : tracked);
  for (const collision of collisions) console.log(collision);
  process.exit(collisions.length > 0 ? 1 : 0);
}
