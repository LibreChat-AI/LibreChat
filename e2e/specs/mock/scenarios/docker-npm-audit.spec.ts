import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * The image builds run `npm ci` and `npm prune` as separate commands, and npm
 * audits after each one unless that command opts out. These scenarios read the
 * npm commands out of both Dockerfiles and run them in a scratch project whose
 * registry is a local server, so an audit shows up as a request to it.
 */

const DOCKERFILES = ['Dockerfile', 'Dockerfile.multi'];
const AUDIT_PATH = '/-/npm/v1/security/';

/** Every `npm ci` / `npm prune` invocation in a Dockerfile, without its shell wrapper. */
function npmCommands(file: string): string[][] {
  const source = readFileSync(resolve(repoRoot, file), 'utf8');
  const matches = source.match(/npm (?:ci|prune)\b[^;&|\\\n]*/g) ?? [];
  return matches.map((command) => command.trim().split(/\s+/).slice(1));
}

const PACKAGES = ['prod-dep', 'dev-dep'];

interface Tarball {
  data: Buffer;
  integrity: string;
}

interface Registry {
  server: Server;
  url: string;
  requests: string[];
}

/** Packs each scratch package once so the registry can serve it like a published one. */
function packTarballs(): Map<string, Tarball> {
  const dir = mkdtempSync(join(tmpdir(), 'lc-docker-npm-pack-'));
  const tarballs = new Map<string, Tarball>();
  try {
    for (const name of PACKAGES) {
      const source = join(dir, name);
      mkdirSync(source);
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      writeFileSync(join(source, 'index.js'), 'module.exports = 1;\n');
      const file = join(dir, `${name}-1.0.0.tgz`);
      execFileSync('tar', ['-czf', file, '--transform', `s,^${name},package,`, '-C', dir, name]);
      const data = readFileSync(file);
      const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
      tarballs.set(name, { data, integrity });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return tarballs;
}

const TARBALLS = packTarballs();

/** A registry serving the scratch packages that remembers every path asked of it. */
async function startRegistry(): Promise<Registry> {
  const requests: string[] = [];
  let base = '';
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push(path);
    req.resume();
    const name = decodeURIComponent(path.slice(1).split('/')[0]);
    const tarball = TARBALLS.get(name);
    if (tarball && path === `/${name}`) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name,
              version: '1.0.0',
              dist: { tarball: `${base}${name}/-/${name}-1.0.0.tgz`, integrity: tarball.integrity },
            },
          },
        }),
      );
      return;
    }
    if (tarball && path === `/${name}/-/${name}-1.0.0.tgz`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(tarball.data);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/`;
  return { server, url: base, requests };
}

/** A project with one production and one dev dependency from the registry. */
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lc-docker-npm-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'scratch',
      version: '1.0.0',
      dependencies: { 'prod-dep': '1.0.0' },
      devDependencies: { 'dev-dep': '1.0.0' },
    }),
  );
  writeFileSync(join(dir, '.npmrc-empty'), '');
  return dir;
}

/** Runs npm in `dir` against `registry` with no user or inherited npm config. */
function npm(
  dir: string,
  registry: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toLowerCase().startsWith('npm_config_')) {
      env[key] = value;
    }
  }
  env.npm_config_registry = registry;
  env.npm_config_userconfig = join(dir, '.npmrc-empty');
  env.npm_config_cache = join(dir, '.npm-cache');
  env.npm_config_update_notifier = 'false';
  env.npm_config_fetch_retries = '0';

  return new Promise((done, fail) => {
    const child = spawn('npm', args, { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', fail);
    child.on('close', (code) => done({ code: code ?? 1, out }));
  });
}

async function withScratch(run: (dir: string, registry: Registry) => Promise<void>): Promise<void> {
  const registry = await startRegistry();
  const dir = scratchProject();
  try {
    const install = await npm(dir, registry.url, ['install', '--no-audit', '--no-fund']);
    expect(install.code, install.out).toBe(0);
    registry.requests.length = 0;
    await run(dir, registry);
  } finally {
    registry.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const auditRequests = (registry: Registry) =>
  registry.requests.filter((path) => path.startsWith(AUDIT_PATH));

test.describe('Docker image npm steps', () => {
  test.beforeEach(() => inOneProject());

  test('no npm step in either image build sends an audit to the registry @scenario:docker-npm-steps-skip-audit', async () => {
    test.setTimeout(180_000);

    await withScratch(async (dir, registry) => {
      const control = await npm(dir, registry.url, ['prune', '--omit=dev']);
      expect(control.code, control.out).toBe(0);
      expect(auditRequests(registry), 'a plain prune audits, so the probe can see one').not.toEqual(
        [],
      );
    });

    for (const file of DOCKERFILES) {
      const commands = npmCommands(file);
      expect(commands, `${file} has npm steps`).not.toEqual([]);
      for (const args of commands) {
        await withScratch(async (dir, registry) => {
          const result = await npm(dir, registry.url, args);
          expect(result.code, `${file}: npm ${args.join(' ')}\n${result.out}`).toBe(0);
          expect(auditRequests(registry), `${file}: npm ${args.join(' ')}`).toEqual([]);
        });
      }
    }
  });

  test('the prune step still removes dev dependencies and keeps production ones @scenario:docker-prune-removes-dev-dependencies', async () => {
    test.setTimeout(120_000);
    const prune = npmCommands('Dockerfile').find((args) => args[0] === 'prune');
    expect(prune, 'Dockerfile prunes after the frontend build').toBeDefined();

    await withScratch(async (dir, registry) => {
      expect(existsSync(join(dir, 'node_modules/dev-dep'))).toBe(true);
      const result = await npm(dir, registry.url, prune as string[]);
      expect(result.code, result.out).toBe(0);
      expect(existsSync(join(dir, 'node_modules/dev-dep'))).toBe(false);
      expect(existsSync(join(dir, 'node_modules/prod-dep'))).toBe(true);
      expect(result.out).not.toMatch(/Use `--omit=dev` instead/);
    });
  });
});
