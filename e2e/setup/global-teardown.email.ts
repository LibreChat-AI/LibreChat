import cleanupUser from './cleanupUser';
import { getEmailChangeTarget, getEmailChangeUser } from './users.email';

async function globalTeardown() {
  const user = getEmailChangeUser();
  for (const email of [getEmailChangeTarget(), user.email]) {
    try {
      await cleanupUser({ email, password: user.password });
    } catch (error) {
      console.error('Error:', error);
    }
  }
}

export default globalTeardown;
