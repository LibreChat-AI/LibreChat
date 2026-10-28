import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const workflow = yaml.load(
  readFileSync(new URL('../../.github/workflows/playwright-mock.yml', import.meta.url), 'utf8'),
);

// Check the shared eligibility predicate on both the fixture and the required E2E gate.
// Otherwise a bot-authored PR silently reports the browser lane as skipped.
test('canary bot branches can run the required Apps fixture without admitting external forks', () => {
  for (const job of ['e2e_shards', 'mcp_tool_list_changed', 'mcp_apps', 'e2e']) {
    const expression = workflow.jobs[job].if;
    assert.match(expression, /github\.event_name == 'pull_request'/);
    assert.match(expression, /github\.event\.pull_request != null/);
    assert.match(
      expression,
      /\(contains\(fromJSON\('\["OWNER", "MEMBER", "COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\) \|\|\s*github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)/,
      `${job} must require either a trusted association or a same-repository head`,
    );
  }
  assert.ok(workflow.jobs.e2e.needs.includes('mcp_apps'));
  assert.match(
    workflow.jobs.e2e.steps.find((step) => step.name === 'Verify every Playwright job passed').if,
    /needs\.mcp_apps\.result != 'success'/,
  );
});
