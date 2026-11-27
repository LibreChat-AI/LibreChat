import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import type { User } from '../../../types';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessageAndWaitForCompletion } from '../helpers';
import cleanupUser from '../../../setup/cleanupUser';
import { withMongo } from '../db';

/**
 * Chat Projects follow the role's PROJECTS permissions on the server. A role without USE is
 * refused by every project route and its chats run outside their project; a role without CREATE
 * keeps its projects but cannot add one; a role stored before the permission existed keeps both.
 * The primary account is the deployment's admin and manages the roles; each test signs in a
 * member of its own.
 */

type Member = { user: User; id: string; context: BrowserContext; page: Page };
type Headers = Record<string, string>;

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${randomUUID().slice(0, 6)}`;

async function login(request: APIRequestContext, user: User): Promise<Headers> {
  const res = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(res.ok()).toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  return { Authorization: `Bearer ${token}` };
}

async function signInMember(browser: Browser, baseURL: string): Promise<Member> {
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
async function assignRole(
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

async function cleanup(
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

test.describe('Chat Projects role permissions', () => {
  test('a role without PROJECTS.USE is refused by every project route @scenario:projects-use-refused-by-routes', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roles: string[] = [];
    let admin: Headers | undefined;
    let member: Member | undefined;
    try {
      admin = await login(request, getPrimaryE2EUser());
      member = await signInMember(browser, baseURL ?? '');
      const before = await login(request, member.user);
      const project = await request.post('/api/projects', {
        headers: before,
        data: { name: uniqueName('Refused') },
      });
      expect(project.status()).toBe(201);
      const { _id: projectId } = (await project.json()) as { _id: string };

      roles.push(
        await assignRole(request, admin, member, {
          PROJECTS: { USE: false, CREATE: true },
        }),
      );
      const headers = await login(request, member.user);
      const id = encodeURIComponent(projectId);
      const attempts = [
        request.get('/api/projects', { headers }),
        request.post('/api/projects', { headers, data: { name: uniqueName('Again') } }),
        request.get(`/api/projects/${id}`, { headers }),
        request.patch(`/api/projects/${id}`, { headers, data: { instructions: 'x' } }),
        request.get(`/api/projects/${id}/files`, { headers }),
        request.delete(`/api/projects/${id}`, { headers }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status()).toBe(403);
      }
      const stored = await withMongo((db) =>
        db.collection('chatprojects').countDocuments({ user: member?.id }),
      );
      expect(stored).toBe(1);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });

  test('a role without PROJECTS.CREATE keeps its projects but cannot add one @scenario:projects-create-refused', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roles: string[] = [];
    let admin: Headers | undefined;
    let member: Member | undefined;
    try {
      admin = await login(request, getPrimaryE2EUser());
      member = await signInMember(browser, baseURL ?? '');
      roles.push(
        await assignRole(request, admin, member, {
          PROJECTS: { USE: true, CREATE: false },
        }),
      );
      const headers = await login(request, member.user);

      const list = await request.get('/api/projects', { headers });
      expect(list.status()).toBe(200);
      const created = await request.post('/api/projects', {
        headers,
        data: { name: uniqueName('Not Allowed') },
      });
      expect(created.status()).toBe(403);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });

  test('a role stored before the PROJECTS permission existed keeps projects @scenario:projects-legacy-role-keeps-projects', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const roles: string[] = [];
    let admin: Headers | undefined;
    let member: Member | undefined;
    try {
      admin = await login(request, getPrimaryE2EUser());
      member = await signInMember(browser, baseURL ?? '');
      const name = await assignRole(request, admin, member, { BOOKMARKS: { USE: true } });
      roles.push(name);
      const stored = await withMongo((db) => db.collection('roles').findOne({ name }));
      expect(stored?.permissions?.PROJECTS).toBeUndefined();

      const headers = await login(request, member.user);
      const created = await request.post('/api/projects', {
        headers,
        data: { name: uniqueName('Legacy') },
      });
      expect(created.status()).toBe(201);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });

  test('a chat filed under a project runs without its instructions once the role loses PROJECTS.USE @scenario:projects-use-refused-drops-chat-context', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    test.setTimeout(120000);
    const request = await playwright.request.newContext({ baseURL });
    const roles: string[] = [];
    let admin: Headers | undefined;
    let member: Member | undefined;
    const guidance = `E2E_PROJECT_GUIDANCE_${randomUUID()}`;
    try {
      admin = await login(request, getPrimaryE2EUser());
      member = await signInMember(browser, baseURL ?? '');
      const { page } = member;
      const headers = await login(request, member.user);
      const created = await request.post('/api/projects', {
        headers,
        data: { name: uniqueName('Context'), instructions: `Always follow ${guidance}.` },
      });
      expect(created.status()).toBe(201);
      const { _id: projectId } = (await created.json()) as { _id: string };

      await page.goto(`/c/new?projectId=${encodeURIComponent(projectId)}`, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_PROJECT_CONTEXT:${guidance}`);
      const transcript = page.getByTestId('screenshot-target');
      await expect(
        transcript.getByText(`E2E project context assertion passed: ${guidance}`),
      ).toBeVisible({ timeout: 20000 });
      await expect(page).toHaveURL(/\/c\/(?!new)[^/?]+/);

      roles.push(
        await assignRole(request, admin, member, {
          PROJECTS: { USE: false, CREATE: false },
        }),
      );
      await page.reload({ timeout: 10000 });
      await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_PROJECT_CONTEXT:- ${guidance}`);
      await expect(transcript.getByText('E2E project context assertion passed: -')).toBeVisible({
        timeout: 20000,
      });
      await expect(transcript.getByText(/E2E project context assertion failed:/)).toHaveCount(0);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });
});
