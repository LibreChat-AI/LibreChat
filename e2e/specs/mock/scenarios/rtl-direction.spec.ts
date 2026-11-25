import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { openSidebar } from './sidebar';

/**
 * Interface and chat direction. A right-to-left locale marks the document `rtl` before the bundle
 * runs, Radix subtrees and the toast swipe follow it, and switching language in Settings leaves
 * `<html lang dir>` on the locale actually shown. The chat direction setting is `auto`, `ltr` or
 * `rtl`: a forced value mirrors the composer and the message editors, `auto` lets each field follow
 * its text, and an empty composer follows the interface so its placeholder sits on the reading edge.
 */
test.describe.configure({ timeout: 120_000 });

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Seeds localStorage once per test, so a reload inside the test keeps what the app wrote since. */
async function seedStorage(page: Page, values: Record<string, string | null>) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem('e2e-rtl-seeded') != null) {
      return;
    }
    for (const [key, value] of Object.entries(entries)) {
      if (value == null) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    }
    sessionStorage.setItem('e2e-rtl-seeded', '1');
  }, values);
}

const documentDirection = (page: Page) =>
  page.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
  }));

const computedDirection = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).direction);

async function openSettings(page: Page) {
  await openSidebar(page);
  await page.getByTestId('nav-user').filter({ visible: true }).first().click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('tablist')).toBeVisible({ timeout: 15000 });
  await openTab(dialog, 'general');
  return dialog;
}

/** Phones show the tab list and a panel one at a time, so a hidden list is reached through Back. */
async function openTab(dialog: Locator, id: string) {
  const tab = dialog.locator(`[role="tab"][id$="-trigger-${id}"]`);
  if (!(await tab.isVisible())) {
    await dialog.getByRole('button', { name: /^(Back|عودة)$/ }).click();
  }
  await tab.click();
  await expect(dialog.getByRole('tabpanel')).toBeVisible();
}

async function chooseOption(page: Page, trigger: Locator, name: string) {
  await trigger.click();
  await page.getByRole('option', { name, exact: true }).click();
}

const languageSelect = (dialog: Locator) =>
  dialog.locator('[role="combobox"][aria-labelledby~="language-selector-label"]');

test.describe('before the bundle', () => {
  /* A worker-served reload would bypass the route that holds the bundle back. */
  test.use({ serviceWorkers: 'block' });

  test('a right-to-left locale marks the document rtl before the bundle runs @scenario:rtl-shell-direction-before-bundle', async ({
    page,
    context,
  }) => {
    /* Module scripts are held, never answered: only the inline shell script can set `dir`, and a
     * refused script would start the stale-asset recovery reload instead. */
    await page.route(/\/assets\/.*\.js(?:\?.*)?$/, () => new Promise<void>(() => undefined));
    const load = async () => {
      await page.goto('/', { timeout: 30000, waitUntil: 'commit' });
      await page.waitForFunction(() => document.body != null);
      return (await documentDirection(page)).dir;
    };

    await seedStorage(page, { lang: JSON.stringify('ar-EG') });
    expect(await load()).toBe('rtl');

    /* A value stored unquoted by an older client still counts. */
    await page.evaluate(() => localStorage.setItem('lang', 'he'));
    expect(await load()).toBe('rtl');

    /* The cookie wins over storage, as it does in `detectInitialLanguage`. */
    await page.evaluate(() => localStorage.setItem('lang', JSON.stringify('fa-IR')));
    const { origin } = new URL(page.url());
    await context.addCookies([{ name: 'lang', value: 'en-US', url: origin }]);
    expect(await load()).toBe('');

    await context.addCookies([{ name: 'lang', value: 'ug', url: origin }]);
    await page.evaluate(() => localStorage.setItem('lang', JSON.stringify('en-US')));
    expect(await load()).toBe('rtl');
  });
});

test('switching language in Settings leaves the document on the locale shown @scenario:language-switch-sets-document-direction', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('en-US') });
  await page.goto('/c/new', { timeout: 30000 });
  const dialog = await openSettings(page);

  await chooseOption(page, languageSelect(dialog), 'العربية');
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });
  /* The selector's own value is `ar-EG`; nothing may overwrite the normalized locale later. */
  await page.waitForTimeout(500);
  expect(await documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });

  await chooseOption(page, languageSelect(dialog), 'English');
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'en', dir: 'ltr' });
  await page.waitForTimeout(500);
  expect(await documentDirection(page)).toEqual({ lang: 'en', dir: 'ltr' });
});

test('Radix subtrees follow a right-to-left interface @scenario:radix-subtrees-follow-interface-direction', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('en-US') });
  await page.goto('/c/new', { timeout: 30000 });
  const dialog = await openSettings(page);
  const panel = dialog.getByRole('tabpanel');
  /* The nearest `dir` above the settings body is the one Radix Tabs writes on its root. */
  const radixDirection = () =>
    panel.evaluate((element) => element.closest('[dir]')?.getAttribute('dir') ?? null);
  expect(await radixDirection()).toBe('ltr');
  expect(await computedDirection(panel)).toBe('ltr');

  await chooseOption(page, languageSelect(dialog), 'العربية');
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });

  /* Radix Tabs used to write `dir="ltr"` here, turning the whole settings body LTR. */
  await expect.poll(radixDirection).toBe('rtl');
  await expect.poll(() => computedDirection(panel)).toBe('rtl');
});

/** Drags the toast horizontally and reports how Radix settled the swipe (`end` dismisses it). */
async function swipe(page: Page, toast: Locator, dx: number) {
  await toast.evaluate((element) => {
    const seen: string[] = [];
    (window as unknown as { __swipes: string[] }).__swipes = seen;
    new MutationObserver(() => seen.push(element.getAttribute('data-swipe') ?? '')).observe(
      element,
      { attributes: true, attributeFilter: ['data-swipe'] },
    );
  });
  const box = await toast.locator('.alert-root').boundingBox();
  expect(box).not.toBeNull();
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(x + (dx * step) / 10, y);
  }
  await page.mouse.up();
  return page.evaluate(() => (window as unknown as { __swipes: string[] }).__swipes);
}

test('a toast swipes away toward the inline end @scenario:toast-swipes-toward-inline-end', async ({
  page,
}) => {
  await page.route(/\/api\/convos\/import(?:\?.*)?$/, (route: Route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
  );
  await seedStorage(page, { lang: JSON.stringify('en-US') });
  await page.goto('/c/new', { timeout: 30000 });
  const dialog = await openSettings(page);

  /* A failed import raises an error toast; the dialog stays open across the language switch. */
  const raiseToast = async () => {
    await openTab(dialog, 'data');
    await dialog
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'chats.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{}'),
      });
    const toast = page.locator('.toast-root[data-state="open"]').last();
    await expect(toast).toBeVisible({ timeout: 15000 });
    return toast;
  };

  const ltrToast = await raiseToast();
  await expect(ltrToast).toHaveAttribute('data-swipe-direction', 'right');
  await expect(ltrToast).toBeHidden({ timeout: 10000 });

  await openTab(dialog, 'general');
  await chooseOption(page, languageSelect(dialog), 'العربية');
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });

  const rtlToast = await raiseToast();
  await expect(rtlToast).toHaveAttribute('data-swipe-direction', 'left');
  /* Escape would dismiss the toast itself, so the dialog is closed by its button. */
  await dialog.getByRole('button', { name: 'Close Settings' }).click();
  await expect(dialog).toBeHidden();

  /* Dragging toward the inline start is refused; toward the inline end (left) dismisses. */
  expect(await swipe(page, rtlToast, 160)).not.toContain('end');
  expect(await swipe(page, rtlToast, -160)).toContain('end');
  await expect(rtlToast).toBeHidden({ timeout: 10000 });
});

test('the chat direction setting forces the composer or lets it follow the page @scenario:chat-direction-setting-forces-composer', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('en-US'), chatDirection: null });
  await page.goto('/c/new', { timeout: 30000 });
  const form = page.locator('form').filter({ has: page.getByTestId('text-input') });
  const input = page.getByTestId('text-input');
  await expect(input).toBeVisible({ timeout: 20000 });
  expect(await form.getAttribute('dir')).toBeNull();

  const dialog = await openSettings(page);
  const select = dialog.getByTestId('chatDirection');
  await expect(select).toContainText('Auto');
  await select.click();
  await expect(page.getByRole('option')).toHaveText(['Auto', 'Left to Right', 'Right to Left']);
  await page.getByRole('option', { name: 'Right to Left', exact: true }).click();
  await expect(select).toContainText('Right to Left');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect(form).toHaveAttribute('dir', 'rtl');
  await expect(input).toHaveAttribute('dir', 'rtl');
  expect(await computedDirection(input)).toBe('rtl');
  expect(await page.evaluate(() => localStorage.getItem('chatDirection'))).toBe('"rtl"');

  /* A forced LTR holds inside a right-to-left interface too. */
  await page.evaluate(() => {
    localStorage.setItem('chatDirection', JSON.stringify('ltr'));
    localStorage.setItem('lang', JSON.stringify('ar-EG'));
  });
  await page.reload();
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });
  await expect(form).toHaveAttribute('dir', 'ltr');
  await expect(input).toHaveAttribute('dir', 'ltr');
  expect(await computedDirection(input)).toBe('ltr');
});

test('a stored legacy chat direction keeps its meaning @scenario:chat-direction-legacy-value-migrates', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('en-US'), chatDirection: JSON.stringify('RTL') });
  await page.goto('/c/new', { timeout: 30000 });
  const form = page.locator('form').filter({ has: page.getByTestId('text-input') });
  await expect(page.getByTestId('text-input')).toBeVisible({ timeout: 20000 });
  await expect(form).toHaveAttribute('dir', 'rtl');

  const dialog = await openSettings(page);
  await expect(dialog.getByTestId('chatDirection')).toContainText('Right to Left');
  await page.keyboard.press('Escape');

  /* An unrecognized stored value falls back to `auto` instead of breaking the composer. */
  await page.evaluate(() => localStorage.setItem('chatDirection', JSON.stringify('sideways')));
  await page.reload();
  await expect(page.getByTestId('text-input')).toBeVisible({ timeout: 20000 });
  expect(await form.getAttribute('dir')).toBeNull();
  const reopened = await openSettings(page);
  await expect(reopened.getByTestId('chatDirection')).toContainText('Auto');
});

test('an empty composer follows the interface until text gives it a direction @scenario:composer-empty-follows-interface', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('ar-EG'), chatDirection: JSON.stringify('auto') });
  await page.goto('/c/new', { timeout: 30000 });
  await expect.poll(() => documentDirection(page)).toEqual({ lang: 'ar', dir: 'rtl' });
  const input = page.getByTestId('text-input');
  await expect(input).toBeVisible({ timeout: 20000 });
  await expect(input).toHaveAttribute('dir', 'rtl');
  expect(await computedDirection(input)).toBe('rtl');

  await input.click();
  await input.fill('hello world');
  await expect(input).toHaveAttribute('dir', 'auto');
  expect(await input.evaluate((element) => element.matches(':dir(ltr)'))).toBe(true);

  await input.fill('مرحبا');
  expect(await input.evaluate((element) => element.matches(':dir(rtl)'))).toBe(true);

  await input.fill('');
  await expect(input).toHaveAttribute('dir', 'rtl');
});

async function routeEditableConversation(page: Page) {
  const conversationId = unique('e2e-rtl-edit');
  const now = new Date(0).toISOString();
  const userId = `${conversationId}-user`;
  const assistantId = `${conversationId}-assistant`;
  const messages = [
    {
      messageId: userId,
      conversationId,
      parentMessageId: NO_PARENT,
      isCreatedByUser: true,
      sender: 'User',
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      text: 'user question',
      createdAt: now,
      updatedAt: now,
    },
    {
      messageId: assistantId,
      conversationId,
      parentMessageId: userId,
      isCreatedByUser: false,
      sender: 'Assistant',
      endpoint: 'Mock Provider A',
      model: 'mock-model-a',
      text: '',
      content: [{ type: 'text', text: 'assistant answer' }],
      createdAt: now,
      updatedAt: now,
    },
  ];
  const conversation = {
    conversationId,
    title: 'Direction editors',
    endpoint: 'Mock Provider A',
    endpointType: 'custom',
    model: 'mock-model-a',
    createdAt: now,
    updatedAt: now,
  };
  const convoIdRe = escapeRe(conversationId);
  await page.route(new RegExp(`/api/convos/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(conversation),
    }),
  );
  await page.route(new RegExp(`/api/messages/${convoIdRe}(?:\\?.*)?$`), (route: Route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(messages) }),
  );
  return { conversationId, userId, assistantId };
}

async function openEditor(page: Page, messageId: string, text: string) {
  await page.getByText(text, { exact: true }).first().hover();
  await page.locator(`[id="edit-${messageId}"]`).click();
  const editor = page.locator('textarea.message-editor-text').filter({ visible: true }).first();
  await expect(editor).toBeVisible({ timeout: 10000 });
  return editor;
}

test('the message editors follow the chat direction setting @scenario:message-editors-follow-chat-direction', async ({
  page,
}) => {
  await seedStorage(page, { lang: JSON.stringify('en-US'), chatDirection: JSON.stringify('auto') });
  const { conversationId, userId, assistantId } = await routeEditableConversation(page);
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
  await expect(page.getByText('assistant answer', { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });

  let editor = await openEditor(page, userId, 'user question');
  await expect(editor).toHaveAttribute('dir', 'auto');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  editor = await openEditor(page, assistantId, 'assistant answer');
  await expect(editor).toHaveAttribute('dir', 'auto');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  await page.evaluate(() => localStorage.setItem('chatDirection', JSON.stringify('rtl')));
  await page.reload();
  await expect(page.getByText('assistant answer', { exact: true }).first()).toBeVisible({
    timeout: 20000,
  });

  editor = await openEditor(page, userId, 'user question');
  await expect(editor).toHaveAttribute('dir', 'rtl');
  expect(await computedDirection(editor)).toBe('rtl');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  editor = await openEditor(page, assistantId, 'assistant answer');
  await expect(editor).toHaveAttribute('dir', 'rtl');
  expect(await computedDirection(editor)).toBe('rtl');
});
