import cleanupUser from './cleanupUser';
import { getPrimaryE2EUser, getSecondaryE2EUser } from './users.mock';

async function globalTeardown() {
  for (const user of [getPrimaryE2EUser(), getSecondaryE2EUser()]) {
    try {
      await cleanupUser(user);
    } catch (error) {
      console.error('Error:', error);
    }
  }
}

export default globalTeardown;
