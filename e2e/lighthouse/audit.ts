import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { expect } from '@playwright/test';
import type Result from 'lighthouse/types/lhr/lhr';
import type { Cookie } from '@playwright/test';

const exec = promisify(execFile);

/** Median budgets keyed by Lighthouse audit id. */
export type MedianBudgets = Record<string, number>;

const REPORTS_DIRECTORY = '.lighthouse';

const DEFAULT_RUNS = 3;

/** Attempts per run before a crashed Lighthouse process fails the audit. */
const RUN_ATTEMPTS = 2;

const DEFAULT_BUDGETS: MedianBudgets = {
  'largest-contentful-paint': 4500,
  'cumulative-layout-shift': 0.1,
  'total-blocking-time': 500,
};

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

function medianOf(results: Result[], audit: string): number {
  const values = results
    .map((report) => report.audits[audit]?.numericValue)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  expect(values, `Lighthouse must report a numeric ${audit} for every run`).toHaveLength(
    results.length,
  );
  const middle = values.length >> 1;
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export async function auditPage({
  url,
  cookies,
  runs = DEFAULT_RUNS,
  budgets = DEFAULT_BUDGETS,
}: {
  url: string;
  cookies: Cookie[];
  runs?: number;
  budgets?: MedianBudgets;
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
  ];

  try {
    for (let run = 1; run <= runs; run++) {
      const output = path.join(directory, `lhr-${run}`);
      for (let attempt = 1; ; attempt++) {
        try {
          const { stdout } = await exec(process.execPath, [
            cli,
            ...flags,
            `--output-path=${output}`,
          ]);
          console.log(`Lighthouse run ${run}/${runs} wrote ${output}.report.json`);
          if (stdout.trim()) {
            console.log(stdout);
          }
          break;
        } catch (error) {
          if (attempt >= RUN_ATTEMPTS) {
            throw error;
          }
          /** Lighthouse crashes out of a run it could not trace — NO_NAVSTART is
           *  the usual one, and its own message is "run Lighthouse again". The
           *  page is measured `runs` times for exactly this noise, so one lost
           *  process should cost a repeat, not the lane. A page that is really
           *  broken fails every attempt and still fails here. */
          console.log(
            `Lighthouse run ${run}/${runs} attempt ${attempt} did not complete, retrying: ${
              error instanceof Error ? error.message.split('\n')[0] : String(error)
            }`,
          );
        }
      }
    }
  } finally {
    // Lighthouse embeds extraHeaders in reports; keep disposable session cookies out of artifacts.
    for (const file of fs.existsSync(directory) ? fs.readdirSync(directory) : []) {
      if (!/\.report\.(json|html)$/.test(file)) continue;
      const filename = path.join(directory, file);
      const content = fs.readFileSync(filename, 'utf8');
      fs.writeFileSync(filename, cookie ? content.replaceAll(cookie, '[redacted]') : content);
    }
  }

  const reports = fs.readdirSync(directory).filter((file) => /^lhr-.*\.report\.json$/.test(file));
  expect(reports.length, 'Lighthouse must produce one report per run').toBe(runs);
  const results = reports.map(
    (file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) as Result,
  );
  for (const report of results) {
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
  console.log(
    `Inspect ${REPORTS_DIRECTORY} HTML/JSON and e2e/lighthouse/README.md. Reuse loaded user/config data; overlap independent reads without bypassing authorization.`,
  );

  const measured = Object.entries(budgets).map(([audit, limit]) => ({
    audit,
    median: medianOf(results, audit),
    limit,
  }));
  console.table(measured);
  for (const { audit, median, limit } of measured) {
    expect(median, `Median ${audit} must stay within ${limit}`).toBeLessThanOrEqual(limit);
  }
  return results;
}
