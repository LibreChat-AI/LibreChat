import type { User } from '../types';

const DEFAULT_EMAIL_CHANGE_USER: User = {
  email: 'email-change-user@example.com',
  name: 'Email Change User',
  password: 'securepassword789',
};

const DEFAULT_NEW_EMAIL = 'email-change-user-updated@example.com';

export function getEmailChangeUser(): User {
  return {
    email: process.env.E2E_EMAIL_CHANGE_USER_EMAIL ?? DEFAULT_EMAIL_CHANGE_USER.email,
    name: process.env.E2E_EMAIL_CHANGE_USER_NAME ?? DEFAULT_EMAIL_CHANGE_USER.name,
    password: process.env.E2E_EMAIL_CHANGE_USER_PASSWORD ?? DEFAULT_EMAIL_CHANGE_USER.password,
  };
}

export function getEmailChangeTarget(): string {
  return process.env.E2E_EMAIL_CHANGE_TARGET ?? DEFAULT_NEW_EMAIL;
}
