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
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, staticChecks } from './lint.helpers';

/**
 * `scripts/typecheck.mts` is the type checker contributors and the frontend
 * review jobs run: `bun check` when the installed Bun provides it, the
 * repository's `tsc` otherwise. Each scenario runs the real script against a
 * scratch project with a PATH it controls, so the choice of checker is what
 * the scenario observes, whether or not the machine running it has Bun.
 */

const SCRIPT = resolve(repoRoot, 'scripts/typecheck.mts');

interface Scratch {
  dir: string;
  project: string;
  bin: string;
}

/** A one-file strict project, with or without a type error, plus an empty bin dir. */
function scratch(source: string): Scratch {
  const dir = mkdtempSync(join(tmpdir(), 'lc-typecheck-'));
  writeFileSync(join(dir, 'index.ts'), source);
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, types: [], skipLibCheck: true },
      files: ['index.ts'],
    }),
  );
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  return { dir, project: join(dir, 'tsconfig.json'), bin };
}

/** A stand-in `bun` that logs its arguments; `check --help` answers `helpStatus`. */
function fakeBun(bin: string, log: string, helpStatus: number, checkStatus: number): void {
  const path = join(bin, 'bun');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      `printf '%s: %s\\n' "$PWD" "$*" >> '${log}'`,
      `if [ "$2" = "--help" ]; then exit ${helpStatus}; fi`,
      `exit ${checkStatus}`,
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

/** Runs the script from the repository root with only `bin` and node on PATH. */
function typecheck(bin: string, project: string) {
  const result = spawnSync(process.execPath, [SCRIPT, '-p', project], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function logged(log: string): string {
  return existsSync(log) ? readFileSync(log, 'utf8') : '';
}

test.describe('the shared type checker', () => {
  test.beforeEach(inOneProject);

  test('a contributor with Bun gets bun check, and its verdict is the run verdict @scenario:typecheck-runs-bun-check-when-bun-provides-it', () => {
    const { dir, project, bin } = scratch('export const value: number = 1;\n');
    const log = join(dir, 'bun.log');
    try {
      fakeBun(bin, log, 0, 1);
      const failing = typecheck(bin, project);
      expect(failing.status, 'a failing bun check passed the run').toBe(1);
      expect(logged(log)).toContain(`check -p ${project}`);
      expect(failing.output).not.toContain('falling back to tsc');

      fakeBun(bin, log, 0, 0);
      expect(typecheck(bin, project).status, 'a passing bun check failed the run').toBe(0);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('a contributor without Bun falls back to tsc, which still fails on a type error @scenario:typecheck-falls-back-to-tsc-without-bun', () => {
    const broken = scratch("export const value: number = 'text';\n");
    const clean = scratch('export const value: number = 1;\n');
    try {
      const failing = typecheck(broken.bin, broken.project);
      expect(failing.output).toContain('falling back to tsc');
      expect(failing.output).toContain(
        `install Bun ${readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim()}`,
      );
      expect(failing.output).toContain('TS2322');
      expect(failing.status, 'the fallback hid a type error').not.toBe(0);

      const passing = typecheck(clean.bin, clean.project);
      expect(passing.output).toContain('falling back to tsc');
      expect(passing.status).toBe(0);
    } finally {
      rmSync(broken.dir, { force: true, recursive: true });
      rmSync(clean.dir, { force: true, recursive: true });
    }
  });

  test('a Bun release without the check command falls back to tsc @scenario:typecheck-falls-back-on-bun-without-check', () => {
    const { dir, project, bin } = scratch("export const value: number = 'text';\n");
    const log = join(dir, 'bun.log');
    try {
      fakeBun(bin, log, 1, 0);
      const result = typecheck(bin, project);
      expect(result.output).toContain('falling back to tsc');
      expect(result.output).toContain('TS2322');
      expect(result.status).not.toBe(0);
      expect(logged(log), 'bun check ran although Bun reported no check command').not.toContain(
        `check -p`,
      );
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('the root command checks every TypeScript workspace and the chat test project @scenario:root-typecheck-covers-all-workspaces', () => {
    const { dir, bin } = scratch('export const value: number = 1;\n');
    const log = join(dir, 'bun.log');
    try {
      fakeBun(bin, log, 0, 0);
      const run = () =>
        spawnSync('npm', ['run', 'typecheck', '--silent'], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
        });
      const passing = run();
      expect(passing.status, `${passing.stdout}${passing.stderr}`).toBe(0);

      const projects = [
        'client',
        ...readdirSync(join(repoRoot, 'packages')).map((name) => `packages/${name}`),
      ].filter((path) => existsSync(join(repoRoot, path, 'tsconfig.json')));
      const checked = logged(log)
        .trim()
        .split('\n')
        .filter((line) => line.includes(': check') && !line.includes('--help'));
      expect(checked.sort()).toEqual(
        [
          ...projects.map((path) => `${join(repoRoot, path)}: check`),
          `${join(repoRoot, 'packages/chat')}: check -p test/tsconfig.json`,
        ].sort(),
      );

      fakeBun(bin, log, 0, 1);
      const failing = run();
      expect(failing.status, 'the root command hid a workspace type error').not.toBe(0);
      expect(`${failing.stdout}${failing.stderr}`).not.toContain('falling back to tsc');
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test('CI and local tooling share the Bun 1.4.4 pin @scenario:typecheck-shares-bun-version-pin', () => {
    expect(readFileSync(join(repoRoot, '.bun-version'), 'utf8').trim()).toBe('1.4.4');
    const workflows = readdirSync(join(repoRoot, '.github/workflows')).filter((file) =>
      /\.ya?ml$/.test(file),
    );
    let setupCount = 0;
    for (const file of workflows) {
      const workflow = yaml.load(
        readFileSync(join(repoRoot, '.github/workflows', file), 'utf8'),
      ) as {
        on: Record<string, { paths?: string[] }>;
        jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
      };
      const setups = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? []).filter((step) => step.uses?.startsWith('oven-sh/setup-bun@')),
      );
      if (setups.length === 0) continue;
      setupCount += setups.length;
      for (const setup of setups) {
        expect(setup.with?.['bun-version-file'], file).toBe('.bun-version');
        expect(setup.with?.['bun-version'], file).toBeUndefined();
      }
      for (const event of ['push', 'pull_request']) {
        expect(workflow.on[event].paths, `${file}: ${event}`).toContain('.bun-version');
      }
    }
    expect(setupCount).toBe(3);
    const listed = staticChecks(['.bun-version', '--list', '--full']);
    expect(listed.output).toMatch(/TypeScript \(typecheck\)\s+would run/);
  });

  test('a change to the shared checker alone selects the TypeScript gate @scenario:a-checker-only-change-selects-the-typecheck-gate', () => {
    const listed = staticChecks(['scripts/typecheck.mts', '--list', '--full']);
    expect(listed.output).toMatch(/TypeScript \(typecheck\)\s+would run/);
  });
});
