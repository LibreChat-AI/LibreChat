import assert from 'node:assert/strict';

/** Playwright exits successfully when every test is skipped. The dedicated CI lane must not. */
export function assertMCPAppsPhaseResults(report, phase, minimumPassed) {
  assert.ok(
    Array.isArray(report?.suites) && Array.isArray(report.errors),
    `MCP Apps ${phase}: missing Playwright JSON results`,
  );
  assert.equal(report.errors.length, 0, `MCP Apps ${phase}: Playwright reported errors`);

  const collect = (suites) =>
    (suites ?? []).reduce(
      (passed, suite) =>
        passed +
        (suite.specs ?? []).reduce(
          (count, spec) =>
            count +
            (spec.tests ?? []).filter(
              (test) =>
                test.expectedStatus === 'passed' &&
                test.results?.some((result) => result.status === 'passed'),
            ).length,
          0,
        ) +
        collect(suite.suites),
      0,
    );

  const passed = collect(report.suites);
  assert.ok(
    passed >= minimumPassed,
    `MCP Apps ${phase}: expected at least ${minimumPassed} executed passing tests, got ${passed}`,
  );
  return passed;
}
