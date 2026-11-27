import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const script = join(scriptsDir, 'retarget-prs.sh');

function runRetarget(t, prs, overrides = {}) {
  const scratch = mkdtempSync(join(scriptsDir, '.retarget-prs-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const callsPath = join(scratch, 'calls');
  const fakeGh = join(scratch, 'gh');
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_PATH"
case "$1:$2" in
  api:*/pulls/*) cat "$FIXTURE_DIR/\${2##*/}.json" ;;
  api:*/comments) printf '%s\\n' '[]' ;;
  'pr:edit') exit 0 ;;
  'pr:comment') cat >/dev/null ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  for (const [number, { base, head = 'topic' }] of Object.entries(prs)) {
    writeFileSync(
      join(scratch, `${number}.json`),
      JSON.stringify({
        state: 'open',
        base: { ref: base },
        head: { ref: head, repo: { full_name: 'contributor/fork' } },
        labels: [],
      }),
    );
  }
  const result = spawnSync('bash', [script, ...Object.keys(prs)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${scratch}:${process.env.PATH}`,
      FIXTURE_DIR: scratch,
      CALLS_PATH: callsPath,
      REPO: 'LibreChat-AI/LibreChat',
      RELEASE_BASE: 'main',
      TARGET_BASE: 'dev',
      DRY_RUN: 'false',
      EXPLAIN_MISSING: 'false',
      ...overrides,
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return {
    output: result.stdout,
    calls: readFileSync(callsPath, 'utf8').trim().split('\n'),
  };
}

function writes(calls) {
  return calls.filter((call) => call.startsWith('pr edit ') || call.startsWith('pr comment '));
}

test('a numbered manual sweep leaves canary alone while main still retargets to dev', (t) => {
  const { output, calls } = runRetarget(t, {
    101: { base: 'canary' },
    102: { base: 'main' },
  });
  assert.match(output, /#101: skipped/);
  assert.deepEqual(writes(calls), [
    'pr edit 102 --repo LibreChat-AI/LibreChat --base dev',
    'pr comment 102 --repo LibreChat-AI/LibreChat --body-file -',
  ]);
});

test('canary stays protected even if a caller misconfigures the release base', (t) => {
  const { output, calls } = runRetarget(t, { 103: { base: 'canary' } }, { RELEASE_BASE: 'canary' });
  assert.match(output, /#103: skipped/);
  assert.deepEqual(writes(calls), []);
});

test('explanation recovery never posts a dev-target message on a canary PR', (t) => {
  const { output, calls } = runRetarget(
    t,
    { 104: { base: 'canary' } },
    { TARGET_BASE: 'canary', EXPLAIN_MISSING: 'true' },
  );
  assert.match(output, /#104: skipped/);
  assert.deepEqual(writes(calls), []);
});

test('a dry run cannot propose retargeting canary', (t) => {
  const { output, calls } = runRetarget(
    t,
    { 105: { base: 'canary' } },
    { RELEASE_BASE: 'canary', DRY_RUN: 'true' },
  );
  assert.match(output, /would_retarget=0 skipped=1/);
  assert.deepEqual(writes(calls), []);
});
