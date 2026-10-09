import { FullConfig } from '@playwright/test';
import authenticate from './authenticate';
import { getE2EUser } from './user';

async function globalSetup(config: FullConfig) {
  await authenticate(config, getE2EUser());
}

export default globalSetup;
