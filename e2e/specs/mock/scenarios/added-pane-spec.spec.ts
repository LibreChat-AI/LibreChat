import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';
import { inOneProject, repoRoot } from './lint.helpers';

/**
 * A second conversation pane on a model spec runs with that spec's preset, as the main pane does:
 * the spec's private prompt reaches the pane's own model, and the main pane does not receive it.
 *
 * Clients receive specs without their private fields, so a pane on a spec sends only the spec's
 * name. The model selector lists no spec with a private prompt in this harness, so the added pane
 * is moved onto the hidden `e2e-handoff-specialist` spec in flight, in exactly that shape.
 */
const SPEC = 'e2e-handoff-specialist';
const PROBE = 'E2E_ASSERT_PROJECT_CONTEXT: specialist';
const PASSED = 'E2E project context assertion passed: specialist';
const FAILED = 'E2E project context assertion failed: expected specialist';

test.describe('added pane model spec', () => {
  test("a second pane on a model spec answers with that spec's prompt @scenario:added-pane-answers-with-its-own-spec-prompt", async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 768, 'the multi-conversation control is hidden below md');
    test.setTimeout(90_000);

    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await page.getByTestId('add-multi-convo-button').click();
    await page.route(
      (url) => url.pathname.startsWith('/api/agents/chat/'),
      async (route) => {
        const request = route.request();
        const body = request.method() === 'POST' ? request.postDataJSON() : null;
        if (body?.addedConvo == null) {
          return route.continue();
        }
        return route.continue({
          postData: JSON.stringify({ ...body, addedConvo: { ...body.addedConvo, spec: SPEC } }),
        });
      },
    );

    const run = await sendMessage(page, PROBE);
    expect(run.ok()).toBeTruthy();

    await expect(messagesView(page).getByText(PASSED, { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(messagesView(page).getByText(FAILED)).toHaveCount(1);
  });
});

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPECS = [
  'src/agents/__tests__/added.spec.ts',
  'src/protection/adapters/chat.spec.ts',
  'src/middleware/openid.spec.ts',
];
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');

let report: JestAssertion[] | undefined;

/**
 * Runs the server specs once per worker and keeps every verdict they report. The rules below
 * depend on process-wide settings (`modelSpecs.enforce`, content filters, an OpenID session) the
 * shared harness cannot vary per test. The run is bounded on its own, since a synchronous child
 * blocks the test timeout, and a nonzero exit fails the scenario even when every assertion passed.
 */
function serverResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [...SPECS, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'packages/api'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
  });
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`jest did not pass (${result.error?.message ?? result.status}):\n${output}`);
  }
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`jest printed no JSON report:\n${output}`);
  }
  const parsed = JSON.parse(stdout.slice(start)) as JestReport;
  report = parsed.testResults.flatMap((file) => file.assertionResults);
  return report;
}

const expectPassed = (fullName: string) => {
  const assertion = serverResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no server spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

const LOADER = 'loadAddedAgent model spec preset';

test.describe('added pane model spec rules on the server', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(180_000);
  });

  test('a second pane keeps the model settings it was sent with @scenario:added-pane-keeps-its-own-model-settings', () => {
    expectPassed(
      `${LOADER} keeps the provider settings the pane carries beside an ephemeral primary`,
    );
    expectPassed(
      `${LOADER} keeps the provider settings the pane carries beside a saved primary agent`,
    );
    expectPassed(`${LOADER} keeps the pane's own prompt over its spec's without enforcement`);
    expectPassed(`${LOADER} parses a pane stored without its endpoint type as its custom endpoint`);
    expectPassed(`${LOADER} parses a custom endpoint with the parameters of its provider`);
  });

  test('enforced model specs govern the second pane as they govern the main one @scenario:enforced-specs-govern-the-added-pane', () => {
    expectPassed(`${LOADER} lets an enforced spec's preset replace what the pane sends`);
    expectPassed(`${LOADER} refuses a spec for another endpoint`);
    expectPassed(`${LOADER} refuses a spec for another endpoint when enforced`);
    expectPassed(`${LOADER} refuses no spec when enforced`);
    expectPassed(`${LOADER} refuses an unknown spec when enforced`);
    expectPassed(
      `${LOADER} under enforcement, loads an agent pane naming the agent its spec presets`,
    );
    expectPassed(
      `${LOADER} under enforcement, loads an agent pane naming another agent than its spec presets`,
    );
    expectPassed(`${LOADER} under enforcement, loads an agent pane naming no spec`);
  });

  test("content filters inspect the second pane's own settings @scenario:content-filters-inspect-the-added-pane-settings", () => {
    expectPassed(
      "extractChatContent extracts the added conversation's own provider-bound settings",
    );
    expectPassed(
      "extractChatContent blocks a filtered value in the added conversation's stop sequences",
    );
  });

  test("the OpenID refresh before a turn covers the second pane's model @scenario:openid-refresh-covers-the-added-pane-model", () => {
    expectPassed(`${LOADER} predicts the model it runs when specs are enforced`);
    expectPassed(
      'createOpenIDTokenRefresh refreshes for the model an enforced spec gives the added conversation',
    );
  });
});
