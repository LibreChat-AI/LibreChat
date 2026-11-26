import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  replyText,
  uniqueName,
  replyPrompt,
  messagesView,
  isAgentsStream,
  selectMockEndpoint,
  uploadViaUnifiedButton,
} from '../helpers';
import { createProject, deleteProject } from './reveal.helpers';

type SentPayload = { files?: Array<{ file_id?: string }>; chatProjectId?: string | null };

/** The mock harness runs without Meilisearch (`SEARCH=false`), which hides the sidebar search.
 *  These stand in for that service: it reports itself available and finds nothing, which is all
 *  a search that is then cleared needs. */
async function enableSearch(page: Page): Promise<void> {
  await page.route('**/api/search/enable', (route) => route.fulfill({ json: true }));
  await page.route(
    (url) => url.pathname === '/api/messages' && url.searchParams.has('search'),
    (route) => route.fulfill({ json: { messages: [], nextCursor: null } }),
  );
}

/** The field sits in the sidebar on a pointer device and in the drawer's bottom bar on a phone,
 *  where the drawer has to be opened to reach it. */
async function searchField(page: Page, isMobile: boolean): Promise<Locator> {
  if (!isMobile) {
    return page.getByTestId('nav-search-input');
  }
  const drawer = page.locator('#mobile-drawer');
  if ((await drawer.getAttribute('inert')) != null) {
    await page.getByTestId('header-open-sidebar-button').click();
    await expect(drawer).not.toHaveAttribute('inert');
  }
  return drawer.getByTestId('nav-search-input');
}

/** On a phone the drawer covers the composer, so it is closed before the composer is used. The
 *  page behind it stays inert until the drawer has finished sliding away, and text typed into
 *  it before then is lost. */
async function closeDrawer(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) {
    return;
  }
  const drawer = page.locator('#mobile-drawer');
  if ((await drawer.getAttribute('inert')) == null) {
    await page
      .getByRole('button', { name: 'Close sidebar' })
      .filter({ visible: true })
      .first()
      .click();
    await expect(drawer).toHaveAttribute('inert', '');
  }
  await expect(page.getByTestId('app-pane')).not.toHaveAttribute('inert');
}

/** Waits for the unsent chat's address: `/c/new`, carrying its project when it has one. The app
 *  mirrors the chat's model into the query as well, so only the project is compared. */
async function expectUnsentChatUrl(page: Page, projectId = ''): Promise<void> {
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname} ${url.searchParams.get('projectId') ?? ''}`;
    })
    .toBe(`/c/new ${projectId}`);
}

/** Uploads a file into the composer and returns its chip and stored id. */
async function attach(page: Page, label: string): Promise<{ chip: Locator; fileId: string }> {
  const name = `${uniqueName(label)}.md`;
  const upload = await uploadViaUnifiedButton(page, {
    name,
    mimeType: 'text/markdown',
    content: `# Attached before the search: ${label}\n`,
  });
  expect(upload.ok()).toBe(true);
  const fileId = ((await upload.json()) as UploadedFile).file_id ?? '';
  expect(fileId).not.toBe('');
  const chip = page.getByTestId('composer-tray').getByRole('button', { name, exact: true });
  await expect(chip).toBeVisible({ timeout: 15000 });
  return { chip, fileId };
}

/** Every request that would delete an upload, from now on. */
function watchDeletions(page: Page): string[] {
  const deletions: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/api/files') {
      deletions.push(request.url());
    }
  });
  return deletions;
}

/** A query opens the results page; the field's clear button dismisses it. */
async function searchAndClear(page: Page, isMobile: boolean): Promise<void> {
  const field = await searchField(page, isMobile);
  await field.fill('quarterly report');
  await expect(page).toHaveURL(/\/search$/);
  const results = await searchField(page, isMobile);
  await results.locator('..').getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(results).toHaveValue('');
}

/** Sends the composer and returns the request body once the reply shows. */
async function send(page: Page, label: string): Promise<SentPayload> {
  await page.getByRole('textbox', { name: 'Message input' }).fill(replyPrompt(label));
  const sent = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/api/agents/chat'),
  );
  const [stream] = await Promise.all([
    page.waitForResponse(isAgentsStream, { timeout: 30000 }),
    page.getByTestId('send-button').click(),
  ]);
  expect(stream.ok()).toBe(true);
  const payload = (await sent).postDataJSON() as SentPayload;
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible({ timeout: 20000 });
  return payload;
}

/** Spelled out in full, since the verifier finds a scenario by its literal tag. */
const draftModes = [
  {
    saveDrafts: true,
    mode: 'with',
    tag: '@scenario:clearing-a-search-keeps-the-unsent-chat-attachment-with-saved-drafts',
  },
  {
    saveDrafts: false,
    mode: 'without',
    tag: '@scenario:clearing-a-search-keeps-the-unsent-chat-attachment-without-saved-drafts',
  },
];

test.describe('clearing the sidebar search', () => {
  for (const { saveDrafts, mode, tag } of draftModes) {
    test(`returns to the unsent chat with its attachment, drafts ${saveDrafts ? 'saved' : 'not saved'} ${tag}`, async ({
      page,
      isMobile,
    }) => {
      test.setTimeout(90000);
      await page.addInitScript(
        (value) => localStorage.setItem('saveDrafts', String(value)),
        saveDrafts,
      );
      await enableSearch(page);
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const { chip, fileId } = await attach(page, `search-${mode}`);
      const deletions = watchDeletions(page);

      /** The query is not part of the chat, so dismissing it brings back the chat as it was. */
      await searchAndClear(page, isMobile);
      await expectUnsentChatUrl(page);
      await closeDrawer(page, isMobile);
      await expect(chip).toBeVisible();

      const payload = await send(page, `search-clear-${mode}`);
      expect((payload.files ?? []).map((file) => file.file_id)).toEqual([fileId]);
      expect(deletions).toEqual([]);
    });
  }

  test('leaves the unsent chat alone on Backspace in the empty field @scenario:backspace-in-the-empty-search-keeps-the-unsent-chat-attachment', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(90000);
    await enableSearch(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const { chip, fileId } = await attach(page, 'search-backspace');
    const deletions = watchDeletions(page);

    /** Backspace in an empty field clears a search that is not there: still on the chat, which
     *  keeps its attachment, and the page adds no history entry of its own. */
    const length = await page.evaluate(() => window.history.length);
    const field = await searchField(page, isMobile);
    await field.click();
    await field.press('Backspace');
    /** Two frames let the app apply what the key did before anything is checked. */
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(field).toBeFocused();
    await expectUnsentChatUrl(page);
    await closeDrawer(page, isMobile);
    await expect(chip).toBeVisible();
    expect(await page.evaluate(() => window.history.length)).toBe(length);

    const payload = await send(page, 'search-backspace');
    expect((payload.files ?? []).map((file) => file.file_id)).toEqual([fileId]);
    expect(deletions).toEqual([]);
  });

  test('keeps the project of an unsent project chat @scenario:clearing-a-search-keeps-the-unsent-chat-project', async ({
    page,
    isMobile,
  }) => {
    test.setTimeout(90000);
    await enableSearch(page);
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    const name = uniqueName('Search project');
    const projectId = await createProject(page, name);
    try {
      await page.goto(`${NEW_CHAT_PATH}?projectId=${encodeURIComponent(projectId)}`, {
        timeout: 10000,
      });
      await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
      const project = page.getByRole('combobox', { name: 'Change project' });
      await expect(project).toContainText(name, { timeout: 15000 });
      const { chip, fileId } = await attach(page, 'search-project');

      await searchAndClear(page, isMobile);
      await expectUnsentChatUrl(page, projectId);
      await closeDrawer(page, isMobile);
      await expect(project).toContainText(name);
      await expect(chip).toBeVisible();

      const payload = await send(page, 'search-project');
      expect((payload.files ?? []).map((file) => file.file_id)).toEqual([fileId]);
      expect(payload.chatProjectId).toBe(projectId);
    } finally {
      await deleteProject(page, projectId);
    }
  });
});
