// env-fixture.test.mjs — unit tests for the empty-value fixture guard in the pre-bring-up pipeline.
//
// The guard this file covers exists because of a specific failure the harness already paid for. Two
// keys in env/common.env.example were spelled `KEY=` with the intent of "leave it unset, let the
// application default apply". Docker's env_file does not read it that way: `KEY=` becomes an empty
// STRING in the container's environment. packages/api/src/mcp/mcpConfig.ts reads those two keys as
// `math(process.env.KEY ?? <default>)`, `??` falls back on null/undefined only, so the empty string
// reached math() with no fallbackValue, math()'s /^[+\-\d.\s*\/%()]+$/ validator is `+`-quantified
// and does not match '', and math() threw AT MODULE LOAD — before any route mounted. The harness saw
// a container that never became healthy and reported `SETUP FAILURE [bringup-timeout]` 300 seconds
// later, with `Error: Invalid characters in string` buried in a log tail.
//
// So the guard is a fixture-correctness check, not a general env validator: it scans the resolved env
// files for exactly the keys whose consumer throws on '' and refuses the run before bring-up, naming
// the file and the key. These tests are the same shape as the other pre-bring-up guards' tests
// (run-sequence.test.mjs) — a pure classifier over already-captured input, no spawning, no Docker,
// no filesystem.
//
// Native-ESM Jest under e2e/container-split/jest.config.mjs (its `**/*.test.mjs` pattern). No test
// here carries a `[CHECK-ID]` tag, because the guard is harness machinery rather than a Check Catalog
// entry — the reporter ignores an untagged test rather than inventing a record for it.
//
// NG1/NG2 hold: this reads the harness's own generated fixtures and touches no application code and
// neither container-split script.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ENV_EXAMPLE_FILES,
  MATH_PARSED_ENV_KEYS,
  SETUP_FAILURE_KINDS,
  SetupFailure,
  assertNoEmptyMathParsedValues,
  findEmptyMathParsedKeys,
} from './run.mjs';

// This file's own directory, resolved from `import.meta.url`. The Layer B config loads .mjs as native
// ES modules, so `import.meta` is valid here under Jest exactly as it is under `node`; `__dirname`
// does not exist under native ESM and is deliberately not used.
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Run a thrower and return the error it threw (or null if it did not throw), so a test asserts on the
// error OUTSIDE any catch block — jest/no-conditional-expect forbids an `expect` inside a catch.
function caught(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe('the guarded key list', () => {
  test('names the two keys that killed a boot, and only keys the application parses with math()', () => {
    // The two that produced the bring-up timeout. Their presence is the regression test.
    expect(MATH_PARSED_ENV_KEYS).toContain('MCP_OAUTH_HANDLING_TIMEOUT');
    expect(MATH_PARSED_ENV_KEYS).toContain('MCP_OAUTH_FLOW_TTL');
    // Every guarded key is an MCP_ key, because every `math(process.env.KEY ?? …)` call site with no
    // fallbackValue lives in packages/api/src/mcp/mcpConfig.ts. If that stops being true the list is
    // stale, which is the point of asserting the shape rather than just the count.
    for (const key of MATH_PARSED_ENV_KEYS) {
      expect(key.startsWith('MCP_')).toBe(true);
    }
  });

  test('carries no key whose consumer treats an empty value as falsy', () => {
    // DISABLE_STARTUP_TASKS= is deliberately empty in collapsed.env — isEnabled('') is false, which
    // IS the collapse lever env-matrix.md names. Guarding it would break the collapsed profile.
    expect(MATH_PARSED_ENV_KEYS).not.toContain('DISABLE_STARTUP_TASKS');
    // The OPENID_ROLE_SYNC_* string readers spell `?.trim() || <default>`, so '' is benign there too.
    expect(MATH_PARSED_ENV_KEYS).not.toContain('OPENID_ROLE_SYNC_SOURCE');
    expect(MATH_PARSED_ENV_KEYS).not.toContain('OPENID_ROLE_SYNC_CLAIM');
  });
});

describe('findEmptyMathParsedKeys — the scanner', () => {
  test('flags a guarded key assigned an empty value', () => {
    expect(findEmptyMathParsedKeys('MCP_OAUTH_FLOW_TTL=')).toEqual(['MCP_OAUTH_FLOW_TTL']);
  });

  test('flags a whitespace-only value too — math() rejects a bare space for the same reason', () => {
    expect(findEmptyMathParsedKeys('MCP_OAUTH_HANDLING_TIMEOUT=   ')).toEqual([
      'MCP_OAUTH_HANDLING_TIMEOUT',
    ]);
  });

  test('accepts a guarded key with a real value', () => {
    expect(findEmptyMathParsedKeys('MCP_OAUTH_FLOW_TTL=900000')).toEqual([]);
    // math() evaluates an expression, which is the documented spelling in .env.example files.
    expect(findEmptyMathParsedKeys('MCP_OAUTH_FLOW_TTL=15 * 60 * 1000')).toEqual([]);
  });

  test('ignores an absent key — unset is the correct end state', () => {
    expect(findEmptyMathParsedKeys('CREDS_KEY=abc\nJWT_SECRET=def\n')).toEqual([]);
  });

  test('ignores a commented-out assignment, which sets nothing', () => {
    // The templates explain the absent keys in prose; a comment mentioning `MCP_OAUTH_FLOW_TTL=`
    // must not read as an assignment, or the fix for the defect would trip the guard.
    expect(findEmptyMathParsedKeys('# MCP_OAUTH_FLOW_TTL=\n#   MCP_OAUTH_FLOW_TTL=')).toEqual([]);
  });

  test('ignores an unguarded key set empty', () => {
    expect(findEmptyMathParsedKeys('DISABLE_STARTUP_TASKS=\nOPENID_ROLE_SYNC_CLAIM=')).toEqual([]);
  });

  test('reports every offender in a file, in order', () => {
    const text = [
      'CREDS_KEY=abcd',
      'MCP_OAUTH_HANDLING_TIMEOUT=',
      'ALLOW_SHARED_LINKS_PUBLIC=false',
      'MCP_OAUTH_FLOW_TTL=',
    ].join('\n');
    expect(findEmptyMathParsedKeys(text)).toEqual([
      'MCP_OAUTH_HANDLING_TIMEOUT',
      'MCP_OAUTH_FLOW_TTL',
    ]);
  });

  test('honors an injected key list, so the guarded set is a parameter and not a hard-coded set', () => {
    expect(findEmptyMathParsedKeys('SOME_TIMEOUT=', ['SOME_TIMEOUT'])).toEqual(['SOME_TIMEOUT']);
    expect(findEmptyMathParsedKeys('SOME_TIMEOUT=', [])).toEqual([]);
  });
});

describe('assertNoEmptyMathParsedValues — the setup guard', () => {
  test('passes a clean fixture set through unchanged', () => {
    const files = [
      { file: '/env/common.env', text: 'CREDS_KEY=abcd\nJWT_SECRET=efgh\n' },
      { file: '/env/collapsed.env', text: 'DISABLE_STARTUP_TASKS=\nSEARCH=true\n' },
    ];
    expect(assertNoEmptyMathParsedValues(files)).toBe(files);
  });

  test('throws an ENV_EMPTY_MATH_VALUE SetupFailure naming the file, the key and why it is fatal', () => {
    const error = caught(() =>
      assertNoEmptyMathParsedValues([
        { file: '/harness/env/common.env', text: 'MCP_OAUTH_FLOW_TTL=\n' },
      ]),
    );
    expect(error).toBeInstanceOf(SetupFailure);
    expect(error.kind).toBe(SETUP_FAILURE_KINDS.ENV_EMPTY_MATH_VALUE);
    // The file and the key, so the fix is a named line rather than a search.
    expect(error.message).toContain('common.env');
    expect(error.message).toContain('MCP_OAUTH_FLOW_TTL');
    // Why it is fatal rather than untidy: the empty string reaches math(), which throws at load.
    expect(error.message).toContain('math()');
    expect(error.message).toContain('module load');
    // And the correct fix: remove the key, do not substitute a value.
    expect(error.message).toContain('do not substitute a value');
    expect(error.detail).toContain('/harness/env/common.env');
  });

  test('names every offending file and key in one failure, so two defects are fixed in one pass', () => {
    const error = caught(() =>
      assertNoEmptyMathParsedValues([
        { file: '/env/common.env', text: 'MCP_OAUTH_FLOW_TTL=\nMCP_OAUTH_HANDLING_TIMEOUT=\n' },
        { file: '/env/api-container.env', text: 'MCP_CB_MAX_CYCLES=\n' },
      ]),
    );
    expect(error.message).toContain('3 key(s)');
    expect(error.message).toContain('common.env: MCP_OAUTH_FLOW_TTL=');
    expect(error.message).toContain('common.env: MCP_OAUTH_HANDLING_TIMEOUT=');
    expect(error.message).toContain('api-container.env: MCP_CB_MAX_CYCLES=');
  });

  test('is a setup failure, so it is never reported as a falsified property (Property 9)', () => {
    const error = caught(() =>
      assertNoEmptyMathParsedValues([{ file: '/env/common.env', text: 'MCP_OAUTH_FLOW_TTL=\n' }]),
    );
    expect(error.isSetupFailure).toBe(true);
    expect(error.service).toBe('env-fixture');
  });
});

describe('the committed templates', () => {
  // The resolved env/*.env files are gitignored and exist only after a run, so the committed
  // *.env.example templates are what a fresh checkout can assert over. They are also where the defect
  // originated: the resolved files are copies of these, so a template that is clean cannot resolve to
  // a fixture that is not. This is the guard against the same two keys coming back.
  test.each([...ENV_EXAMPLE_FILES])('%s.example sets no guarded key to an empty value', (file) => {
    const text = readFileSync(path.join(HERE, 'env', `${file}.example`), 'utf8');
    expect(findEmptyMathParsedKeys(text)).toEqual([]);
  });
});
