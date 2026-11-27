import path from 'path';
import type { User } from '../types';

const DEFAULT_USER: User = {
  email: 'testuser@example.com',
  name: 'Test User',
  password: 'securepassword123',
};

/**
 * The Playwright worker this process runs tests for, from `0` to `workers - 1`. Two workers
 * running at once never share an index, and a worker that replaces a crashed one takes its
 * index. Outside a worker (global setup and teardown, `--list`) this is worker 0.
 */
export function workerIndex(): number {
  const index = Number(process.env.TEST_PARALLEL_INDEX);
  return Number.isInteger(index) && index > 0 ? index : 0;
}

/**
 * The copy of `user` that belongs to worker `index`, so concurrent workers never sign in as,
 * seed for or clean up the same account. Worker 0 keeps the account unchanged, so a run with one
 * worker uses exactly the accounts it always has.
 */
export function forWorker(user: User, index: number = workerIndex()): User {
  if (index === 0) {
    return user;
  }
  const at = user.email.lastIndexOf('@');
  return {
    email: `${user.email.slice(0, at)}-w${index}${user.email.slice(at)}`,
    name: `${user.name} W${index}`,
    password: user.password,
  };
}

/** The signed-in account of the worker this runs in; see `workerIndex`. */
export function getE2EUser(index?: number): User {
  return forWorker(
    {
      email: process.env.E2E_USER_EMAIL ?? DEFAULT_USER.email,
      name: process.env.E2E_USER_NAME ?? DEFAULT_USER.name,
      password: process.env.E2E_USER_PASSWORD ?? DEFAULT_USER.password,
    },
    index,
  );
}

/** Where worker `index`'s signed-in browser state is saved; worker 0 keeps the original path. */
export function storageStatePath(index: number = workerIndex()): string {
  return index === 0
    ? path.resolve(process.cwd(), 'e2e/storageState.json')
    : path.resolve(process.cwd(), `e2e/.generated/storageState.w${index}.json`);
}
