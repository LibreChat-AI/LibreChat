import type { User } from '../types';

const DEFAULT_USER: User = {
  email: 'testuser@example.com',
  name: 'Test User',
  password: 'securepassword123',
};

export function getE2EUser(): User {
  return {
    email: process.env.E2E_USER_EMAIL ?? DEFAULT_USER.email,
    name: process.env.E2E_USER_NAME ?? DEFAULT_USER.name,
    password: process.env.E2E_USER_PASSWORD ?? DEFAULT_USER.password,
  };
}
