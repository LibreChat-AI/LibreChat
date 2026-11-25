import type { FullConfig } from '@playwright/test';
import authenticate, { authenticateWorker } from './authenticate';
import { waitForReadiness } from './readiness';
import { getE2EUser } from './user';

/**
 * Signs in one account per worker the run can start (`--workers`, or the config's `workers`),
 * so concurrent workers never share a user's conversations, settings or cleanup. Worker 0's
 * account registers first, which makes it the deployment's admin, exactly as with one worker.
 */
async function globalSetup(config: FullConfig) {
  await waitForReadiness(config);
  await authenticate(config, getE2EUser(0));
  for (let index = 1; index < config.workers; index++) {
    await authenticateWorker(config, index);
  }
}

export default globalSetup;
