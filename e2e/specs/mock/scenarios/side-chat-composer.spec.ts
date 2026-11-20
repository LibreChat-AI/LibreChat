import { expect, test } from '@playwright/test';
import type { Page, Locator } from '@playwright/test';
import {
  replyText,
  replyPrompt,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  conversationRow,
  selectMockEndpoint,
  modelSelectorTrigger,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { openChatHistory } from './sidebar';

/**
 * The composer of a conversation open beside the chat is main chat's own form, for that
 * conversation: what is attached, dropped, typed and stopped there is that conversation's, and
 * the chat on screen keeps its own.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

async function startChat(page: Page, label: string): Promise<string> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  return page.url();
}

/** Two conversations: the first open beside the second, which stays on screen. */
async function openBeside(page: Page, prefix: string) {
  const earlier = uniqueLabel(`${prefix}-earlier`);
  const earlierUrl = await startChat(page, earlier);
  await startChat(page, uniqueLabel(`${prefix}-current`));
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });
  return {
    earlierUrl,
    sideChat,
    side: sideChat.locator('form'),
    main: page.locator('main form').first(),
    field: sideChat.getByRole('textbox', { name: 'Message input' }),
  };
}

const isStart = (url: string, method: string): boolean =>
  method === 'POST' &&
  /\/api\/agents\/chat\/[^/]+$/.test(new URL(url).pathname) &&
  !url.endsWith('/abort');

/** Drops a text file on `target`, and takes it as text when the deployment asks how. */
async function dropFile(page: Page, target: Locator, name: string) {
  const data = await page.evaluateHandle((filename) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['dropped text\n'], filename, { type: 'text/plain' }));
    return transfer;
  }, name);
  await target.dispatchEvent('dragenter', { dataTransfer: data });
  await target.dispatchEvent('dragover', { dataTransfer: data });
  await target.dispatchEvent('drop', { dataTransfer: data });
  await page.getByRole('dialog').getByText('Upload as Text').click();
}

test('a file attached in the side chat goes out with that conversation’s turn @scenario:side-chat-composer-attaches-a-file', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { earlierUrl, sideChat, side, main, field } = await openBeside(page, 'attach');
  const followUp = uniqueLabel('with-file');

  /** Each composer is its own field: no id is on the page twice. */
  const ids = await page
    .locator('form textarea')
    .evaluateAll((fields) => fields.map((field) => field.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(2);

  await side.getByRole('button', { name: 'Attach and tools' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Upload to Provider', exact: true }).click(),
  ]);
  const [uploaded] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/files') && response.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    chooser.setFiles({
      name: 'beside.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('For the conversation beside the chat.\n'),
    }),
  ]);
  expect(uploaded.ok()).toBeTruthy();

  /** The attachment is the side conversation's: the chat on screen has none. */
  await expect(side.getByText('beside.txt')).toBeVisible();
  await expect(main.getByText('beside.txt')).toHaveCount(0);

  await field.click();
  await page.keyboard.type(replyPrompt(followUp));
  const [start] = await Promise.all([
    page.waitForRequest((request) => isStart(request.url(), request.method())),
    page.keyboard.press('Enter'),
  ]);
  const posted = start.postDataJSON() as {
    conversationId?: string;
    files?: Array<{ filename?: string }>;
  };
  expect(earlierUrl).toContain(posted.conversationId ?? 'none');
  expect(posted.files?.map((file) => file.filename)).toEqual(['beside.txt']);

  /** It went with the turn, and shows on the message it was sent with. */
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(side.getByText('beside.txt')).toHaveCount(0);
  await expect(sideChat.locator('.message-render').getByText('beside.txt')).toBeVisible();
});

test('a file dropped on a conversation goes to that conversation’s composer @scenario:side-chat-composer-takes-its-own-drops', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { sideChat, side, main } = await openBeside(page, 'drop');

  await dropFile(page, sideChat.locator('.message-render').first(), 'for-beside.txt');
  await expect(side.getByText('for-beside.txt')).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText('for-beside.txt')).toHaveCount(0);

  await dropFile(page, messagesView(page).locator('.message-render').first(), 'for-main.txt');
  await expect(main.getByText('for-main.txt')).toBeVisible({ timeout: 30_000 });
  await expect(side.getByText('for-main.txt')).toHaveCount(0);
});

test('a reply in a side chat is stopped from its composer @scenario:side-chat-composer-stops-a-reply', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { sideChat, side, field } = await openBeside(page, 'stop');

  await field.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${uniqueLabel('halted')}`);
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText('chunk-005', { timeout: 30_000 });

  await side.getByRole('button', { name: 'Stop generating' }).click();

  /** The reply stops where it was, and the composer takes the next turn. */
  await expect(side.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(sideChat).not.toContainText('chunk-159');
  const followUp = uniqueLabel('after-stop');
  await field.click();
  await page.keyboard.type(replyPrompt(followUp));
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(sideChat).not.toContainText('chunk-159');
});

test('words not sent yet go with the conversation when it becomes the main chat @scenario:side-chat-composer-draft-follows-the-conversation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { earlierUrl, sideChat, main, field } = await openBeside(page, 'draft');

  /** Each composer holds its own words. */
  await main.getByRole('textbox', { name: 'Message input' }).click();
  await page.keyboard.type('for the chat on screen');
  await field.click();
  await page.keyboard.type('still thinking about this');
  await expect(main.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'for the chat on screen',
  );

  await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();

  await expect(page).toHaveURL(new URL(earlierUrl).pathname);
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);
  await expect(
    page.locator('main form').first().getByRole('textbox', { name: 'Message input' }),
  ).toHaveValue('still thinking about this');
});

test('with drafts not saved, the words still go with the conversation @scenario:side-chat-composer-draft-follows-without-saved-drafts', async ({
  page,
}) => {
  test.setTimeout(120_000);
  /** Nothing keeps a draft between composers here, so the words are handed over directly. */
  await page.addInitScript(() => localStorage.setItem('saveDrafts', 'false'));
  const { earlierUrl, sideChat, field } = await openBeside(page, 'unsaved');

  await field.click();
  await page.keyboard.type('not saved anywhere');
  await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();

  await expect(page).toHaveURL(new URL(earlierUrl).pathname);
  await expect(
    page.locator('main form').first().getByRole('textbox', { name: 'Message input' }),
  ).toHaveValue('not saved anywhere');
});

test('words written in one side chat stay with it, not with the next one opened @scenario:side-chat-composer-draft-stays-with-its-conversation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const first = uniqueLabel('first');
  const second = uniqueLabel('second');
  const firstUrl = await startChat(page, first);
  const secondUrl = await startChat(page, second);
  await startChat(page, uniqueLabel('on-screen'));
  const openFromSidebar = async (url: string, label: string) => {
    await openChatHistory(page);
    const row = conversationRow(page, url);
    await row.hover();
    await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
    await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
    const panel = page.getByRole('region', { name: 'Side chat' });
    await expect(panel).toContainText(replyText(label), { timeout: 30_000 });
    return panel;
  };

  /** Written while the first conversation's reply runs, then the side chat is closed. */
  let sideChat = await openFromSidebar(firstUrl, first);
  let field = sideChat.getByRole('textbox', { name: 'Message input' });
  await field.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${uniqueLabel('left-running')}`);
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText('chunk-005', { timeout: 30_000 });
  await field.click();
  await page.keyboard.type('meant for the first');
  await sideChat.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);

  /** Another conversation opened beside the chat does not find them in its composer. */
  sideChat = await openFromSidebar(secondUrl, second);
  field = sideChat.getByRole('textbox', { name: 'Message input' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await sideChat.getByRole('button', { name: 'Close' }).click();

  /** The conversation they were written for does, once its reply is in. */
  sideChat = await openFromSidebar(firstUrl, first);
  await expect(sideChat).toContainText('chunk-159', { timeout: 90_000 });
  await expect(sideChat.getByRole('textbox', { name: 'Message input' })).toHaveValue(
    'meant for the first',
  );
});

test('with drafts not saved, the words outlive the panel being drawn again @scenario:side-chat-composer-draft-survives-a-layout-change', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem('saveDrafts', 'false'));
  const { field } = await openBeside(page, 'layout');
  await field.click();
  await page.keyboard.type('kept across the breakpoint');

  /** Narrow enough that the panel leaves its column and is drawn again as a sheet. */
  await page.setViewportSize({ width: 700, height: 900 });
  const sheet = page.getByRole('dialog', { name: 'Side chat' });
  await expect(sheet).toBeVisible();
  const carried = sheet.getByRole('textbox', { name: 'Message input' });
  await expect(carried).toHaveValue('kept across the breakpoint');

  /** Sent from the composer drawn again, the words go once: the field is empty afterwards. */
  const followUp = uniqueLabel('sent-once');
  await carried.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(replyPrompt(followUp));
  await page.keyboard.press('Enter');
  await expect(sheet).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(carried).toHaveValue('');
});

test('with drafts not saved, a file staged for one side chat is not sent with the next @scenario:side-chat-composer-files-stay-with-their-conversation', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem('saveDrafts', 'false'));
  const first = uniqueLabel('files-first');
  const second = uniqueLabel('files-second');
  const firstUrl = await startChat(page, first);
  const secondUrl = await startChat(page, second);
  await startChat(page, uniqueLabel('files-on-screen'));
  const openFromSidebar = async (url: string, label: string) => {
    await openChatHistory(page);
    const row = conversationRow(page, url);
    await row.hover();
    await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
    await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
    const panel = page.getByRole('region', { name: 'Side chat' });
    await expect(panel).toContainText(replyText(label), { timeout: 30_000 });
    return panel;
  };

  let sideChat = await openFromSidebar(firstUrl, first);
  await sideChat.locator('form').getByRole('button', { name: 'Attach and tools' }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Upload to Provider', exact: true }).click(),
  ]);
  await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/api/files') && response.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    chooser.setFiles({
      name: 'for-the-first.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Staged for the first conversation.\n'),
    }),
  ]);
  await expect(sideChat.locator('form').getByText('for-the-first.txt')).toBeVisible();
  await sideChat.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);

  /** The next conversation's composer starts with nothing staged, and its turn carries no file. */
  sideChat = await openFromSidebar(secondUrl, second);
  await expect(sideChat.locator('form').getByText('for-the-first.txt')).toHaveCount(0);
  const followUp = uniqueLabel('no-file');
  await sideChat.getByRole('textbox', { name: 'Message input' }).click();
  await page.keyboard.type(replyPrompt(followUp));
  const [start] = await Promise.all([
    page.waitForRequest((request) => isStart(request.url(), request.method())),
    page.keyboard.press('Enter'),
  ]);
  const posted = start.postDataJSON() as { conversationId?: string; files?: unknown[] };
  expect(secondUrl).toContain(posted.conversationId ?? 'none');
  expect(posted.files ?? []).toEqual([]);
  await expect(sideChat).toContainText(replyText(followUp), { timeout: 30_000 });
});

for (const saveDrafts of [true, false]) {
  test(`a file staged in the side chat goes with the conversation to the main chat, drafts ${saveDrafts ? 'saved' : 'not saved'} @scenario:side-chat-composer-staged-file-follows-${saveDrafts ? 'with' : 'without'}-saved-drafts`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.addInitScript(
      (value) => localStorage.setItem('saveDrafts', String(value)),
      saveDrafts,
    );
    const { earlierUrl, sideChat, side } = await openBeside(page, 'staged');

    await side.getByRole('button', { name: 'Attach and tools' }).click();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Upload to Provider', exact: true }).click(),
    ]);
    await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes('/api/files') && response.request().method() === 'POST',
        { timeout: 30_000 },
      ),
      chooser.setFiles({
        name: 'comes-along.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Staged beside the chat.\n'),
      }),
    ]);
    await expect(side.getByText('comes-along.txt')).toBeVisible();

    await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();

    /** Staged once in main chat's composer, for the conversation it was staged for. */
    await expect(page).toHaveURL(new URL(earlierUrl).pathname);
    const main = page.locator('main form').first();
    await expect(main.getByText('comes-along.txt')).toHaveCount(1);
  });
}

test('words written while a reply runs go with the conversation to the main chat @scenario:side-chat-composer-running-draft-follows-the-conversation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { earlierUrl, sideChat, field } = await openBeside(page, 'running');

  await field.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${uniqueLabel('running')}`);
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText('chunk-005', { timeout: 30_000 });
  await field.click();
  await page.keyboard.type('thought of while it ran');

  await sideChat.getByRole('button', { name: 'Open as the main chat' }).click();

  /** Main chat attaches to the reply still running, and the words stay in its composer. */
  await expect(page).toHaveURL(new URL(earlierUrl).pathname);
  const composer = page
    .locator('main form')
    .first()
    .getByRole('textbox', { name: 'Message input' });
  await expect(composer).toHaveValue('thought of while it ran');
  await expect(messagesView(page)).toContainText('chunk-159', { timeout: 90_000 });
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
  await expect(composer).toHaveValue('thought of while it ran');
});

test('a side chat opened again while its reply runs still has the words written in it @scenario:side-chat-composer-running-draft-survives-reopening', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { earlierUrl, sideChat, field } = await openBeside(page, 'reopen');

  await field.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${uniqueLabel('reopen')}`);
  await page.keyboard.press('Enter');
  await expect(sideChat).toContainText('chunk-005', { timeout: 30_000 });
  await field.click();
  await page.keyboard.type('picked up where I left it');
  await sideChat.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);

  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const reopened = page.getByRole('region', { name: 'Side chat' });
  const again = reopened.getByRole('textbox', { name: 'Message input' });

  /**
   * Still running, and the words are in the field: with something written, the send control
   * is the one that acts on the reply in flight. They are still there once it ends.
   */
  const duringRun = reopened.getByTestId('during-run-send-button');
  await expect(duringRun).toBeVisible({ timeout: 30_000 });
  await expect(again).toHaveValue('picked up where I left it');
  await expect(reopened).toContainText('chunk-159', { timeout: 90_000 });
  await expect(duringRun).toHaveCount(0);
  await expect(again).toHaveValue('picked up where I left it');
});

/** The gauge's used-token count, read from its accessible name. */
const usedTokens = (label: string | null): number => {
  const match = /Context window: ([\d.,]+)(K?) of/.exec(label ?? '');
  if (match == null) {
    throw new Error(`The gauge does not say how much is used: ${label}`);
  }
  return Number(match[1].replace(/,/g, '')) * (match[2] === 'K' ? 1000 : 1);
};

test('the gauge beside the chat counts a reply as it is written @scenario:side-chat-composer-gauge-follows-the-reply', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { sideChat, side, field } = await openBeside(page, 'gauge');
  const gauge = side.getByTestId('token-usage');

  await field.click();
  await page.keyboard.type(`E2E_SLOW_REPLY:${uniqueLabel('measured')}`);
  await page.keyboard.press('Enter');

  /**
   * Two readings while the reply is still running, as main chat's gauge gives them: the count
   * the server sends as the reply starts, plus what has arrived since. No waiting between that
   * could run past the end of the reply, where the count settles whatever it did meanwhile.
   */
  const stop = side.getByRole('button', { name: 'Stop generating' });
  await expect(sideChat).toContainText('chunk-020', { timeout: 30_000 });
  const early = usedTokens(await gauge.getAttribute('aria-label'));
  await expect(sideChat).toContainText('chunk-100', { timeout: 60_000 });
  const late = usedTokens(await gauge.getAttribute('aria-label'));
  await expect(stop).toBeVisible();
  expect(late).toBeGreaterThan(early);
});

/** Opens the side composer's `@` list, and gives its field and the rows it offers. */
async function openSideMention(page: Page, sideChat: Locator, field: Locator) {
  await field.click();
  await field.press('@');
  const combobox = sideChat.getByRole('combobox', { name: /Mention/ });
  await expect(combobox).toBeFocused();
  const listbox = page.locator(`[id="${await combobox.getAttribute('aria-controls')}"]`);
  await expect(listbox.getByRole('option').first()).toBeVisible();
  return { combobox, options: listbox.getByRole('option') };
}

test('a model picked with @ in a side chat changes that conversation, and nothing of the chat on screen @scenario:side-chat-mention-switches-the-model-in-place', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { earlierUrl, sideChat, main, field } = await openBeside(page, 'mention');
  const mainUrl = page.url();
  const conversationId = new URL(earlierUrl).pathname.split('/').pop() ?? '';
  const label = uniqueLabel('mentioned');
  const other = MOCK_ENDPOINTS[1];
  await expect(sideChat).toContainText('@ for models');

  const { combobox, options } = await openSideMention(page, sideChat, field);
  await combobox.fill(other.label);
  await expect(options).toHaveCount(1);
  await options.first().click();

  /** The list closes on the side composer, which now writes to the model picked. */
  await expect(page.getByRole('combobox', { name: /Mention/ })).toHaveCount(0);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await expect(field).toHaveAttribute('placeholder', new RegExp(other.label));
  /** The chat on screen is where it was, on the model it had. */
  expect(page.url()).toBe(mainUrl);
  await expect(modelSelectorTrigger(page)).toContainText(MOCK_ENDPOINTS[0].label);
  await expect(main.getByRole('textbox', { name: 'Message input' })).toHaveAttribute(
    'placeholder',
    new RegExp(MOCK_ENDPOINTS[0].label),
  );

  /** The next turn goes to the same conversation, on that model. */
  const started = page.waitForRequest((request) => isStart(request.url(), request.method()));
  await field.click();
  await page.keyboard.type(replyPrompt(label));
  await page.keyboard.press('Enter');
  const request = await started;
  expect(decodeURIComponent(new URL(request.url()).pathname.split('/').pop() ?? '')).toBe(
    other.label,
  );
  expect(request.postDataJSON()).toMatchObject({ conversationId, model: other.model });
  const turns = sideChat.locator('.message-render');
  await expect(turns).toHaveCount(4, { timeout: 30_000 });
  await expect(turns.nth(3)).toContainText(replyText(label), { timeout: 30_000 });
  await expect(turns.nth(3)).toContainText(other.label);
  await expect(messagesView(page).locator('.message-render')).toHaveCount(2);
  expect(page.url()).toBe(mainUrl);

  /** It is the conversation's model from then on, wherever it is opened. */
  await page.goto(earlierUrl, { timeout: 30_000 });
  await expect(messagesView(page).locator('.message-render')).toHaveCount(4, { timeout: 30_000 });
  await expect(modelSelectorTrigger(page)).toContainText(other.label);
});

test('@ in a side chat offers only what changes its conversation in place @scenario:side-chat-mention-offers-only-in-place-choices', async ({
  page,
}) => {
  test.setTimeout(150_000);
  /** With modular chat off, another endpoint starts another conversation, which a side chat cannot. */
  await page.addInitScript(() => {
    localStorage.setItem('modularChat', JSON.stringify(false));
  });
  const { sideChat, field } = await openBeside(page, 'in-place');

  const { combobox, options } = await openSideMention(page, sideChat, field);
  await combobox.fill('Mock Provider');
  await expect(options.filter({ hasText: MOCK_ENDPOINTS[0].label }).first()).toBeVisible();
  await expect(options.filter({ hasText: MOCK_ENDPOINTS[1].label })).toHaveCount(0);
  await combobox.press('Escape');
  await expect(field).toBeFocused();

  /** Main chat's own list still offers it: there it starts a new conversation. */
  const mainField = page
    .locator('main form')
    .first()
    .getByRole('textbox', { name: 'Message input' });
  await mainField.click();
  await mainField.press('@');
  const mainCombobox = page.getByRole('combobox', { name: /Mention/ });
  await expect(mainCombobox).toBeFocused();
  await mainCombobox.fill('Mock Provider');
  const mainOptions = page
    .locator(`[id="${await mainCombobox.getAttribute('aria-controls')}"]`)
    .getByRole('option');
  await expect(mainOptions.filter({ hasText: MOCK_ENDPOINTS[1].label }).first()).toBeVisible();
});
