#!/usr/bin/env node
/**
 * Package names imported by the repository's own source, for the unused-dependency
 * gate. depcheck misses imports it cannot resolve through workspaces and aliases, so
 * the gate treats anything found here as used.
 *
 * Installed dependencies and build output are not source: an import inside
 * `node_modules` says nothing about whether a manifest needs the package, and
 * walking it is what made the CI step slow.
 *
 *   node scripts/imports.mts <dir>=<output file> [<dir>=<output file> ...]
 *
 * writes each directory's packages, sorted and one per line, from a single listing.
 */

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { relative, resolve, sep } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

const IMPORT_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];
/** Never source, even when an unusual checkout leaves them unignored. */
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage']);

const IMPORT_PATTERNS = [
  /require\(\s*['"]([a-zA-Z0-9@/._-]+)['"]\s*\)/g,
  /\bimport\b[^\n]*?\bfrom\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
  /\bexport\b[^\n]*?\bfrom\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
  /\bimport\s*['"]([a-zA-Z0-9@/._-]+)['"]/g,
];

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`, relative -> null. */
export function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (!specifier.startsWith('@')) return specifier.split('/')[0];
  const [scope, name] = specifier.split('/');
  return name ? `${scope}/${name}` : null;
}

/** Packages one file's `require`, `import`, `import type` and `export ... from` name. */
export function packagesInSource(content: string): Set<string> {
  const packages = new Set<string>();
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      const name = packageName(match[1]);
      if (name) packages.add(name);
    }
  }
  return packages;
}

/**
 * Source files under `dirs`, as git sees the working tree: tracked files plus
 * untracked ones `.gitignore` does not exclude, so installs, build output and nested
 * worktrees drop out by the repository's own rules.
 */
function sourceFiles(root: string, dirs: string[]): string[] {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr || result.error?.message}`);
  }
  return [...new Set(result.stdout.split('\0'))].filter(
    (path) =>
      IMPORT_EXTENSIONS.some((ext) => path.endsWith(ext)) &&
      !path.split('/').some((segment) => SKIP_DIR_NAMES.has(segment)),
  );
}

/** Packages imported under each of `dirs` (relative to `root`), from one listing. */
export async function importedPackages(
  root: string,
  dirs: string[],
): Promise<Map<string, Set<string>>> {
  const targets = dirs.map((dir) => {
    const path = relative(root, resolve(root, dir)).split(sep).join('/');
    return { dir, prefix: path === '' ? '' : `${path}/` };
  });
  const result = new Map(dirs.map((dir) => [dir, new Set<string>()]));
  for (const path of sourceFiles(root, dirs)) {
    let content: string;
    try {
      content = await readFile(resolve(root, path), 'utf8');
    } catch (error) {
      // Tracked but deleted from the working tree; anything else is a real failure.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const packages = packagesInSource(content);
    for (const { dir, prefix } of targets) {
      if (!path.startsWith(prefix)) continue;
      const set = result.get(dir)!;
      for (const name of packages) set.add(name);
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pairs = process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('=');
    if (index <= 0 || index === arg.length - 1) {
      console.error(`Expected <dir>=<output file>, got "${arg}"`);
      process.exit(2);
    }
    return { dir: arg.slice(0, index), output: arg.slice(index + 1) };
  });
  const found = await importedPackages(process.cwd(), [...new Set(pairs.map(({ dir }) => dir))]);
  for (const { dir, output } of pairs) {
    const names = [...found.get(dir)!].sort();
    await writeFile(output, names.length > 0 ? `${names.join('\n')}\n` : '');
  }
}
