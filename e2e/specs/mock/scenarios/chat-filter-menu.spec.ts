import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';
import type { User } from '../../../types';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';
import { deleteConversations, withMongo } from '../db';
import { getE2EUser } from '../../../setup/user';
import cleanupUser from '../../../setup/cleanupUser';

test.describe.configure({ timeout: 120_000 });

type SeedRow = {
  title: string;
  files?: string[];
  updatedAt?: Date;
  chatProjectId?: string;
  isArchived?: boolean;
};

const DAY = 24 * 60 * 60 * 1000;
const userEmail = getE2EUser().email;
const createdConversationIds: string[] = [];
const createdProjectIds: string[] = [];

/* Every spec in the run shares this user, so each title carries its own id: a row is
 * then identified by its title alone, whatever else the list holds. */
const uniqueTitle = (label: string) => `Menu ${label} ${randomUUID().slice(0, 8)}`;

async function seedRows(rows: SeedRow[]): Promise<void> {
  await withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email: userEmail });
    if (!user) throw new Error(`E2E seed: user "${userEmail}" not found`);
    const docs = rows.map((row) => {
      const conversationId = randomUUID();
      createdConversationIds.push(conversationId);
      const at = row.updatedAt ?? new Date();
      return {
        conversationId,
        title: row.title,
        user: user._id.toString(),
        endpoint: 'openAI',
        isArchived: row.isArchived ?? false,
        ...(row.isArchived ? { archivedAt: at } : {}),
        ...(row.files ? { files: row.files } : {}),
        ...(row.chatProjectId ? { chatProjectId: row.chatProjectId } : {}),
        createdAt: at,
        updatedAt: at,
        __v: 0,
      };
    });
    await db.collection('conversations').insertMany(docs);
  });
}

async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects', { timeout: 10000 });
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/projects/')[1];
  expect(projectId).toBeTruthy();
  createdProjectIds.push(projectId);
  return projectId;
}

/** A row of the Chats section, as opposed to one filed under a project or pinned. */
const chatsRow = (page: Page, title: string): Locator =>
  page.getByTestId('convo-list-row').filter({ hasText: title });

const trigger = (page: Page) => page.getByTestId('chat-filter-menu');
const menu = (page: Page) => page.getByRole('menu', { name: 'Filter and sort chats' });

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) < 768;

/** Below `md` the sidebar is a drawer that starts closed; open it before reading the
 *  list. A no-op on desktop, where the list is already on screen. */
async function showSidebar(page: Page): Promise<void> {
  if (isPhone(page) && !(await trigger(page).isVisible())) {
    await page.getByTestId('header-open-sidebar-button').click();
  }
  await expect(trigger(page)).toBeVisible();
}

/** The drawer covers the composer on a phone, so it closes before a message is sent. */
async function hideSidebar(page: Page): Promise<void> {
  if (isPhone(page) && (await trigger(page).isVisible())) {
    await page.getByTestId('close-sidebar-button').click();
    await expect(trigger(page)).toBeHidden();
  }
}

async function openFilterSubmenu(page: Page): Promise<void> {
  if (!(await menu(page).isVisible())) {
    await trigger(page).click();
  }
  await expect(menu(page)).toBeVisible();
  await page.getByTestId('chat-filter-facets').click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Has attachments' })).toBeVisible();
}

async function closeMenus(page: Page): Promise<void> {
  for (let i = 0; i < 3 && (await menu(page).isVisible()); i++) {
    await page.keyboard.press('Escape');
  }
  await expect(menu(page)).toBeHidden();
}

async function toggleHasAttachments(page: Page): Promise<void> {
  await openFilterSubmenu(page);
  await page.getByRole('menuitemcheckbox', { name: 'Has attachments' }).click();
  await closeMenus(page);
}

test.afterEach(async () => {
  const conversationIds = createdConversationIds.splice(0, createdConversationIds.length);
  if (conversationIds.length > 0) {
    await deleteConversations(conversationIds);
  }
  const projectIds = createdProjectIds.splice(0, createdProjectIds.length);
  if (projectIds.length > 0) {
    await withMongo(async (db) => {
      const projects = await db
        .collection('chatprojects')
        .find({})
        .project({ _id: 1, projectId: 1 })
        .toArray();
      const ids = projects
        .filter((doc) => projectIds.includes(String(doc.projectId ?? doc._id)))
        .map((doc) => doc._id);
      await db.collection('chatprojects').deleteMany({ _id: { $in: ids } });
      await db.collection('conversations').deleteMany({ chatProjectId: { $in: projectIds } });
    });
  }
});

test.describe('chat list properties menu', () => {
  test('a facet chosen from the keyboard narrows the Chats list @scenario:chat-menu-facet-narrows-list', async ({
    page,
  }) => {
    const withFile = uniqueTitle('file');
    const withoutFile = uniqueTitle('plain');
    await seedRows([{ title: withFile, files: [randomUUID()] }, { title: withoutFile }]);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await showSidebar(page);
    await expect(chatsRow(page, withFile)).toBeVisible();
    await expect(chatsRow(page, withoutFile)).toBeVisible();

    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(page.getByTestId('chat-filter-show')).toBeVisible();
    await expect(page.getByTestId('chat-filter-sort')).toBeVisible();

    const filterRow = page.getByTestId('chat-filter-facets');
    for (let i = 0; i < 6; i++) {
      if (await filterRow.evaluate((node) => node === document.activeElement)) {
        break;
      }
      await page.keyboard.press('ArrowDown');
    }
    await expect(filterRow).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(
      page
        .getByRole('combobox', { name: 'Search filters' })
        .or(page.getByRole('textbox', { name: 'Search filters' })),
    ).toBeFocused();

    await page.getByRole('menuitemcheckbox', { name: 'Has attachments' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Has attachments' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await closeMenus(page);

    await expect(chatsRow(page, withFile)).toBeVisible();
    await expect(chatsRow(page, withoutFile)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute('aria-label', 'Filters active: 1');
    await expect(trigger(page)).toHaveAttribute('aria-pressed', 'true');
  });

  test('Reset in the menu restores the unfiltered list @scenario:chat-menu-reset-restores-list', async ({
    page,
  }) => {
    const withFile = uniqueTitle('file');
    const withoutFile = uniqueTitle('plain');
    await seedRows([{ title: withFile, files: [randomUUID()] }, { title: withoutFile }]);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await showSidebar(page);

    await toggleHasAttachments(page);
    await expect(chatsRow(page, withoutFile)).toHaveCount(0);

    await trigger(page).click();
    const reset = page.getByTestId('chat-filter-reset-all');
    await expect(reset).not.toHaveAttribute('aria-disabled', 'true');
    await reset.click();
    await expect(reset).toHaveAttribute('aria-disabled', 'true');
    await closeMenus(page);

    await expect(chatsRow(page, withoutFile)).toBeVisible();
    await expect(chatsRow(page, withFile)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-label', 'Filter and sort chats');
  });

  test('an Updated window of Today hides a chat last touched ten days ago @scenario:chat-date-window-hides-older', async ({
    page,
  }) => {
    const recent = uniqueTitle('recent');
    const older = uniqueTitle('older');
    /* Both carry a file, so the attachment facet reduces the list to rows this
     * test and its siblings seeded: the ten-day-old row is then on screen before
     * the date window, however many chats the shared user has. */
    await seedRows([
      { title: recent, files: [randomUUID()] },
      { title: older, files: [randomUUID()], updatedAt: new Date(Date.now() - 10 * DAY) },
    ]);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await showSidebar(page);
    await toggleHasAttachments(page);
    await expect(chatsRow(page, older)).toBeVisible();

    await openFilterSubmenu(page);
    await page.getByRole('menuitem', { name: /^Updated\b/ }).click();
    await page.getByRole('menuitemradio', { name: 'Today' }).click();
    await closeMenus(page);

    await expect(chatsRow(page, recent)).toBeVisible();
    await expect(chatsRow(page, older)).toHaveCount(0);
    await expect(trigger(page)).toHaveAttribute('aria-label', 'Filters active: 2');
  });

  test('a project chat is listed under its project, not in Chats, and stays reachable from the archive @scenario:project-chat-listed-under-project-only', async ({
    page,
  }) => {
    const projectName = `Menu project ${randomUUID().slice(0, 8)}`;
    const projectId = await createProject(page, projectName);
    const inProject = uniqueTitle('project');
    const archivedInProject = uniqueTitle('archived');
    const unassigned = uniqueTitle('unassigned');
    await seedRows([
      { title: inProject, chatProjectId: projectId },
      { title: archivedInProject, chatProjectId: projectId, isArchived: true },
      { title: unassigned },
    ]);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await showSidebar(page);

    await expect(chatsRow(page, unassigned)).toBeVisible();
    await expect(chatsRow(page, inProject)).toHaveCount(0);

    const projectRow = page.getByRole('button', { name: projectName }).first();
    if ((await projectRow.getAttribute('aria-expanded')) !== 'true') {
      await projectRow.click();
    }
    await expect(
      page.getByTestId(`project-chats-${projectId}`).getByTestId('convo-item').filter({
        hasText: inProject,
      }),
    ).toBeVisible();

    await trigger(page).click();
    await page.getByTestId('chat-filter-show').click();
    await page.getByRole('menuitemradio', { name: 'Archived chats' }).click();
    await closeMenus(page);
    await expect(chatsRow(page, archivedInProject)).toBeVisible();
  });

  test('a chat sent while a server-only facet is active is not added to the filtered list @scenario:live-chat-respects-active-facet', async ({
    page,
  }) => {
    const withFile = uniqueTitle('file');
    await seedRows([{ title: withFile, files: [randomUUID()] }]);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await showSidebar(page);
    await toggleHasAttachments(page);
    await expect(chatsRow(page, withFile)).toBeVisible();
    const rowsBefore = await page.getByTestId('convo-list-row').count();

    /* The facet's own refetch is held until the list has been read: whatever the
     * cache writers put in the list while the reply streamed is then still on
     * screen, instead of being papered over by the server's answer. */
    const held: Route[] = [];
    let holding = true;
    await page.route(
      (url) => url.pathname === '/api/convos' && url.searchParams.get('hasFiles') === 'true',
      async (route) => {
        if (holding) {
          held.push(route);
          return;
        }
        await route.continue();
      },
    );

    await hideSidebar(page);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, `no attachment ${randomUUID().slice(0, 8)}`);
    expect(response.ok()).toBeTruthy();
    await expect(mockReply(page)).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/\/c\/(?!new)/, { timeout: 15000 });
    const conversationId = new URL(page.url()).pathname.split('/c/')[1];
    createdConversationIds.push(conversationId);
    await showSidebar(page);

    await expect(page.getByTestId('convo-list-row')).toHaveCount(rowsBefore);

    holding = false;
    await Promise.all(held.splice(0, held.length).map((route) => route.continue()));
    await expect(chatsRow(page, withFile)).toBeVisible();
  });

  test('filters chosen by one account are gone after signing out and back in @scenario:facets-cleared-after-sign-out', async ({
    browser,
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock scenarios');
    }
    const user: User = {
      name: 'Facet Reset',
      email: `facet-reset-${randomUUID().slice(0, 8)}@example.com`,
      password: `Pw-${randomUUID()}`,
    };
    await cleanupUser(user);
    const context = await browser.newContext({ storageState: undefined, baseURL });
    await context.addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    const page = await context.newPage();

    const register = async (request: APIRequestContext) => {
      const registered = await request.post('/api/auth/register', {
        data: {
          email: user.email,
          name: user.name,
          password: user.password,
          confirm_password: user.password,
        },
      });
      expect(registered.ok()).toBeTruthy();
    };
    const logIn = async () => {
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(user.password);
      await page.getByTestId('login-button').click();
      await page.waitForURL(/\/c\/new/, { timeout: 10000 });
      await showSidebar(page);
    };

    try {
      await register(context.request);
      await page.goto('/login', { timeout: 10000 });
      await logIn();

      await toggleHasAttachments(page);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Filters active: 1');

      await showSidebar(page);
      await page.getByTestId('nav-user').click();
      await page.getByRole('menuitem', { name: 'Log out' }).click();
      await page.waitForURL(/\/login/, { timeout: 10000 });
      await logIn();

      await expect(trigger(page)).toHaveAttribute('aria-label', 'Filter and sort chats');
      await expect(trigger(page)).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await context.close().catch(() => undefined);
      await cleanupUser(user);
    }
  });

  test('a role without bookmark access opens the Filter submenu without asking for bookmarks @scenario:bookmark-filter-quiet-without-access', async ({
    browser,
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for mock scenarios');
    }
    const suffix = randomUUID().slice(0, 8);
    const roleName = `E2E_NO_BOOKMARKS_${suffix}`;
    const user: User = {
      name: 'No Bookmarks',
      email: `no-bookmarks-${suffix}@example.com`,
      password: `Pw-${randomUUID()}`,
    };
    await cleanupUser(user);
    /* A copy of the default role with only bookmarks switched off, held by this test's
     * own account: the role every other spec signs in with stays untouched. */
    await withMongo(async (db) => {
      const fields = await db
        .collection('roles')
        .findOne({ name: 'USER' }, { projection: { _id: 0 } });
      if (!fields) throw new Error('E2E seed: USER role not found');
      await db.collection('roles').insertOne({
        ...fields,
        name: roleName,
        permissions: {
          ...(fields.permissions ?? {}),
          BOOKMARKS: { ...(fields.permissions?.BOOKMARKS ?? {}), USE: false },
        },
      });
    });

    const context = await browser.newContext({ storageState: undefined, baseURL });
    await context.addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    const page = await context.newPage();
    try {
      const registered = await context.request.post('/api/auth/register', {
        data: {
          email: user.email,
          name: user.name,
          password: user.password,
          confirm_password: user.password,
        },
      });
      expect(registered.ok()).toBeTruthy();
      await withMongo((db) =>
        db.collection('users').updateOne({ email: user.email }, { $set: { role: roleName } }),
      );

      /* The page header asks for bookmarks on its own, gated or not, and retries the
       * refusal; that request predates this menu. Its cycle is let to settle first, so
       * what is counted afterwards is only what the Filter submenu asks for. */
      let tagRequests = 0;
      let lastTagRequestAt = Date.now();
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/tags')) {
          tagRequests += 1;
          lastTagRequestAt = Date.now();
        }
      });

      await page.goto('/login', { timeout: 10000 });
      await page.getByLabel('Email').fill(user.email);
      await page.getByLabel('Password').fill(user.password);
      await page.getByTestId('login-button').click();
      await page.waitForURL(/\/c\/new/, { timeout: 10000 });
      await showSidebar(page);
      await expect
        .poll(() => Date.now() - lastTagRequestAt, { timeout: 30000, intervals: [500] })
        .toBeGreaterThan(8000);
      const settledRequests = tagRequests;

      await openFilterSubmenu(page);
      await expect(page.getByRole('menuitem', { name: /^Updated\b/ })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /^Bookmarks\b/ })).toHaveCount(0);
      await page.getByRole('menuitemcheckbox', { name: 'Has attachments' }).click();
      await closeMenus(page);
      await expect(trigger(page)).toHaveAttribute('aria-label', 'Filters active: 1');
      await openFilterSubmenu(page);
      await closeMenus(page);

      expect(tagRequests).toBe(settledRequests);
    } finally {
      await context.close().catch(() => undefined);
      await cleanupUser(user);
      await withMongo((db) => db.collection('roles').deleteOne({ name: roleName }));
    }
  });
});
