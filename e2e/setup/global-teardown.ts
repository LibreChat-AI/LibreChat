import cleanupUser from './cleanupUser';
import { getE2EUser } from './user';

async function globalTeardown() {
  try {
    await cleanupUser(getE2EUser());
  } catch (error) {
    console.error('Error:', error);
  }
}

export default globalTeardown;
