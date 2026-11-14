import yaml from 'js-yaml';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

import type { MutationReport } from './merge.mts';

import { git, reportJobs } from './changes.mts';
import { assertMutants, mutantKey } from './shards.mts';
import { mutationSummary } from './merge.mts';

interface Step {
  if?: string;
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  'working-directory'?: string;
}
interface Job {
  env?: Record<string, string>;
  services?: Record<string, { image: string }>;
  'timeout-minutes'?: string | number;
  if?: string;
  permissions?: Record<string, string>;
  needs?: string[];
  concurrency?: { group: string; 'cancel-in-progress': boolean; queue?: string };
  outputs?: Record<string, string>;
  strategy?: { matrix: { include?: string; workspace?: string } };
  defaults?: { run: { 'working-directory': string } };
  steps: Step[];
}
interface Workflow {
  'run-name'?: string;
  on: {
    pull_request?: { paths: string[] };
    issue_comment?: { types: string[] };
    merge_group?: { types: string[] };
    workflow_dispatch: {
      inputs: {
        base: { default: string };
        scope: { default: string };
        static: { default: string };
      };
    };
  };
  permissions: Record<string, string>;
  env: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = yaml.load(
  readFileSync(new URL('../../.github/workflows/change-quality.yml', import.meta.url), 'utf8'),
) as Workflow;
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const checkouts = (job: Job) => job.steps.filter(({ uses }) => uses === 'actions/checkout@v5');
const report = workflow.jobs.reports;
const runner = report.steps.find(({ name }) => name === 'Generate advisory report')!;

// Only the workflow revision may supply tooling; the merge ref must never supply measured source.
test('workflow separates tooling, source, installs and artifacts without changing comparison refs', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.on.workflow_dispatch.inputs.base.default, 'origin/dev');
  assert.deepEqual(workflow.env, {
    QUALITY_BASE: "${{ github.event.pull_request.base.sha || inputs.base || 'origin/dev' }}",
    QUALITY_HEAD: '${{ github.event.pull_request.head.sha || github.sha }}',
  });
  for (const name of ['verify', 'select', 'mutation-summary']) {
    assert.equal(checkouts(workflow.jobs[name]).length, 1);
    assert.equal(checkouts(workflow.jobs[name])[0].with?.ref, '${{ github.sha }}');
  }
  assert.deepEqual(
    checkouts(report).map(({ with: options }) => options),
    [
      {
        ref: '${{ env.QUALITY_HEAD }}',
        path: 'source',
        'fetch-depth': 0,
        'persist-credentials': false,
      },
      { ref: '${{ github.sha }}', path: 'tooling', 'persist-credentials': false },
    ],
  );
  for (const job of Object.values(workflow.jobs)) {
    for (const step of checkouts(job)) assert.equal(step.with?.['persist-credentials'], false);
  }
  assert.equal(report.defaults?.run['working-directory'], 'source');
  const installs = report.steps.filter(({ run }) => run?.startsWith('npm ci'));
  assert.deepEqual(
    installs.map(({ run, 'working-directory': cwd }) => [run, cwd]),
    [
      ['npm ci', undefined],
      ['npm ci --ignore-scripts --workspaces=false', 'tooling'],
    ],
  );
  assert.equal(runner['working-directory'], undefined);
  assert.match(runner.run!, /node \.\.\/tooling\/scripts\/quality\/run\.mts/);
  assert.equal(report['timeout-minutes'], "${{ matrix.task.check == 'mutation' && 240 || 45 }}");
  assert.equal(workflow.on.workflow_dispatch.inputs.scope.default, 'all');
  assert.equal(workflow.on.workflow_dispatch.inputs.static.default, 'off');
  assert.match(report.env!.QUALITY_STATIC, /inputs\.static \|\| 'off'/);
  assert.match(runner.run!, /QUALITY_STATIC:-off/);
  assert.equal(
    workflow.jobs.select.steps.find(({ id }) => id === 'select')?.env?.QUALITY_SCOPE,
    "${{ needs.request.outputs.scope || inputs.scope || 'all' }}",
  );
  assert.deepEqual(report.strategy?.matrix, {
    include: '${{ fromJSON(needs.select.outputs.reports) }}',
  });
  assert.equal(workflow.jobs.select.outputs?.reports, '${{ steps.select.outputs.reports }}');
  assert.equal(
    workflow.jobs.select.outputs?.mutationWorkspaces,
    '${{ steps.select.outputs.mutationWorkspaces }}',
  );
  assert.equal(
    workflow.jobs.select.outputs?.hasMutations,
    '${{ steps.select.outputs.hasMutations }}',
  );
  assert.equal(
    workflow.jobs['mutation-summary'].if,
    "always() && needs.select.outputs.hasMutations == 'true'",
  );
  assert.deepEqual(workflow.jobs['mutation-summary'].strategy?.matrix, {
    workspace: '${{ fromJSON(needs.select.outputs.mutationWorkspaces) }}',
  });
  assert.equal(
    report.steps.find(({ name }) => name === 'Build shared packages')?.env?.QUALITY_WORKSPACE,
    '${{ matrix.workspace }}',
  );
  assert.equal(
    report.steps.find(({ uses }) => uses === 'actions/upload-artifact@v6')?.with?.path,
    "source/coverage/changes/${{ matrix.workspace }}/${{ matrix.task.check }}${{ matrix.task.check == 'mutation' && format('-{0}', matrix.task.shard) || '' }}/",
  );
});

test('PR updates retain PostgreSQL contracts without starting source quality reports', () => {
  const select = workflow.jobs.select;
  assert.equal(
    select.steps.find(({ id }) => id === 'select')?.if,
    "github.event_name != 'pull_request'",
  );
  const postgresSelection = select.steps.find(({ id }) => id === 'postgres')!;
  assert.equal(postgresSelection.if, "github.event_name != 'issue_comment'");
  assert.match(postgresSelection.run!, /git diff --name-only/);
  assert.ok(workflow.on.pull_request?.paths.includes('packages/data-schemas/src/postgres/**'));
  assert.ok(workflow.on.pull_request?.paths.includes('packages/api/src/app/persistence*'));
  const postgres = workflow.jobs.postgres;
  assert.equal(
    postgres.if,
    "always() && needs.select.result == 'success' && needs.select.outputs.postgresChanged == 'true'",
  );
  assert.deepEqual(postgres.needs, ['select']);
  assert.equal(checkouts(postgres)[0].with?.ref, '${{ env.QUALITY_HEAD }}');
  assert.equal(postgres.services?.postgres.image, 'postgres:16-alpine');
  assert.equal(report.services?.postgres.image, 'postgres:16-alpine');
  assert.ok(postgres.steps.some(({ run }) => run?.includes('npm run test:postgres')));
  assert.ok(postgres.steps.some(({ run }) => run?.includes('delete-user.recovery.spec.js')));
  assert.equal(report.env?.PG_TEST_URL, 'postgresql://postgres@127.0.0.1:5432/postgres');
  const prewarm = report.steps.findIndex(
    ({ uses }) => uses === './tooling/.github/actions/mongodb-binary',
  );
  assert.ok(prewarm > 0 && prewarm < report.steps.indexOf(runner));
  assert.equal(report.steps[prewarm].with?.['working-directory'], 'source');
});

test('comment commands from humans and bots reach trusted admission before report jobs', () => {
  const request = workflow.jobs.request;
  assert.equal(
    request.if,
    "github.event_name == 'issue_comment' && github.event.issue.pull_request && startsWith(github.event.comment.body, '/quality')",
  );
  assert.equal(checkouts(request)[0].with?.ref, '${{ github.sha }}');
  assert.ok(request.steps.some(({ run }) => run === 'node scripts/quality/comment.mts request'));
  for (const name of ['verify', 'select']) {
    assert.match(workflow.jobs[name].if!, /needs\.request\.outputs\.accepted == 'true'/);
  }
});

test('comment publication is trusted and serialized while PR execution stays read-only', (t) => {
  assert.ok(workflow.on.pull_request?.paths.includes('scripts/quality/**'));
  assert.equal(
    workflow.jobs.select.if,
    "always() && github.event_name != 'merge_group' && (github.event_name != 'issue_comment' || needs.request.outputs.accepted == 'true')",
  );
  assert.deepEqual(workflow.on.issue_comment?.types, ['created']);
  assert.equal(workflow.jobs.request.permissions?.issues, 'write');
  assert.match(workflow['run-name']!, /Quality PR #\{0\} request \{1\}/);
  for (const name of ['verify', 'select', 'reports', 'mutation-summary']) {
    assert.deepEqual(workflow.jobs[name].permissions ?? workflow.permissions, { contents: 'read' });
  }
  for (const name of ['reports', 'mutation-summary']) {
    const upload = workflow.jobs[name].steps.find(
      ({ uses }) => uses === 'actions/upload-artifact@v6',
    );
    assert.equal(upload?.with?.overwrite, true, 'reruns replace failed artifacts');
  }
  for (const name of ['request', 'progress']) {
    const job = workflow.jobs[name];
    assert.equal(checkouts(job)[0].with?.ref, '${{ github.sha }}');
    assert.ok(job.steps.every(({ run }) => !run?.includes('npm')));
    assert.equal(job.permissions?.['pull-requests'], 'write');
    assert.equal(job.permissions?.statuses, 'write');
    assert.equal(job.permissions?.actions, 'write');
    assert.equal(job.concurrency?.group, 'quality-decision-${{ github.event.issue.number }}');
    assert.equal(job.concurrency?.['cancel-in-progress'], false);
    assert.equal(job.concurrency?.queue, 'max');
  }
  const publisher = yaml.load(
    readFileSync(new URL('../../.github/workflows/quality-decision.yml', import.meta.url), 'utf8'),
  ) as Workflow;
  assert.equal(checkouts(publisher.jobs.publish)[0].with?.ref, '${{ github.workflow_sha }}');
  assert.equal(
    publisher.jobs.publish.concurrency?.group,
    'quality-decision-${{ needs.resolve.outputs.pr }}',
  );
  assert.equal(publisher.jobs.publish.concurrency?.['cancel-in-progress'], false);
  assert.equal(publisher.jobs.publish.concurrency?.queue, 'max');
  assert.equal(publisher.permissions.actions, 'write');
  assert.deepEqual(workflow.on.merge_group, { types: ['checks_requested'] });
  assert.equal(publisher.on.merge_group, undefined);
  const bridge = workflow.jobs['queue-request'];
  assert.equal(bridge.if, "github.event_name == 'merge_group'");
  assert.deepEqual(bridge.permissions ?? workflow.permissions, { contents: 'read' });
  assert.equal(checkouts(bridge).length, 0);
  assert.ok(bridge.steps.every(({ run, uses }) => !uses && run?.startsWith('echo ')));
  for (const name of ['verify', 'select'])
    assert.match(workflow.jobs[name].if!, /github.event_name != 'merge_group'/);
  const queue = publisher.jobs.queue;
  assert.deepEqual(queue.needs, ['resolve']);
  assert.equal(queue.if, "needs.resolve.outputs.queue != ''");
  assert.deepEqual(queue.permissions, {
    contents: 'read',
    'pull-requests': 'read',
    actions: 'read',
    statuses: 'write',
  });
  assert.equal(checkouts(queue)[0].with?.ref, '${{ github.workflow_sha }}');
  assert.equal(checkouts(queue)[0].with?.['persist-credentials'], false);
  assert.equal(queue.concurrency?.group, 'quality-queue-${{ github.event.workflow_run.head_sha }}');
  assert.ok(queue.steps.some(({ run }) => run === 'node scripts/quality/queue.mts'));
  assert.ok(
    queue.steps.every(
      ({ run, uses }) => !run?.includes('npm') && !uses?.startsWith('actions/download-artifact'),
    ),
  );
  assert.ok(
    publisher.jobs.publish.steps.every(
      ({ run, uses }) => !run?.includes('npm') && !uses?.startsWith('actions/download-artifact'),
    ),
  );
  const directory = mkdtempSync(join(tmpdir(), 'quality-event-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [event, expected] of [
    [{ pull_request: { number: 12 } }, 'pr=12\n'],
    [{ workflow_run: { event: 'merge_group', status: 'completed', id: 55 } }, 'queue=55\n'],
    [{ workflow_run: { event: 'merge_group', status: 'in_progress', id: 55 } }, ''],
    [
      { workflow_run: { event: 'issue_comment', display_title: 'Quality PR #13 request 99' } },
      'pr=13\n',
    ],
    [{ workflow_run: { event: 'pull_request', display_title: 'Quality PR #13 request 99' } }, ''],
    [
      {
        workflow_run: {
          event: 'issue_comment',
          display_title: 'Quality PR #13 request $(touch injected)',
        },
      },
      '',
    ],
  ] as const) {
    const path = join(directory, 'event.json');
    const output = join(directory, 'output');
    writeFileSync(path, JSON.stringify(event));
    writeFileSync(output, '');
    const result = spawnSync('bash', ['-e', '-c', publisher.jobs.resolve.steps[0].run!], {
      cwd: directory,
      env: { ...process.env, GITHUB_EVENT_PATH: path, GITHUB_OUTPUT: output },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), expected);
    assert.equal(existsSync(join(directory, 'injected')), false);
  }
});

for (const olderHead of [true, false]) {
  test(`real reports use exact head source and dependencies with ${olderHead ? 'absent' : 'edited'} head tooling`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'quality-workflow-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const upstream = join(directory, 'upstream');
    const write = (cwd: string, file: string, content: string) => {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), content);
    };
    const commit = () => {
      git(['add', '.'], upstream);
      git(['commit', '--no-gpg-sign', '-qm', 'fixture'], upstream);
      return git(['rev-parse', 'HEAD'], upstream).trim();
    };
    mkdirSync(upstream);
    git(['init', '-q', '-b', 'dev'], upstream);
    git(['config', 'user.name', 'Quality Test'], upstream);
    git(['config', 'user.email', 'quality@example.invalid'], upstream);
    write(upstream, 'package.json', '{"name":"quality-fixture","private":true}');
    write(upstream, 'package-lock.json', '{}');
    write(upstream, '.gitignore', 'node_modules/\ncoverage/\n.stryker-tmp/\n');
    const owners = [
      { name: 'data-schemas', path: 'packages/data-schemas', config: 'jest.config.mjs' },
      { name: 'api', path: 'packages/api', config: 'jest.config.mjs' },
      { name: 'server', path: 'api', config: 'jest.config.js' },
    ];
    const mode = olderHead ? 'on' : 'off';
    const sourceCode =
      'module.exports = (value) => value ? 1 : 0;\nmodule.exports.untouched = () => 3;\nmodule.exports.staticValue = (() => 1)();\nfunction hybrid(value) { if (value > 0) return 1; return 0; } module.exports.hybrid = hybrid; module.exports.loaded = hybrid(1);\n';
    for (const owner of owners) {
      write(upstream, `${owner.path}/src/feature.js`, sourceCode);
      write(
        upstream,
        `${owner.path}/${owner.config}`,
        `${owner.config.endsWith('.mjs') ? 'export default' : 'module.exports ='} { testEnvironment: "node" };`,
      );
      write(
        upstream,
        `${owner.path}/src/feature.test.js`,
        "const feature = require('./feature'); test('uses head dependency', () => { expect(feature(true)).toBe(require('head-only')); expect(feature(false)).toBe(0); expect(feature.untouched()).toBe(3); expect(feature.staticValue).toBe(2); expect(feature.hybrid(1)).toBe(2); expect(feature.hybrid(0)).toBe(0); expect(feature.loaded).toBe(2); });",
      );
    }
    const original = commit();
    mkdirSync(join(upstream, 'scripts'), { recursive: true });
    cpSync(join(root, 'scripts/quality'), join(upstream, 'scripts/quality'), { recursive: true });
    cpSync(join(root, 'scripts/crap.mts'), join(upstream, 'scripts/crap.mts'));
    const base = commit();
    git(['checkout', '-qb', 'pr', olderHead ? original : base], upstream);
    for (const owner of owners)
      write(
        upstream,
        `${owner.path}/src/feature.js`,
        sourceCode
          .replace('? 1', '? 2')
          .replaceAll('() => 1', '() => 2')
          .replace('return 1', 'return 2'),
      );
    if (!olderHead) {
      const selector = readFileSync(join(upstream, 'scripts/quality/changes.mts'), 'utf8');
      write(
        upstream,
        'scripts/quality/changes.mts',
        `${selector}\nconsole.log('PR tooling edit');\n`,
      );
    }
    const head = commit();
    git(['checkout', '-qb', 'merge', base], upstream);
    git(['merge', '--no-gpg-sign', '--no-ff', '-qm', 'merge fixture', head], upstream);
    const merge = git(['rev-parse', 'HEAD'], upstream).trim();
    assert.notEqual(merge, head);

    for (const [path, ref] of [
      ['source', head],
      ['tooling', merge],
    ]) {
      git(['clone', '-q', upstream, join(directory, path)], directory);
      git(['checkout', '-q', '--detach', ref], join(directory, path));
    }
    const source = join(directory, 'source');
    const tooling = join(directory, 'tooling');
    assert.equal(existsSync(join(source, 'scripts/quality/run.mts')), !olderHead);
    symlinkSync(join(root, 'node_modules'), join(tooling, 'node_modules'), 'junction');
    // A distinct head-owned Jest records both risk CLI and mutation module resolution.
    const marker = join(directory, 'head-jest.log');
    const record = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'head Jest\\n');`;
    write(
      source,
      'node_modules/jest/package.json',
      '{"name":"jest","main":"index.js","exports":{".":"./index.js","./bin/jest":"./bin/jest.js"}}',
    );
    write(
      source,
      'node_modules/jest/index.js',
      `${record} module.exports = require(${JSON.stringify(require.resolve('jest'))});`,
    );
    write(
      source,
      'node_modules/jest/bin/jest.js',
      `${record} require(${JSON.stringify(require.resolve('jest/bin/jest'))});`,
    );
    write(source, 'node_modules/head-only/index.js', 'module.exports = 2;');
    for (const dependency of [
      'jest-cli',
      'jest-config',
      'jest-environment-node',
      'istanbul-lib-coverage',
    ]) {
      symlinkSync(
        dirname(createRequire(require.resolve('jest')).resolve(`${dependency}/package.json`)),
        join(source, 'node_modules', dependency),
        'junction',
      );
    }
    git(['update-ref', 'refs/remotes/origin/dev', base], source);
    const env = {
      ...process.env,
      QUALITY_HEAD: head,
      QUALITY_WORKSPACE: 'data-schemas',
      QUALITY_STATIC: mode,
      GITHUB_OUTPUT: '',
      GITHUB_STEP_SUMMARY: '',
    };
    const run = (command: string, cwd: string, extra: Record<string, string>) => {
      const result = spawnSync('bash', ['-e', '-c', command], {
        cwd,
        env: { ...env, ...extra },
        encoding: 'utf8',
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      return result.stdout;
    };
    const select = workflow.jobs.select.steps.find(({ id }) => id === 'select');
    assert.ok(select?.run);
    for (const comparison of ['origin/dev', base]) {
      const output = run(select.run, tooling, {
        QUALITY_BASE: comparison,
        QUALITY_SCOPE: 'all',
      });
      assert.match(output, new RegExp(`"head": "${head}"`));
      assert.match(output, new RegExp(`"base": "${olderHead ? original : base}"`));
      assert.match(output, /"data-schemas"/);
      if (!olderHead) assert.match(output, /PR tooling edit/);
    }
    // Dispatch measures github.sha itself, with either the default ref or an explicit base SHA.
    for (const comparison of ['origin/dev', base]) {
      const output = run(select.run, tooling, {
        QUALITY_HEAD: merge,
        QUALITY_BASE: comparison,
        QUALITY_SCOPE: 'all',
      });
      assert.match(output, new RegExp(`"head": "${merge}"`));
      assert.match(output, new RegExp(`"base": "${base}"`));
    }
    for (const {
      workspace,
      task: { check, shard },
    } of reportJobs(owners.map(({ name }) => name))) {
      const file = `${owners.find(({ name }) => name === workspace)!.path}/src/feature.js`;
      rmSync(marker, { force: true });
      run(runner.run!, source, {
        QUALITY_BASE: check === 'risk' ? 'origin/dev' : base,
        QUALITY_WORKSPACE: workspace,
        QUALITY_CHECK: check,
        QUALITY_SHARD: String(shard),
      });
      const output = join(
        source,
        `coverage/changes/${workspace}`,
        shard ? `mutation-${shard}` : check,
      );
      const selection = JSON.parse(readFileSync(join(output, 'selection.json'), 'utf8'));
      assert.equal(selection.head, head);
      assert.equal(selection.base, olderHead ? original : base);
      assert.deepEqual(
        selection.files.map((item: { file: string }) => item.file),
        [file],
      );
      if (check === 'risk') {
        assert.match(readFileSync(marker, 'utf8'), /head Jest/);
        const risk = JSON.parse(readFileSync(join(output, 'risk.json'), 'utf8'));
        assert.equal(risk.functions.length, 3, 'unchanged sibling must not be scored');
        assert.equal(risk.functions[0].file, file);
        assert.equal(risk.functions[0].statementCoverage, 1);
        assert.equal(risk.head, head);
      } else {
        const completion = JSON.parse(readFileSync(join(output, 'completion.json'), 'utf8'));
        assert.equal(completion.complete, true);
        assert.equal(completion.index, shard);
        if (completion.total) {
          assert.match(readFileSync(marker, 'utf8'), /head Jest/);
          const progress = JSON.parse(readFileSync(join(output, 'progress.json'), 'utf8'));
          assert.equal(progress.complete, true);
          assert.equal(progress.staticMutants, mode === 'on');
          assert.equal(progress.completed, completion.total);
        }
        cpSync(
          output,
          join(tooling, `coverage/shards/change-mutation-data-schemas-${head}-shard-${shard}`),
          { recursive: true },
        );
      }
      assert.equal(git(['rev-parse', 'HEAD'], source).trim(), head);
      assert.equal(git(['diff', 'HEAD', '--', file], source), '');
    }
    const combine = workflow.jobs['mutation-summary'].steps.find(
      ({ name }) => name === 'Verify and combine mutation results',
    )!;
    run(combine.run!, tooling, {});
    const combined = JSON.parse(
      readFileSync(join(tooling, 'coverage/changes/data-schemas/mutation/mutation.json'), 'utf8'),
    );
    const mutants: MutationReport['files'][string]['mutants'] =
      combined.files['packages/data-schemas/src/feature.js'].mutants;
    console.log(
      JSON.stringify({
        fixture: 'exact-head sharded Stryker',
        static: mode,
        planned: mutants.length,
        ignored: mutants.filter(({ status }) => status === 'Ignored').length,
        tested: mutants.filter(({ status }) =>
          ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(status),
        ).length,
      }),
    );
    assert.ok(mutants.length > 0);
    assert.equal(
      mutants.some((mutant: { status: string }) => mutant.status === 'Ignored'),
      mode === 'off',
    );
    assert.ok(
      mutants.some(
        (mutant) =>
          mutant.static && mutant.location.start.line === 4 && mutant.status !== 'Ignored',
      ),
      `hybrid mutants remain tested: ${JSON.stringify(mutants)}`,
    );
    run(
      'node ../tooling/scripts/quality/run.mts --base "$QUALITY_BASE" --head "$QUALITY_HEAD" --workspace data-schemas --check mutation --static "$QUALITY_STATIC"',
      source,
      { QUALITY_BASE: base },
    );
    const unsharded = JSON.parse(
      readFileSync(join(source, 'coverage/changes/data-schemas/mutation/mutation.json'), 'utf8'),
    );
    const keys = (report: MutationReport) =>
      Object.entries(report.files).flatMap(([file, value]) =>
        value.mutants.map((mutant) =>
          mutantKey(file, { ...mutant, replacement: mutant.replacement! }),
        ),
      );
    assertMutants(keys(unsharded), keys(combined));
    assert.equal(
      mutationSummary(unsharded, 'data-schemas', mode === 'on'),
      mutationSummary(combined, 'data-schemas', mode === 'on'),
    );

    assert.match(
      readFileSync(join(tooling, 'coverage/changes/data-schemas/mutation/summary.md'), 'utf8'),
      /All four shards completed/,
    );
  });
}
