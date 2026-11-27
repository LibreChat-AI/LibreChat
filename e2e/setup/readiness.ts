import { expect, request } from '@playwright/test';
import type { FullConfig } from '@playwright/test';

/** The same budget the profiles give the server to start listening. */
const READINESS_TIMEOUT_MS = 120_000;

/**
 * Holds the run until the app reports ready. Playwright starts the suite once the base URL
 * answers, which the server does as soon as it listens; it then finishes initializing (MCP
 * servers, migrations, the trigger and schedule engines) and refuses chat starts and schedule
 * writes with a 503 until `/readyz` turns 200. The two-replica wrapper already waits for that
 * before exposing its proxy, and this gives the single-process server the same ordering.
 */
export async function waitForReadiness(config: FullConfig): Promise<void> {
  const { baseURL } = config.projects[0].use;
  if (typeof baseURL !== 'string') {
    throw new Error('🤖: baseURL is not defined');
  }
  const readyz = new URL('/readyz', baseURL).toString();
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    await expect
      .poll(
        () =>
          api.get(readyz, { timeout: 5_000 }).then(
            (response) => response.status(),
            () => 0,
          ),
        {
          message: `${readyz} must report ready before the first spec runs`,
          timeout: READINESS_TIMEOUT_MS,
          intervals: [100, 250, 500],
        },
      )
      .toBe(200);
  } finally {
    await api.dispose();
  }
}
