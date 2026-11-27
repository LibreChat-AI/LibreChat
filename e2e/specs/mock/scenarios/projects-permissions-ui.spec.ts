import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Headers, Member } from './projects.helpers';
import { login, cleanup, assignRole, uniqueName, signInMember } from './projects.helpers';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { openSidebar } from './sidebar';

/**
 * The client follows the role's PROJECTS permissions: a role without USE sees no projects and
 * asks the server for none, and a role without CREATE keeps its projects but is offered no way
 * to create one.
 */

const isProjectsRequest = (url: string) => new URL(url).pathname.startsWith('/api/projects');

/** Reloads so the member's role is read again, and counts the project requests it makes. */
async function reloadCounting(page: Page): Promise<() => number> {
  let count = 0;
  page.on('request', (request) => {
    if (isProjectsRequest(request.url())) {
      count += 1;
    }
  });
  await page.goto('/c/new', { timeout: 10000 });
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible();
  return () => count;
}

test.describe('Chat Projects permissions in the client', () => {
  test('a role without PROJECTS.USE sees no projects and its project links lead to a new chat @scenario:projects-use-refused-hides-projects', async ({
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
      const headers = await login(request, member.user);
      const created = await request.post('/api/projects', {
        headers,
        data: { name: uniqueName('Hidden') },
      });
      expect(created.status()).toBe(201);
      const { _id: projectId } = (await created.json()) as { _id: string };
      roles.push(await assignRole(request, admin, member, { PROJECTS: { USE: false } }));

      const { page } = member;
      const projectRequests = await reloadCounting(page);
      await openSidebar(page);
      await expect(page.getByRole('button', { name: 'All projects' })).toHaveCount(0);
      const history = page.getByRole('region', { name: 'Chat History' });
      await expect(history).toBeVisible();
      await expect(history.getByText('Projects', { exact: true })).toHaveCount(0);

      await page.goto(`/projects/${encodeURIComponent(projectId)}`, { timeout: 10000 });
      await expect(page).toHaveURL(/\/c\/new$/);
      await page.goto(`/c/new?projectId=${encodeURIComponent(projectId)}`, { timeout: 10000 });
      await expect(page).toHaveURL(/\/c\/new$/);
      expect(projectRequests()).toBe(0);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });

  test('a role without PROJECTS.CREATE keeps its projects but is offered no way to create one @scenario:projects-create-refused-hides-create', async ({
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
      const headers = await login(request, member.user);
      const name = uniqueName('Kept');
      const created = await request.post('/api/projects', { headers, data: { name } });
      expect(created.status()).toBe(201);
      roles.push(
        await assignRole(request, admin, member, { PROJECTS: { USE: true, CREATE: false } }),
      );

      const { page } = member;
      await page.goto('/projects?new=1', { timeout: 10000 });
      await expect(page.getByRole('main').getByText(name)).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await cleanup(request, admin, member, roles);
    }
  });
});
