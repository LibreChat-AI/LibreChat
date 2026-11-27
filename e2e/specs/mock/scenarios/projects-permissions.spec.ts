import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { Headers, Member } from './projects.helpers';
import { MOCK_ENDPOINTS, selectMockEndpoint, sendMessageAndWaitForCompletion } from '../helpers';
import { login, cleanup, assignRole, uniqueName, signInMember } from './projects.helpers';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';

/**
 * Chat Projects follow the role's PROJECTS permissions on the server. A role without USE is
 * refused by every project route and its chats run outside their project; a role without CREATE
 * keeps its projects but cannot add one; a role stored before the permission existed keeps both.
 * The primary account is the deployment's admin and manages the roles; each test signs in a
 * member of its own.
 */

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
