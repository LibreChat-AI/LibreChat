import { FullConfig } from '@playwright/test';
import { waitForReadiness } from './readiness';
import authenticate from './authenticate';
import { getE2EUser } from './user';

async function globalSetup(config: FullConfig) {
  await waitForReadiness(config);
  await authenticate(config, getE2EUser());
}

export default globalSetup;
