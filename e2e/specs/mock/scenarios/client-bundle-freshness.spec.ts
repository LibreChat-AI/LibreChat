import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * The static checks refuse to lint against `packages/client/dist` unless every
 * bundle file it declares is newer than the package's build inputs. tsdown
 * copies the theme CSS and fonts with `fs.cp`, and on Windows that copy keeps
 * the source's mtime, so a checkout that wrote `tsconfig.json` after
 * `src/theme/tokens.css` left a copy no rebuild could make fresh. The scenario
 * reproduces that platform on any machine by preloading a `cp` that preserves
 * timestamps, then builds a scratch copy of the package so the real `dist` the
 * other scenarios read is never rewritten underneath them.
 */

const CLIENT = resolve(repoRoot, 'packages/client');
const TSDOWN = resolve(CLIENT, 'node_modules/tsdown/dist/run.mjs');
const OLD = new Date('2020-01-01T00:00:00Z');

const PRESERVE_TIMESTAMPS = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const cp = fs.promises.cp;
fs.promises.cp = (from, to, options) => cp(from, to, { ...options, preserveTimestamps: true });
syncBuiltinESMExports();
`;

function backdate(path: string): void {
  utimesSync(path, OLD, OLD);
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path)) backdate(join(path, entry));
}

function files(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return [path, ...readdirSync(path).flatMap((entry) => files(join(path, entry)))];
}

test.describe('the client package build', () => {
  test.beforeEach(inOneProject);

  test('copied theme files are fresh after a build even where cp keeps the source mtime @scenario:client-copied-bundle-files-fresh-after-build', () => {
    test.setTimeout(180_000);
    /** A dot directory inside the package resolves the package's own dependencies
     *  and is skipped by the freshness walk and the linters. */
    const scratch = mkdtempSync(join(CLIENT, '.freshness-'));
    try {
      cpSync(join(CLIENT, 'src'), join(scratch, 'src'), { recursive: true });
      for (const file of ['package.json', 'tsconfig.json', 'tsdown.config.mjs']) {
        cpSync(join(CLIENT, file), join(scratch, file));
      }
      const preload = join(scratch, 'preserve.mjs');
      writeFileSync(preload, PRESERVE_TIMESTAMPS);

      /** The checkout ordering from the report: the theme sources are older than
       *  the compiler options written after them. */
      backdate(join(scratch, 'src/theme'));
      const inputsAt = statSync(join(scratch, 'tsconfig.json')).mtimeMs;
      expect(inputsAt).toBeGreaterThan(OLD.getTime());

      const probe = join(scratch, 'probe');
      const control = spawnSync(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `import { cp } from 'node:fs/promises'; await cp(${JSON.stringify(
            join(scratch, 'src/theme/tokens.css'),
          )}, ${JSON.stringify(probe)});`,
        ],
        { encoding: 'utf8' },
      );
      expect(control.status, control.stderr).toBe(0);
      expect(statSync(probe).mtimeMs, 'the preload did not make cp keep timestamps').toBe(
        OLD.getTime(),
      );

      const build = spawnSync(process.execPath, ['--import', preload, TSDOWN], {
        cwd: scratch,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });
      expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);

      const dist = join(scratch, 'dist');
      const copied = ['tokens.css', 'defaults.css', 'fonts.css', 'fonts'].flatMap((name) =>
        files(join(dist, name)),
      );
      expect(copied.length).toBeGreaterThan(4);
      for (const file of copied) {
        expect(
          statSync(file).mtimeMs,
          `${file} is older than the build inputs`,
        ).toBeGreaterThanOrEqual(inputsAt);
      }
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });
});
