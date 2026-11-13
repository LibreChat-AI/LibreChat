import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { seedConversations, seedMessages } from '../specs/mock/db';
import { getE2EUser } from '../setup/user';
import { discardLighthouseTraces } from './artifacts.mts';
import { auditPage, lcpElement } from './audit';

const conversationId = '16390000-0000-4000-8000-000000000001';
const title = 'Lighthouse latency audit';
const transcriptMarker = 'Serial database latency transcript';

/** Capture a separate navigation after a failure; profiling never changes the measured audits. */
async function captureStartupProfile(page: Page, url: string) {
  const profiler = await page.context().newCDPSession(page);
  let started = false;
  try {
    await profiler.send('Network.enable');
    await profiler.send('Network.setCacheDisabled', { cacheDisabled: true });
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.start');
    started = true;
    await page.goto(url);
    await expect(
      page.locator('.message-render').filter({ hasText: transcriptMarker }),
    ).toBeVisible();
    // Optional catalog responses can arrive after the transcript. Keep a bounded
    // post-ready sample so their callbacks are included in this diagnostic only.
    await page.waitForTimeout(3_000);
  } finally {
    try {
      if (started) {
        const { profile } = await profiler.send('Profiler.stop');
        await fs.mkdir('.lighthouse', { recursive: true });
        await fs.writeFile('.lighthouse/startup.cpuprofile', JSON.stringify(profile));
      }
    } finally {
      await profiler.detach();
    }
  }
}

test('serial database latency stays within web-vitals budgets', async ({ page, baseURL }) => {
  const email = getE2EUser().email;
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(email, conversationId, [
    {
      messageId: '16390000-0000-4000-8000-000000000002',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Explain why independent database reads should start together.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: '16390000-0000-4000-8000-000000000003',
      parentMessageId: '16390000-0000-4000-8000-000000000002',
      text: `${transcriptMarker}. Independent reads can overlap. Serial reads each add another database round trip and delay the visible conversation. Reuse loaded user data and preserve authorization checks when starting reads in parallel.`,
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  const url = `${baseURL}/c/${conversationId}`;
  await page.goto(url);
  await expect(page.locator('.message-render').filter({ hasText: transcriptMarker })).toBeVisible();
  const cookies = await page.context().cookies();
  let reports: Awaited<ReturnType<typeof auditPage>>;
  try {
    reports = await auditPage({ url, cookies });
  } catch (error) {
    try {
      await captureStartupProfile(page, url);
    } catch {
      console.warn('Startup CPU profile unavailable; retaining the original Lighthouse failure.');
    }
    throw error;
  }
  expect(reports, 'Lighthouse must produce all three reports').toHaveLength(3);
  for (const report of reports) {
    expect(report.finalDisplayedUrl, 'Do not measure a login redirect').toBe(url);
    expect(
      lcpElement(report),
      'The measured LCP must be the seeded transcript, not the shell or a spinner',
    ).toContain(transcriptMarker);
  }
  discardLighthouseTraces('.lighthouse');
});
