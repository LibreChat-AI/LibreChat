import yaml from 'js-yaml';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { condition } from './expressions.mjs';
import {
  loadManifest,
  MANIFEST_PATH,
  parseManifest,
  readsRepository,
  SPEC_FILE,
  withGuards,
} from './guard-specs.mjs';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const manifest = loadManifest();

const WORKFLOWS = ['backend-review.yml', 'frontend-review.yml'];
const workflows = new Map(
  WORKFLOWS.map((file) => {
    const workflow = yaml.load(readFileSync(join(repoRoot, '.github/workflows', file), 'utf8'));
    const selector = workflow.jobs.codegraph_select.steps.find((step) => step.id === 'sel');
    return [file, { workflow, selector }];
  }),
);

/** `emit <key> <workspace> [ignore]` is how a selector names each workspace it gates. */
const gated = new Map(
  WORKFLOWS.flatMap((file) =>
    Array.from(
      workflows.get(file).selector.run.matchAll(/^\s*emit \w+ (\S+)(?: (?:'[^']*'|""))?$/gm),
      ([, workspace]) => [workspace, { file }],
    ),
  ),
);

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo']);

function specsUnder(directory) {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : specsUnder(path);
    return SPEC_FILE.test(entry.name) ? [path] : [];
  });
}

const workspaceOf = (spec) =>
  [...gated.keys()].find((workspace) => spec.startsWith(`${workspace}/`));

/** GitHub's path filter, for the shapes these triggers use: exact paths and `dir/**`. */
const triggers = (pattern, path) =>
  pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path;

test('both selectors gate the workspaces this test walks', () => {
  assert.deepEqual(
    [...gated].map(([workspace, { file }]) => [workspace, file]),
    [
      ['api', 'backend-review.yml'],
      ['packages/api', 'backend-review.yml'],
      ['packages/data-provider', 'backend-review.yml'],
      ['packages/data-schemas', 'backend-review.yml'],
      ['client', 'frontend-review.yml'],
      ['packages/client', 'frontend-review.yml'],
    ],
  );
});

test('only a pull request synchronize is narrowed; every other event runs each workspace FULL', () => {
  const event = (event_name, action) => ({ github: { event_name, event: { action } }, vars: {} });
  const unselected = { build: { result: 'success' }, codegraph_select: { outputs: {} } };
  for (const [file, { workflow }] of workflows) {
    const selects = (context) => condition(workflow.jobs.codegraph_select.if, context);
    assert.equal(selects(event('pull_request', 'synchronize')), true, file);
    for (const context of [
      event('pull_request', 'opened'),
      event('pull_request', 'reopened'),
      event('push'),
      event('workflow_dispatch'),
      event('merge_group', 'checks_requested'),
    ]) {
      assert.equal(selects(context), false, `${file} ${context.github.event_name}`);
    }
    const gatedJobs = Object.values(workflow.jobs).filter((job) =>
      [job.needs].flat().includes('codegraph_select'),
    );
    assert.ok(gatedJobs.length > 0, file);
    for (const job of gatedJobs) {
      assert.equal(
        condition(job.if, { needs: unselected }, { cancelled: () => false }),
        true,
        `${file} ${job.name}`,
      );
    }
  }
});

test('every spec that reads the repository through fs is listed as a guard or exempt', () => {
  const listed = new Set([...Object.keys(manifest.guards), ...Object.keys(manifest.exempt)]);
  const unlisted = [...gated.keys()]
    .flatMap(specsUnder)
    .filter((spec) => !listed.has(spec))
    .filter((spec) => readsRepository(readFileSync(join(repoRoot, spec), 'utf8')));
  assert.deepEqual(
    unlisted,
    [],
    `These specs read files with fs from a path anchored in the repository, so codegraph test ` +
      `selection cannot tell when a change affects them. Add each to "guards" in ` +
      `${MANIFEST_PATH} with the repository paths it reads, or to "exempt" with the reason it ` +
      `reads no tracked file.`,
  );
});

test('every listed spec exists, sits in a gated workspace and reads paths that exist', () => {
  for (const spec of [...Object.keys(manifest.guards), ...Object.keys(manifest.exempt)]) {
    assert.ok(existsSync(join(repoRoot, spec)), `${spec} is listed but does not exist`);
    assert.ok(workspaceOf(spec), `${spec} is not in a workspace that test selection gates`);
  }
  for (const [spec, scans] of Object.entries(manifest.guards)) {
    for (const scan of scans) {
      const target = join(repoRoot, scan);
      assert.ok(existsSync(target), `${spec} lists ${scan}, which does not exist`);
      assert.equal(
        statSync(target).isDirectory(),
        scan.endsWith('/'),
        `${spec} lists ${scan}: a directory ends with a slash and a file does not`,
      );
    }
  }
});

test('a workflow runs whenever a path one of its guard specs reads changes', () => {
  for (const [spec, scans] of Object.entries(manifest.guards)) {
    const { file } = gated.get(workspaceOf(spec));
    const { workflow } = workflows.get(file);
    for (const event of ['pull_request', 'push']) {
      const patterns = workflow.on[event].paths.filter((pattern) => !pattern.startsWith('!'));
      for (const scan of scans) {
        assert.ok(
          patterns.some((pattern) => triggers(pattern, scan)),
          `${spec} reads ${scan}, but ${file} does not run on ${event} when it changes; ` +
            `add it to that trigger's paths`,
        );
      }
    }
  }
});

test('the detector flags repository reads and ignores temp-only and import-only specs', () => {
  assert.ok(readsRepository("fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8')"));
  assert.ok(readsRepository('for (const e of readdirSync(join(process.cwd(), "src"))) {}'));
  assert.ok(readsRepository('await readFile(new URL("./a.css", import.meta.url))'));
  assert.ok(readsRepository("globSync('src/**/*.ts', { cwd: __dirname })"));
  assert.ok(!readsRepository("fs.readFileSync(path.join(os.tmpdir(), 'out.txt'))"));
  assert.ok(!readsRepository("const { run } = require(path.join(__dirname, 'run.js'))"));
  assert.ok(!readsRepository("jest.mock('fs'); expect(reader.readFile).toBeDefined()"));
});

test('a manifest is refused when a path could split, glob or leave the repository', () => {
  const guards = (entries) => JSON.stringify({ guards: entries });
  assert.throws(() => parseManifest('{}'));
  assert.throws(() => parseManifest(guards({ 'api/a b.spec.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ 'api/*.spec.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ 'api/$(id).spec.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ 'api/../a.spec.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ '/api/a.spec.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ 'api/a.js': ['api/'] })));
  assert.throws(() => parseManifest(guards({ 'api/a.spec.js': [] })));
  assert.throws(() => parseManifest(guards({ 'api/a.spec.js': ['api/ server/'] })));
  assert.throws(() => parseManifest(guards({ 'api/a.spec.js': 'api/' })));
  assert.throws(() =>
    parseManifest(
      JSON.stringify({ guards: { 'api/a.spec.js': ['api/'] }, exempt: { 'api/a.spec.js': 'x' } }),
    ),
  );
  assert.throws(() =>
    parseManifest(JSON.stringify({ guards: {}, exempt: { 'api/a.spec.js': '' } })),
  );
  assert.deepEqual(parseManifest(guards({ 'api/a.spec.js': ['api/', 'b.json'] })).guards, {
    'api/a.spec.js': ['api/', 'b.json'],
  });
});

const FIXTURE = {
  guards: {
    'api/server/guard.spec.js': ['api/server/', 'packages/api/src/'],
    'packages/api/src/guard.spec.ts': ['packages/api/src/'],
    'packages/api/src/scan.integration.spec.ts': ['packages/api/src/'],
    'packages/data-schemas/src/guard.spec.ts': ['api/'],
    'client/src/guard.spec.ts': ['client/index.html', 'packages/chat/src/'],
    'packages/client/src/guard.spec.tsx': ['packages/client/src/theme/'],
  },
};

test('a rename, or a change to the list or its reader, counts for every guard', () => {
  const run = (changed) =>
    withGuards({
      manifest: FIXTURE,
      mode: 'NONE',
      workspace: 'packages/client',
      changed,
      exists: () => true,
    });
  assert.deepEqual(run([{ path: 'docs/a.txt', status: 'modified' }]), []);
  assert.deepEqual(run([{ path: 'docs/b.txt', status: 'renamed' }]), ['src/guard.spec.tsx']);
  assert.deepEqual(run([{ path: MANIFEST_PATH, status: 'modified' }]), ['src/guard.spec.tsx']);
  assert.deepEqual(run([{ path: '.github/scripts/guard-specs.mjs' }]), ['src/guard.spec.tsx']);
  assert.deepEqual(run([{ path: 'packages/client/src/guard.spec.tsx' }]), ['src/guard.spec.tsx']);
  assert.deepEqual(run([{ path: 'packages/client/src/theme/a.css' }]), ['src/guard.spec.tsx']);
  assert.deepEqual(run([{ path: 'packages/client/src/themes.ts' }]), []);
  assert.throws(() => run([{ filename: 'a' }]));
  assert.throws(() => run({}));
});

test('a selection keeps its guards only while one of its files is in the checkout', () => {
  const selected = ['src/gone.spec.tsx', 'src/kept.spec.tsx'];
  const run = (exists) =>
    withGuards({
      manifest: FIXTURE,
      mode: 'FILES',
      workspace: 'packages/client',
      changed: [],
      selected,
      exists,
    });
  assert.deepEqual(
    run((file) => file === 'src/kept.spec.tsx'),
    [...selected, 'src/guard.spec.tsx'],
  );
  assert.deepEqual(
    run(() => false),
    selected,
  );
  assert.throws(() => run(undefined));
});

const mode = (value, files) => ({ mode: value, ...(files ? { files } : {}) });
const NONE = mode('NONE');
const FULL = mode('FULL');

/**
 * Runs a workflow's real select step against a canned codegraph response. `gh` and `curl` are
 * stubs on PATH; the guard spec reader is the real script beside a fixture list. Every selected
 * file exists in the scratch checkout unless `stale` says the selection outlived its files.
 */
function select(t, file, { selected, changed, list = FIXTURE, env = {}, stale = false }) {
  const { selector } = workflows.get(file);
  const scratch = mkdtempSync(join(scriptsDir, '.guard-specs-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const write = (name, content, options) => {
    mkdirSync(dirname(join(scratch, name)), { recursive: true });
    writeFileSync(join(scratch, name), content, options);
  };
  write('response.json', JSON.stringify({ selected }));
  write('changed.ndjson', changed.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  write('output', '');
  write('selector.sh', selector.run);
  write('gh', '#!/usr/bin/env bash\ncat changed.ndjson\nexit "${GH_EXIT:-0}"\n', { mode: 0o700 });
  write('curl', '#!/usr/bin/env bash\ncat response.json\nexit "${CURL_EXIT:-0}"\n', {
    mode: 0o700,
  });
  if (list !== null) {
    write(MANIFEST_PATH, typeof list === 'string' ? list : JSON.stringify(list));
  }
  if (!stale) {
    Object.values(selected)
      .flatMap((decision) => decision.files ?? [])
      .forEach((path) => write(path, ''));
  }
  mkdirSync(join(scratch, '.github/scripts'), { recursive: true });
  copyFileSync(
    join(scriptsDir, 'guard-specs.mjs'),
    join(scratch, '.github/scripts/guard-specs.mjs'),
  );
  const result = spawnSync('bash', ['selector.sh'], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: `${scratch}:${process.env.PATH}`,
      URL: 'https://selector.invalid',
      TOKEN: 'test-fixture',
      REPO: 'fixture/repo',
      PR: '1',
      BASE_SHA: 'base',
      HEAD_SHA: 'head',
      CHANGED: String(changed.length),
      GITHUB_OUTPUT: join(scratch, 'output'),
      GITHUB_STEP_SUMMARY: join(scratch, 'summary'),
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return Object.fromEntries(
    readFileSync(join(scratch, 'output'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

const modified = (...paths) => paths.map((path) => ({ path, status: 'modified' }));

test('backend: a narrowed workspace runs its guards with the selection (the #17864 shape)', (t) => {
  const outputs = select(t, 'backend-review.yml', {
    changed: modified('packages/api/src/agents/tools.ts'),
    selected: {
      api: mode('FILES', ['api/server/services/ToolService.spec.js']),
      'packages/api': mode('FILES', [
        'packages/api/src/agents/tools.spec.ts',
        'packages/api/src/guard.spec.ts',
      ]),
      'packages/data-provider': NONE,
      'packages/data-schemas': NONE,
    },
  });
  assert.deepEqual(outputs, {
    api_run: 'true',
    api_files: 'server/services/ToolService.spec.js server/guard.spec.js',
    pkgapi_run: 'true',
    pkgapi_files: 'src/agents/tools.spec.ts src/guard.spec.ts',
    dataprovider_run: 'false',
    dataschemas_run: 'false',
    decided: 'true',
  });
});

test('backend: a skipped workspace runs its guards alone when the change touches what they read', (t) => {
  const outputs = select(t, 'backend-review.yml', {
    changed: modified('api/server/routes/new.js'),
    selected: {
      api: NONE,
      'packages/api': NONE,
      'packages/data-provider': NONE,
      'packages/data-schemas': NONE,
    },
  });
  assert.deepEqual(outputs, {
    api_run: 'true',
    api_files: 'server/guard.spec.js',
    pkgapi_run: 'false',
    dataprovider_run: 'false',
    dataschemas_run: 'true',
    dataschemas_files: 'src/guard.spec.ts',
    decided: 'true',
  });
});

test('backend: a skip stands when nothing a guard reads changed, and FULL is left alone', (t) => {
  const skipped = select(t, 'backend-review.yml', {
    changed: modified('packages/client/src/components/Button.tsx'),
    selected: {
      api: NONE,
      'packages/api': NONE,
      'packages/data-provider': NONE,
      'packages/data-schemas': NONE,
    },
  });
  assert.deepEqual(skipped, {
    api_run: 'false',
    pkgapi_run: 'false',
    dataprovider_run: 'false',
    dataschemas_run: 'false',
    decided: 'true',
  });
  const full = select(t, 'backend-review.yml', {
    changed: modified('package-lock.json'),
    selected: {
      api: FULL,
      'packages/api': FULL,
      'packages/data-provider': FULL,
      'packages/data-schemas': FULL,
    },
  });
  assert.deepEqual(full, {
    api_run: 'true',
    pkgapi_run: 'true',
    dataprovider_run: 'true',
    dataschemas_run: 'true',
    decided: 'true',
  });
});

test('backend: guards obey the exclusions of the workspace jest run', (t) => {
  const selected = {
    api: NONE,
    'packages/api': mode('FILES', ['packages/api/src/agents/run.integration.spec.ts']),
    'packages/data-provider': NONE,
    'packages/data-schemas': NONE,
  };
  const touched = select(t, 'backend-review.yml', {
    changed: modified('packages/api/src/agents/run.ts'),
    selected,
  });
  assert.equal(touched.pkgapi_run, 'true');
  assert.equal(touched.pkgapi_files, 'src/guard.spec.ts');
  const untouched = select(t, 'backend-review.yml', {
    changed: modified('packages/api/package.json'),
    selected,
  });
  assert.equal(untouched.pkgapi_run, 'false');
  assert.equal(untouched.pkgapi_files, undefined);
});

test('a selection whose files are all gone gets no guards, so the test job still runs FULL', (t) => {
  const backend = select(t, 'backend-review.yml', {
    changed: modified('api/server/routes/old.js'),
    selected: {
      api: mode('FILES', ['api/server/routes/old.spec.js']),
      'packages/api': FULL,
      'packages/data-provider': FULL,
      'packages/data-schemas': FULL,
    },
    stale: true,
  });
  assert.equal(backend.api_files, 'server/routes/old.spec.js');
  const frontend = select(t, 'frontend-review.yml', {
    changed: modified('client/src/old.ts'),
    selected: { client: mode('FILES', ['client/src/old.spec.ts']), 'packages/client': FULL },
    stale: true,
  });
  assert.equal(frontend.client_files, 'src/old.spec.ts');
});

test('backend: a guard list that cannot be read runs the narrowed workspaces FULL', (t) => {
  const request = {
    changed: modified('api/server/routes/new.js'),
    selected: {
      api: mode('FILES', ['api/server/routes/new.spec.js']),
      'packages/api': NONE,
      'packages/data-provider': FULL,
      'packages/data-schemas': NONE,
    },
  };
  const unsafe = { guards: { 'api/server/a b.spec.js': ['api/'] } };
  for (const list of [null, '{', '{"guards": []}', unsafe]) {
    const outputs = select(t, 'backend-review.yml', { ...request, list });
    assert.deepEqual(outputs, {
      api_run: 'true',
      pkgapi_run: 'true',
      dataprovider_run: 'true',
      dataschemas_run: 'true',
      decided: 'true',
    });
  }
});

test('backend: malformed decisions and an unavailable service still fail open', (t) => {
  const changed = modified('api/server/routes/new.js');
  const rest = {
    'packages/api': FULL,
    'packages/data-provider': FULL,
    'packages/data-schemas': FULL,
  };
  for (const api of [
    mode('FILES', []),
    mode('FILES'),
    mode('FILES', ['packages/api/src/misplaced.spec.ts']),
    mode('FILES', ['api/server/has space.spec.js']),
    mode('SOMETHING_NEW'),
  ]) {
    const outputs = select(t, 'backend-review.yml', { changed, selected: { api, ...rest } });
    assert.equal(outputs.api_run, 'true');
    assert.equal(outputs.api_files, undefined);
  }
  const selected = { api: NONE, ...rest };
  for (const env of [
    { URL: '' },
    { TOKEN: '' },
    { CURL_EXIT: '28' },
    { GH_EXIT: '1' },
    { CHANGED: '2' },
  ]) {
    assert.deepEqual(select(t, 'backend-review.yml', { changed, selected, env }), {});
  }
  assert.deepEqual(select(t, 'backend-review.yml', { changed, selected: {} }), {});
});

test('frontend: guards join a narrowed run and promote a skip the change makes relevant', (t) => {
  const narrowed = select(t, 'frontend-review.yml', {
    changed: modified('client/src/components/Chat/Header.tsx'),
    selected: {
      client: mode('FILES', ['client/src/components/Chat/Header.spec.tsx']),
      'packages/client': NONE,
    },
  });
  assert.deepEqual(narrowed, {
    client_run: 'true',
    client_files: 'src/components/Chat/Header.spec.tsx src/guard.spec.ts',
    clientpkg_run: 'false',
    decided: 'true',
  });
  const promoted = select(t, 'frontend-review.yml', {
    changed: modified('packages/chat/src/components/composer/Bar.tsx'),
    selected: { client: NONE, 'packages/client': NONE },
  });
  assert.deepEqual(promoted, {
    client_run: 'true',
    client_files: 'src/guard.spec.ts',
    clientpkg_run: 'false',
    decided: 'true',
  });
});

test('frontend: an unreadable guard list, malformed decisions and outages fail open', (t) => {
  const changed = modified('client/src/a.ts');
  const unreadable = select(t, 'frontend-review.yml', {
    changed,
    selected: { client: mode('FILES', ['client/src/a.spec.ts']), 'packages/client': NONE },
    list: null,
  });
  assert.deepEqual(unreadable, { client_run: 'true', clientpkg_run: 'true', decided: 'true' });
  const malformed = select(t, 'frontend-review.yml', {
    changed,
    selected: { client: mode('FILES', []), 'packages/client': FULL },
  });
  assert.deepEqual(malformed, { client_run: 'true', clientpkg_run: 'true', decided: 'true' });
  const outage = select(t, 'frontend-review.yml', {
    changed,
    selected: { client: NONE, 'packages/client': NONE },
    env: { CURL_EXIT: '28' },
  });
  assert.deepEqual(outage, {});
});
