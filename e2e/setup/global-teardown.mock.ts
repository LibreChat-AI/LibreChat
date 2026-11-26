import type { FullConfig } from '@playwright/test';
import cleanupUser from './cleanupUser';
import { getPrimaryE2EUser, getSecondaryE2EUser } from './users.mock';

async function globalTeardown(config: FullConfig) {
  for (let index = 0; index < Math.max(config.workers, 1); index++) {
    for (const user of [getPrimaryE2EUser(index), getSecondaryE2EUser(index)]) {
      try {
        await cleanupUser(user);
      } catch (error) {
        console.error('Error:', error);
      }
    }
  }
}

export default globalTeardown;
