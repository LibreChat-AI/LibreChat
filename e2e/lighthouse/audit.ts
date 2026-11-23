import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import type Result from 'lighthouse/types/lhr/lhr';
import type { Cookie } from '@playwright/test';

import type { Measurement } from './measure.mts';
import type { Budgets } from './budgets.mts';
import { measure, referenceBlockingTime } from './measure.mts';
import { sanitizeLighthouseArtifacts } from './artifacts.mts';
import { runLighthouse } from './process.mts';
import { BUDGETS } from './budgets.mts';

const REPORTS_DIRECTORY = '.lighthouse';

const DEFAULT_RUNS = 3;

/**
 * An over-budget batch is measured once more before it fails. A regression is over budget in
 * every run; a busy stretch on a shared runner is not, and must not fail the gate alone.
 */
const BATCHES = 2;

/**
 * Lighthouse 13 removed `largest-contentful-paint-element` and moved the LCP node into the
 * breakdown insight. Scenarios read the element through here so a future rename fails once,
 * loudly, instead of silently passing an assertion against an absent audit.
 */
export function lcpElement(report: Result): string {
  const details = report.audits['lcp-breakdown-insight']?.details;
  if (!details) {
    throw new Error('Lighthouse reported no LCP element; check the `lcp-breakdown-insight` audit.');
  }
  return JSON.stringify(details);
}

function readReports(directory: string): Result[] {
  return fs
    .readdirSync(directory)
    .filter((file) => /^lhr-.*\.report\.json$/.test(file))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Result);
}

function describeRuns(reports: Result[]): void {
  for (const report of reports) {
    console.log(
      `${report.finalDisplayedUrl}: LCP ${report.audits['largest-contentful-paint'].displayValue}`,
    );
    const requests = report.audits['network-requests'].details;
    if (requests?.type === 'table') {
      console.table(
        requests.items
          .filter((item) => typeof item.url === 'string' && item.url.includes('/api/'))
          .map((item) => ({
            url: item.url,
            startMs: item.networkRequestTime,
            endMs: item.networkEndTime,
            status: item.statusCode,
          })),
      );
    }
    expect(report.runtimeError, 'Lighthouse navigation must succeed').toBeUndefined();
  }
}

export async function auditPage({
  url,
  cookies,
  runs = DEFAULT_RUNS,
  budgets = BUDGETS,
}: {
  url: string;
  cookies: Cookie[];
  runs?: number;
  budgets?: Budgets;
}): Promise<Result[]> {
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join('; ');
  const directory = path.resolve(REPORTS_DIRECTORY);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });

  const cli = require.resolve('lighthouse/cli/index.js');
  const chromeFlags = `--headless=new ${process.env.LIGHTHOUSE_CHROME_FLAGS ?? ''}`.trim();
  const flags = [
    url,
    '--quiet',
    '--preset=desktop',
    '--throttling-method=provided',
    '--only-categories=performance',
    `--chrome-flags=${chromeFlags}`,
    `--extra-headers=${JSON.stringify({ Cookie: cookie })}`,
    '--output=json',
    '--output=html',
    '--save-assets',
  ];

  let results: Result[] = [];
  let measured: Measurement[] = [];
  for (let batch = 1; batch <= BATCHES; batch++) {
    const total = runs * batch;
    try {
      for (let run = results.length + 1; run <= total; run++) {
        const output = path.join(directory, `lhr-${run}`);
        await runLighthouse({ cli, flags, output, run, runs: total });
      }
    } finally {
      sanitizeLighthouseArtifacts(directory, cookies);
    }
    const reports = readReports(directory);
    expect(reports.length, 'Lighthouse must produce one report per run').toBe(total);
    describeRuns(reports.slice(results.length));
    results = reports;
    measured = measure(results, budgets);
    if (batch === BATCHES || measured.every(({ value, limit }) => value <= limit)) break;
    console.log(`Over budget after ${total} runs; measuring ${runs} more before failing.`);
  }
  console.log(
    `Inspect ${REPORTS_DIRECTORY} HTML/JSON and e2e/lighthouse/README.md. Reuse loaded user/config data; overlap independent reads without bypassing authorization.`,
  );

  // A low benchmarkIndex is a slow or busy runner: read the measured times against it.
  console.log(`Runner: ${os.availableParallelism()} logical CPUs`);
  console.table(
    results.map((report, index) => ({
      run: index + 1,
      benchmarkIndex: Math.round(report.environment.benchmarkIndex),
      'largest-contentful-paint': Math.round(
        report.audits['largest-contentful-paint'].numericValue ?? NaN,
      ),
      'total-blocking-time': Math.round(report.audits['total-blocking-time'].numericValue ?? NaN),
      'at reference CPU': Math.round(referenceBlockingTime(report)),
    })),
  );
  console.table(measured);
  for (const { audit, statistic, value, limit } of measured) {
    expect(value, `${audit} (${statistic}) must stay within ${limit}`).toBeLessThanOrEqual(limit);
  }
  return results;
}
