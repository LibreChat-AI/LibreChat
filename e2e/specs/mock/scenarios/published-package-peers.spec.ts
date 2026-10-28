import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot, run } from './lint.helpers';

/**
 * `@librechat/client` now emits utilities only Tailwind 4 generates —
 * `outline-hidden`, `shadow-xs`, `origin-(--radix-…)`. A host on Tailwind 3
 * installs the package without complaint and silently loses focus suppression
 * and popup transform origins, which is a styling bug with no error attached to
 * it. The package therefore has to declare the range as a peer, and npm has to
 * be the one that says so — this scenario packs the real tarball and asks it.
 */

type ClientManifest = { name: string; version: string; peerDependencies: Record<string, string> };

test.describe('the published package contract', () => {
  test('installing the package beside tailwind 3 fails the peer check @scenario:installing-the-package-beside-tailwind-3-fails-the-peer-check', () => {
    test.setTimeout(300_000);

    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'packages/client/package.json'), 'utf8'),
    ) as ClientManifest;
    expect(manifest.peerDependencies.tailwindcss).toBeDefined();

    const scratch = mkdtempSync(join(tmpdir(), 'lc-peer-check-'));
    try {
      const packed = run('npm', [
        'pack',
        resolve(repoRoot, 'packages/client'),
        '--pack-destination',
        scratch,
        '--silent',
      ]);
      test.skip(packed.status !== 0, `npm pack failed here: ${packed.output}`);
      const tarball = packed.stdout.trim().split('\n').pop()!;

      writeFileSync(
        join(scratch, 'package.json'),
        `${JSON.stringify(
          {
            name: 'librechat-client-peer-probe',
            version: '1.0.0',
            private: true,
            dependencies: { tailwindcss: '^3.4.0' },
          },
          null,
          2,
        )}\n`,
      );

      /** `--dry-run` resolves the tree and writes nothing. npm fails the install
       *  with ERESOLVE when a peer cannot be satisfied, which is the warning a
       *  Tailwind 3 host was not getting. */
      const install = run('npm', [
        'install',
        '--dry-run',
        '--no-audit',
        '--no-fund',
        '--prefix',
        scratch,
        join(scratch, tarball),
      ]);
      test.skip(
        /ENOTFOUND|EAI_AGAIN|network|ECONNREFUSED/i.test(install.output),
        `the registry is unreachable from here: ${install.output.slice(0, 400)}`,
      );

      expect(
        install.status,
        `npm accepted Tailwind 3 beside the package:\n${install.output}`,
      ).not.toBe(0);
      expect(install.output).toContain('ERESOLVE');
      expect(install.output).toContain('tailwindcss');
      expect(install.output).toContain(manifest.peerDependencies.tailwindcss);
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });
});
