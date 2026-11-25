import type { User } from '../types';
import { forWorker, getE2EUser } from './user';

const DEFAULT_SECONDARY_USER: User = {
  email: 'testuser-b@example.com',
  name: 'Test User B',
  password: 'securepassword456',
};

export function getPrimaryE2EUser(index?: number): User {
  return getE2EUser(index);
}

export function getSecondaryE2EUser(index?: number): User {
  return forWorker(
    {
      email: process.env.E2E_USER_B_EMAIL ?? DEFAULT_SECONDARY_USER.email,
      name: process.env.E2E_USER_B_NAME ?? DEFAULT_SECONDARY_USER.name,
      password: process.env.E2E_USER_B_PASSWORD ?? DEFAULT_SECONDARY_USER.password,
    },
    index,
  );
}
