import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * Every job on this pull request died in `npm ci`: the lockfile entries the stack
 * added resolved to a private mirror that no GitHub runner and no contributor can
 * reach. What a clean install needs is that each locked tarball comes from a host
 * this repository already installs from, and that the registry actually serves
 * it — so the hosts are checked for the whole lockfile and the tarballs are then
 * asked for. Neither half depends on this being a branch: the same assertions
 * hold on `dev` and after this change merges.
 */

type LockEntry = { resolved?: string; integrity?: string; version?: string; link?: boolean };
type Lockfile = { packages: Record<string, LockEntry> };

const PUBLIC_REGISTRY = 'registry.npmjs.org';

/**
 * The one non-registry host this repository installs from, and the one package
 * it serves: `xlsx` is published on SheetJS's own CDN. Keyed by package rather
 * than listed as a host, so regenerating the lockfile against that CDN cannot
 * quietly move anything else onto it.
 */
const INHERITED_HOST_OF: Record<string, string> = { xlsx: 'cdn.sheetjs.com' };

/** Lock keys nest: `node_modules/a/node_modules/xlsx` is still `xlsx`. */
const packageOf = (key: string): string => key.split('node_modules/').pop() ?? key;

/** Workspace links resolve to a directory in this repo, not to a tarball; every
 *  other `resolved` is a URL, and one that is not `https` is itself the
 *  failure, so it is reported as an unusable host rather than skipped. */
const tarballHost = (entry: LockEntry): string | undefined => {
  if (entry.link || !entry.resolved) return undefined;
  if (!entry.resolved.startsWith('https://')) return `insecure:${entry.resolved}`;
  return new URL(entry.resolved).host;
};

/**
 * Every locked entry a clean install could not fetch from a host this
 * repository already installs from, named rather than counted so a lockfile
 * written against a private mirror says which package brought it. The exception
 * belongs to a package, not to a host: `xlsx` may come from SheetJS's CDN at
 * any version, and nothing else may come from anywhere but the registry — which
 * is the case a version comparison against the base branch would miss, since
 * regenerating a lockfile can rewrite `resolved` without touching `version`.
 */
export function offRegistry(head: Lockfile): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(head.packages)) {
    const host = tarballHost(entry);
    if (host === undefined || host === PUBLIC_REGISTRY) continue;
    if (INHERITED_HOST_OF[packageOf(key)] === host) continue;
    problems.push(`${key} -> ${entry.resolved}`);
  }
  return problems;
}

test.describe('the locked dependency set', () => {
  test('every locked package resolves from the public registry @scenario:every-locked-package-resolves-from-the-public-registry', () => {
    inOneProject();
    test.setTimeout(180_000);

    const head = JSON.parse(
      readFileSync(resolve(repoRoot, 'package-lock.json'), 'utf8'),
    ) as Lockfile;
    const entries = Object.entries(head.packages);
    expect(entries.length).toBeGreaterThan(0);
    expect(
      offRegistry(head),
      'a locked tarball outside the public registry cannot be installed in CI',
    ).toEqual([]);

    /** And what that rule actually says, on lockfiles written for the purpose:
     *  the CDN belongs to `xlsx` and to no one else, at any version. */
    const at = (host: string, version: string): LockEntry => ({
      resolved: `https://${host}/package.tgz`,
      version,
    });
    const locked: Lockfile = {
      packages: {
        'node_modules/xlsx': at('cdn.sheetjs.com', '0.20.0'),
        'node_modules/lodash': at(PUBLIC_REGISTRY, '4.17.21'),
      },
    };
    expect(
      offRegistry({
        packages: { ...locked.packages, 'node_modules/xlsx': at('cdn.sheetjs.com', '0.20.3') },
      }),
      'upgrading xlsx on its own CDN is not a new vendor host',
    ).toEqual([]);
    expect(
      offRegistry({
        packages: { ...locked.packages, 'node_modules/lodash': at('cdn.sheetjs.com', '4.17.21') },
      }),
      'a package rewritten onto the CDN at the same version passed',
    ).toEqual(['node_modules/lodash -> https://cdn.sheetjs.com/package.tgz']);
    expect(
      offRegistry({
        packages: { ...locked.packages, 'node_modules/new': at('mirror.internal', '1.0.0') },
      }),
      'a package added from a private mirror passed',
    ).toEqual(['node_modules/new -> https://mirror.internal/package.tgz']);
    expect(
      offRegistry({
        packages: {
          ...locked.packages,
          'node_modules/a/node_modules/xlsx': at('cdn.sheetjs.com', '0.20.3'),
        },
      }),
      'a nested xlsx on its own CDN is the same package',
    ).toEqual([]);

    /** A declared dependency with no entry of its own is the other way a clean
     *  install reaches the network: `npm ci` would resolve it live. */
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    const unlocked = declared.filter(
      (name) => !head.packages[`node_modules/${name}`] && !head.packages[name],
    );
    expect(
      unlocked,
      'a declared dependency has no lockfile entry; npm ci would resolve it live',
    ).toEqual([]);

    /** Deliberately no request to the registry: whether it serves these tarballs
     *  today is what `npm ci` in this very job already proved, and a 429 from a
     *  rate limit would otherwise fail a pull request that changed none of this.
     *  What the lockfile says is what this scenario owns. */
  });
});
