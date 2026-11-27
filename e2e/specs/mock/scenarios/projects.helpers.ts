import { randomUUID } from 'crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import type { User } from '../../../types';
import cleanupUser from '../../../setup/cleanupUser';
import { withMongo } from '../db';

/** Members, roles and cleanup shared by the Chat Projects permission scenarios. The primary
 *  account is the deployment's admin and manages the roles; each test signs in a member. */

export type Member = { user: User; id: string; context: BrowserContext; page: Page };
export type Headers = Record<string, string>;

export const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${randomUUID().slice(0, 6)}`;

export async function login(request: APIRequestContext, user: User): Promise<Headers> {
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  return { Authorization: `Bearer ${token}` };
}

export async function signInMember(browser: Browser, baseURL: string): Promise<Member> {
  const user: User = {
    name: 'Projects Permission Member',
    email: `projects-perm-${randomUUID().slice(0, 8)}@example.com`,
    password: `Pw-${randomUUID()}`,
  };
  const context = await browser.newContext({ storageState: undefined, baseURL });
  const registered = await context.request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registered.ok()).toBeTruthy();
  const page = await context.newPage();
  await page.goto('/login', { timeout: 10000 });
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
  await page.waitForURL(/\/c\/new/, { timeout: 10000 });
  const record = await withMongo((db) => db.collection('users').findOne({ email: user.email }));
  if (!record) {
    throw new Error(`E2E seed: member "${user.email}" not found`);
  }
  return { user, id: record._id.toString(), context, page };
}

/** Creates a role holding `permissions` and moves the member into it. */
export async function assignRole(
  request: APIRequestContext,
  admin: Headers,
  member: Member,
  permissions: Record<string, Record<string, boolean>>,
): Promise<string> {
  const name = uniqueName('projects-role');
  const created = await request.post('/api/admin/roles', {
    headers: admin,
    data: { name, permissions },
  });
  expect(created.status()).toBe(201);
  const added = await request.post(`/api/admin/roles/${encodeURIComponent(name)}/members`, {
    headers: admin,
    data: { userId: member.id },
  });
  expect(added.ok()).toBeTruthy();
  return name;
}

export async function cleanup(
  request: APIRequestContext,
  admin: Headers | undefined,
  member: Member | undefined,
  roles: string[],
) {
  if (member) {
    await member.context.close();
    await cleanupUser(member.user);
  }
  if (admin) {
    await Promise.allSettled(
      roles.map((name) =>
        request.delete(`/api/admin/roles/${encodeURIComponent(name)}`, { headers: admin }),
      ),
    );
  }
  await request.dispose();
}
