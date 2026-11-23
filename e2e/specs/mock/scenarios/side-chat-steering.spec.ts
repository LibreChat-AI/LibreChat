import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  replyText,
  replyPrompt,
  requestJson,
  messagesView,
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  getAccessToken,
  MOCK_REPLY_TEXT,
  conversationRow,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, openAgentBuilder, uniqueAgentName } from '../agents.helpers';
import { openChatHistory } from './sidebar';

/**
 * What the reader does to a reply in flight in a conversation open beside the chat is what they
 * do in main chat: a message queued behind it goes out when it ends, a steer joins it where the
 * run takes one and becomes the next message where it does not, an interrupt continues it, and
 * a Stop leaves the queue for them to send. All of it is that conversation's: the chat on screen
 * gains nothing.
 */
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

/** The endpoint whose runs call a tool, which is where a run takes a steer. */
const PROVIDER_C = { label: 'Mock Provider C', model: 'mock-model-c' };
const MCP_SERVER_TITLE = 'E2E Memory';
const SLOW_REPLY_LAST_CHUNK = 'chunk-159';

const uniqueLabel = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const isSteer = (response: Response): boolean =>
  response.request().method() === 'POST' &&
  new URL(response.url()).pathname === '/api/agents/chat/steer';

async function startChat(
  page: Page,
  label: string,
  {
    provider = MOCK_ENDPOINTS[0],
    tools = false,
    agent,
  }: { provider?: (typeof MOCK_ENDPOINTS)[number]; tools?: boolean; agent?: string } = {},
): Promise<string> {
  if (agent == null) {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, provider);
  } else {
    /** A saved agent's conversation: its queued turns are the server's to start. */
    const form = await openAgentBuilder(page);
    await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await page.getByRole('option', { name: agent }).click();
    await expect(form.getByLabel('Agent name')).toHaveValue(agent);
    await form.getByRole('button', { name: 'Select Agent' }).click();
  }
  if (tools) {
    await page.getByRole('button', { name: 'Attach and tools' }).click();
    const server = page
      .getByRole('dialog', { name: 'Attach and tools' })
      .getByRole('button', { name: new RegExp(`^${MCP_SERVER_TITLE}\\b`) });
    await server.click();
    await expect(server).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
  }
  const response = await sendMessageAndWaitForCompletion(page, replyPrompt(label));
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(replyText(label))).toBeVisible();
  return page.url();
}

/** Two conversations: the first open beside the second, which stays on screen. */
async function openBeside(
  page: Page,
  prefix: string,
  earlierChat?: Parameters<typeof startChat>[2],
) {
  const earlier = uniqueLabel(`${prefix}-earlier`);
  const earlierUrl = await startChat(page, earlier, earlierChat);
  await startChat(page, uniqueLabel(`${prefix}-current`));
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const sideChat = page.getByRole('region', { name: 'Side chat' });
  await expect(sideChat).toContainText(replyText(earlier), { timeout: 30_000 });
  const side = sideChat.locator('form');
  const field = sideChat.getByRole('textbox', { name: 'Message input' });
  return {
    earlierUrl,
    sideChat,
    side,
    field,
    turns: sideChat.locator('.message-render'),
    mainTurns: messagesView(page).locator('.message-render'),
    queued: sideChat.getByTestId('queued-message-row'),
    waiting: sideChat.getByTestId('pending-steers').getByRole('listitem'),
    taken: sideChat.locator('[data-testid="steer-part"]:not([data-testid="pending-steers"] *)'),
    /** Starts a turn from the side composer. */
    send: async (text: string) => {
      await field.click();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    },
    /** Writes in the side composer while its reply is being written. */
    write: async (text: string) => {
      await field.click();
      await page.keyboard.type(text);
      await expect(side.getByTestId('during-run-send-button')).toBeVisible({ timeout: 5_000 });
    },
  };
}

/** Enter steers in these scenarios, as in main chat's; Ctrl/Cmd+Enter then queues. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('duringRunDefaultAction', JSON.stringify('steer'));
  });
});

test('a message queued behind a side chat’s reply is sent when the reply ends @scenario:side-chat-queued-message-follows-the-reply', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { sideChat, turns, mainTurns, queued, waiting, send, write } = await openBeside(
    page,
    'queue',
  );
  const label = uniqueLabel('queued');
  const followUp = `Queued behind the reply ${label}`;

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(followUp);
  await page.keyboard.press('ControlOrMeta+Enter');

  /** It waits in the side composer's queue, not in the reply and not in main chat's composer. */
  await expect(queued.filter({ hasText: followUp })).toHaveCount(1);
  await expect(page.getByTestId('queued-message-row')).toHaveCount(1);
  await expect(waiting).toHaveCount(0);

  /** The reply runs to its end, and the queued message is the conversation's next turn. */
  await expect(queued).toHaveCount(0, { timeout: 90_000 });
  await expect(turns).toHaveCount(6, { timeout: 30_000 });
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK);
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(turns.nth(4).locator('.user-turn')).toBeVisible();
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
  await expect(mainTurns).toHaveCount(2);
});

test('a message written before a side chat’s reply sends its first frame is queued behind it @scenario:side-chat-queues-before-the-first-frame', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { sideChat, side, turns, mainTurns, queued, field, send } = await openBeside(page, 'early');
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  const label = uniqueLabel('early');
  const followUp = `Queued before the first frame ${label}`;
  /** The server takes the turn at once; its stream is slow to open, as one behind a proxy can be. */
  let release: (() => void) | undefined;
  let held = false;
  await page.route(
    (url) => url.pathname === `/api/agents/chat/stream/${conversationId}`,
    async (route) => {
      if (!held) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await route.continue();
    },
  );

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect.poll(() => held).toBe(true);

  /**
   * The run is the conversation's from the moment the server has it, so what the reader writes
   * meanwhile is offered the run's own actions: here Enter steers, and Ctrl/Cmd+Enter queues.
   */
  await field.click();
  await page.keyboard.type(followUp);
  await expect(side.getByTestId('during-run-send-button')).toHaveAttribute(
    'data-during-run-action',
    'steer',
    { timeout: 5_000 },
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText(followUp);
  await expect(field).toHaveValue('');
  await expect(turns).toHaveCount(4);

  /** Once the stream opens the reply is read to its end, and the queued message follows it. */
  release?.();
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
  await expect(turns).toHaveCount(6, { timeout: 60_000 });
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(queued).toHaveCount(0);
  await expect(mainTurns).toHaveCount(2);
});

test('a steer sent from a side chat joins its reply where the run takes it @scenario:side-chat-steer-joins-the-reply', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sideChat, side, turns, mainTurns, queued, waiting, taken, send, write } =
    await openBeside(page, 'steer', { provider: PROVIDER_C, tools: true });
  const label = uniqueLabel('steered');
  const steer = `Steer into the reply ${label}`;

  /** A preamble, a tool call (where a steer is taken), then the rest of the reply. */
  await send(`E2E_STEER_TOOL_REPLY:${label}`);
  await write(steer);
  await expect(side.getByTestId('during-run-send-button')).toHaveAttribute(
    'data-during-run-action',
    'steer',
  );
  const [accepted] = await Promise.all([
    page.waitForResponse(isSteer, { timeout: 15_000 }),
    page.keyboard.press('Enter'),
  ]);
  expect(accepted.status()).toBe(202);

  /** Shown waiting at the end of the side chat's list until the run takes it. */
  await expect(waiting.filter({ hasText: steer })).toHaveCount(1, { timeout: 10_000 });
  await expect(taken).toHaveCount(0);

  await expect(taken.filter({ hasText: steer })).toHaveCount(1, { timeout: 60_000 });
  await expect(waiting).toHaveCount(0);
  await expect(sideChat.getByText(`E2E steer tool reply done ${label}`)).toBeVisible({
    timeout: 60_000,
  });
  await expect(sideChat.getByText(`[steers-seen=1] ${steer}`)).toBeVisible({ timeout: 30_000 });

  /** It stays inside the reply: no turn of its own, nothing left queued, main chat untouched. */
  await expect(turns).toHaveCount(4);
  await expect(taken.filter({ hasText: steer })).toHaveCount(1);
  await expect(queued).toHaveCount(0);
  await expect(mainTurns).toHaveCount(2);
});

test('a steer a side chat’s reply never took is sent as its next message @scenario:side-chat-steer-not-taken-follows-the-reply', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { sideChat, turns, mainTurns, queued, waiting, taken, send, write } = await openBeside(
    page,
    'late',
  );
  const label = uniqueLabel('late');
  const steer = `Steer with nowhere to land ${label}`;

  /** A reply with no tool call has no point at which a run takes a steer. */
  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(steer);
  const [accepted] = await Promise.all([
    page.waitForResponse(isSteer, { timeout: 15_000 }),
    page.keyboard.press('Enter'),
  ]);
  expect(accepted.status()).toBe(202);
  await expect(waiting.filter({ hasText: steer })).toHaveCount(1, { timeout: 10_000 });

  /** The reply ends without it, and the words go out as the conversation's next turn. */
  await expect(turns).toHaveCount(6, { timeout: 90_000 });
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK);
  await expect(turns.nth(4)).toContainText(steer);
  await expect(turns.nth(4).locator('.user-turn')).toBeVisible();
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
  await expect(waiting).toHaveCount(0);
  await expect(taken).toHaveCount(0);
  await expect(queued).toHaveCount(0);
  await expect(mainTurns).toHaveCount(2);
});

test('an interrupt from a side chat keeps what was written and continues the reply @scenario:side-chat-interrupt-continues-the-reply', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { sideChat, turns, mainTurns, queued, taken, send, write } = await openBeside(
    page,
    'interrupt',
  );
  const label = uniqueLabel('interrupted');
  const words = `Interrupt with this ${label}`;

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(words);
  await page.keyboard.press('Alt+Enter');

  await expect(taken.filter({ hasText: words })).toHaveCount(1, { timeout: 30_000 });
  await expect(sideChat.getByText(`[steers-seen=1] ${words}`)).toBeVisible({ timeout: 30_000 });
  await expect(sideChat.getByText(`E2E slow reply continued ${label}`)).toBeVisible({
    timeout: 30_000,
  });

  /** One reply, cut where the interrupt landed and carried on: no turn of its own. */
  await expect(turns).toHaveCount(4);
  await expect(sideChat).toContainText('chunk-010');
  await expect(sideChat.getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
  await expect(queued).toHaveCount(0);
  await expect(mainTurns).toHaveCount(2);
});

test('stopping a side chat’s reply leaves what was queued behind it for the reader to send @scenario:side-chat-stop-keeps-the-queue', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { sideChat, side, turns, queued, send, write } = await openBeside(page, 'stopped');
  const label = uniqueLabel('stopped');
  const followUp = `Queued behind a stop ${label}`;

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(followUp);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued.filter({ hasText: followUp })).toHaveCount(1);

  await side.getByRole('button', { name: 'Stop generating' }).click();
  await expect(side.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 30_000,
  });

  /** A stop is not an end the queue goes out on: the row waits, with its own Send. */
  await expect(sideChat.getByText(SLOW_REPLY_LAST_CHUNK)).toHaveCount(0);
  await expect(queued.filter({ hasText: followUp })).toHaveCount(1);
  await expect(turns).toHaveCount(4);

  await queued.getByRole('button', { name: 'Send now' }).click();
  await expect(queued).toHaveCount(0, { timeout: 30_000 });
  await expect(turns).toHaveCount(6, { timeout: 30_000 });
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
});

/**
 * Whether the server reports a conversation's run as active, or `null` while it answers 503
 * `SERVER_NOT_READY`: it does so, with `Retry-After`, whenever it cannot vouch for the run's state
 * yet, and a caller is meant to ask again.
 */
async function runActive(
  page: Page,
  token: string,
  conversationId: string,
): Promise<boolean | null> {
  return page.evaluate(
    async ({ path, accessToken }) => {
      const response = await fetch(path, {
        credentials: 'include',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 503) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Expected GET ${path} to return 2xx, got ${response.status}`);
      }
      const status = (await response.json()) as { active?: boolean };
      return status.active === true;
    },
    { path: `/api/agents/chat/status/${conversationId}`, accessToken: token },
  );
}

test('a message queued in a side chat is sent when the panel is opened again after its reply ended unseen @scenario:side-chat-queue-survives-a-closed-panel', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { earlierUrl, sideChat, turns, queued, send, write } = await openBeside(page, 'closed');
  const label = uniqueLabel('unseen');
  const followUp = `Queued, then the panel closed ${label}`;
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  /** Every generation the page starts for the side conversation. */
  const starts: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'POST' || !/\/api\/agents\/chat\/[^/]+$/.test(pathname)) {
      return;
    }
    const body = request.postDataJSON() as { conversationId?: string; text?: string } | null;
    if (!pathname.endsWith('/abort') && body?.conversationId === conversationId) {
      starts.push(body.text ?? '');
    }
  });

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(followUp);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued.filter({ hasText: followUp })).toHaveCount(1);

  /** Closed while the reply is still being written: no one is left to hear it end. */
  await sideChat.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);

  /** It runs to its end on the server, and nothing is sent meanwhile. */
  const token = await getAccessToken(page);
  await expect
    .poll(() => runActive(page, token, conversationId), { timeout: 90_000, intervals: [1_000] })
    .toBe(false);
  expect(starts).toHaveLength(1);

  /** Opened again: its reply is read from what the server stored, and the queue goes out. */
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  const reopened = page.getByRole('region', { name: 'Side chat' });
  await expect(reopened).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 30_000 });

  await expect(turns).toHaveCount(6, { timeout: 60_000 });
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(turns.nth(4).locator('.user-turn')).toBeVisible();
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
  await expect(queued).toHaveCount(0);
  /** Sent once: the reply it waited on, then the queued message. */
  expect(starts).toEqual([`E2E_SLOW_REPLY:${label}`, followUp]);
});

/**
 * Cuts a stream of the conversation off, once `armed` says to: the whole response is taken from
 * the server and handed to the page without its ending, from the frame that holds `before` on
 * (its last frame, unless told otherwise). To the page that is a connection that dropped, after
 * the run has in fact finished.
 */
async function cutStream(
  page: Page,
  conversationId: string,
  armed: () => boolean,
  before = '"final":true',
) {
  let cut = false;
  await page.route(
    (url) => url.pathname === `/api/agents/chat/stream/${conversationId}`,
    async (route) => {
      if (cut || !armed()) {
        await route.continue();
        return;
      }
      cut = true;
      const upstream = await route.fetch({ timeout: 90_000 });
      const body = await upstream.text();
      const ending = body.indexOf(before);
      expect(ending).toBeGreaterThan(0);
      /** Back to the start of the frame that carries it, which is dropped whole with all after it. */
      const frame = body.lastIndexOf('\n\n', ending);
      await route.fulfill({ response: upstream, body: body.slice(0, frame + 2) });
    },
  );
  return () => cut;
}

test('a side chat whose stream drops reads the reply back and takes the next turn @scenario:side-chat-dropped-stream-is-read-back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sideChat, side, turns, mainTurns, send } = await openBeside(page, 'dropped');
  const label = uniqueLabel('dropped');
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  /** Cut half way through, so the second half of the reply can only come from what is stored. */
  const wasCut = await cutStream(page, conversationId, () => true, 'chunk-080');

  await send(`E2E_SLOW_REPLY:${label}`);

  /**
   * The stream ends half way, with no last frame. The side chat looks for the run again, finds
   * it over, and reads what the server stored: the whole reply, once, under the message sent.
   */
  await expect(turns.nth(3)).toContainText('chunk-079', { timeout: 120_000 });
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 60_000 });
  expect(wasCut()).toBe(true);
  await expect(side.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(turns).toHaveCount(4);
  await expect(turns.nth(2)).toContainText(`E2E_SLOW_REPLY:${label}`);
  await expect(turns.nth(3)).not.toContainText(/\d+\s*\/\s*\d+/);

  /** Nothing is left running in its name: the conversation takes the next message. */
  const followUp = uniqueLabel('after-drop');
  await send(replyPrompt(followUp));
  await expect(turns).toHaveCount(6, { timeout: 30_000 });
  await expect(turns.nth(5)).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(mainTurns).toHaveCount(2);
});

test('a side chat’s reply whose stream a gateway answers on opening is followed, and never shown as failed @scenario:side-chat-unopened-stream-is-followed', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { sideChat, side, turns, mainTurns, send } = await openBeside(page, 'unopened');
  const label = uniqueLabel('unopened');
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  /** The server takes the turn; the first two requests for its stream are answered by a gateway. */
  const asked: number[] = [];
  await page.route(
    (url) => url.pathname === `/api/agents/chat/stream/${conversationId}`,
    async (route) => {
      asked.push(Date.now());
      if (asked.length > 2) {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    },
  );
  /** Whatever the panel shows on the way is kept, since a failure shown and then replaced is one. */
  await sideChat.evaluate((region) => {
    const shown = new Set<string>();
    const note = () => {
      for (const row of region.querySelectorAll('.message-render')) {
        shown.add(row.textContent ?? '');
      }
    };
    new MutationObserver(note).observe(region, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    Object.assign(window, { shownInSideChat: shown });
  });

  await send(`E2E_SLOW_REPLY:${label}`);

  /** The run is found again where it is, and read as it is written: not only once it is over. */
  await expect(turns.nth(3)).toContainText('chunk-040', { timeout: 60_000 });
  await expect(side.getByRole('button', { name: 'Stop generating' })).toBeVisible();
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
  await expect(turns).toHaveCount(4);
  /**
   * The stream was asked for again at once, as one that dropped is: a turn taken for failed is
   * only found again by the next look at what is running, seconds later. And no row ever said
   * the reply failed.
   */
  expect(asked.length).toBeGreaterThanOrEqual(3);
  expect(asked[1] - asked[0]).toBeLessThan(3_000);
  const failures = await page.evaluate(() =>
    [...(window as unknown as { shownInSideChat: Set<string> }).shownInSideChat].filter((text) =>
      /could not complete|error connecting|failed|try refreshing/i.test(text),
    ),
  );
  expect(failures).toEqual([]);

  /** It ended as a reply does: the conversation takes the next message. */
  const followUp = uniqueLabel('after-unopened');
  await send(replyPrompt(followUp));
  await expect(turns).toHaveCount(6, { timeout: 30_000 });
  await expect(turns.nth(5)).toContainText(replyText(followUp), { timeout: 30_000 });
  await expect(mainTurns).toHaveCount(2);
});

test('a side chat’s reply that cannot be reached through every retry is settled by the server’s word, and its queue sent @scenario:side-chat-unreachable-run-is-settled-at-the-retry-limit', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { sideChat, side, turns, mainTurns, queued, field, send } = await openBeside(
    page,
    'unreachable',
  );
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  const label = uniqueLabel('unreachable');
  const followUp = `Queued behind an unreachable reply ${label}`;
  /** The turn's own request for its stream and the five retries after it, and one retry more. */
  const attempts = 7;
  /** Every request for the reply's stream is answered by a gateway, for as long as it is retried. */
  const refused: number[] = [];
  await page.route(
    (url) => url.pathname === `/api/agents/chat/stream/${conversationId}`,
    async (route) => {
      if (refused.length >= attempts) {
        await route.continue();
        return;
      }
      refused.push(Date.now());
      await route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>Bad Gateway</h1>' });
    },
  );
  /**
   * The reply here is over well before the retries are, and a side chat that learns so stops
   * retrying. So the status route goes on saying what it said while the reply ran until the
   * last retry has been refused: a reply that ran through all of them and ended by the last.
   */
  let running: string | undefined;
  await page.route(
    (url) => url.pathname === `/api/agents/chat/status/${conversationId}`,
    async (route) => {
      const upstream = await route.fetch();
      const body = await upstream.text();
      if (body.includes('"active":true')) {
        running = body;
      }
      const held = running != null && refused.length < attempts;
      await route.fulfill({ response: upstream, body: held ? running : body });
    },
  );
  await sideChat.evaluate((region) => {
    const shown = new Set<string>();
    new MutationObserver(() => {
      for (const row of region.querySelectorAll('.message-render')) {
        shown.add(row.textContent ?? '');
      }
    }).observe(region, { subtree: true, childList: true, characterData: true });
    Object.assign(window, { shownInSideChat: shown });
  });

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(side.getByRole('button', { name: 'Stop generating' })).toBeVisible({
    timeout: 30_000,
  });
  await field.click();
  await page.keyboard.type(followUp);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued).toHaveCount(1);

  /**
   * It is waited for through every retry, as running. After the last one the server is asked
   * what became of it: it completed, so what it left is read, and what was queued behind it is
   * the conversation's next turn.
   */
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
  await expect(turns).toHaveCount(6, { timeout: 30_000 });
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
  await expect(queued).toHaveCount(0);
  await expect(mainTurns).toHaveCount(2);

  /** Asked for again after 1, 2, 4, 8 and 16 seconds, and no row ever said the reply failed. */
  expect(refused).toHaveLength(attempts);
  const waits = refused.slice(1).map((at, index) => at - refused[index]);
  expect(waits[3]).toBeGreaterThan(3_000);
  expect(waits[4]).toBeGreaterThan(6_500);
  expect(waits[5]).toBeGreaterThan(13_000);
  const failures = await page.evaluate(() =>
    [...(window as unknown as { shownInSideChat: Set<string> }).shownInSideChat].filter((text) =>
      /could not complete|error connecting|failed|try refreshing/i.test(text),
    ),
  );
  expect(failures).toEqual([]);
});

test('a queue behind a reply the panel was closed on is sent when that reply is then lost and found whole @scenario:side-chat-lost-remembered-run-sends-the-queue', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { earlierUrl, sideChat, turns, queued, send, write } = await openBeside(page, 'lost');
  const label = uniqueLabel('lost');
  const followUp = `Queued, closed, then lost ${label}`;
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  let armed = false;
  const wasCut = await cutStream(page, conversationId, () => armed);

  await send(`E2E_SLOW_REPLY:${label}`);
  await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
  await write(followUp);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued.filter({ hasText: followUp })).toHaveCount(1);

  /** Closed while it is being written, and opened again while it still is: the stream it then follows is the one cut. */
  await sideChat.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toHaveCount(0);
  armed = true;
  await openChatHistory(page);
  const row = conversationRow(page, earlierUrl);
  await row.hover();
  await row.getByRole('button', { name: 'Conversation Menu Options' }).click();
  await page.getByRole('menuitem', { name: 'Open beside chat' }).click();
  await expect(page.getByRole('region', { name: 'Side chat' })).toBeVisible();

  /**
   * Its end was never heard. But the run had been remembered when the panel closed, so its end
   * is read from the reply the server stored, and the queued message goes out behind it.
   */
  await expect(turns).toHaveCount(6, { timeout: 150_000 });
  expect(wasCut()).toBe(true);
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK);
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
  await expect(queued).toHaveCount(0);
});

test('a reply started in another tab is followed in the side chat that has its conversation open @scenario:side-chat-follows-a-run-from-another-tab', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000);
  const { earlierUrl, sideChat, turns, side } = await openBeside(page, 'elsewhere');
  const label = uniqueLabel('elsewhere');
  await expect(turns).toHaveCount(2);

  /** The same reader, in another tab, has the conversation open as its main chat and sends a turn. */
  const other = await context.newPage();
  await other.goto(earlierUrl, { timeout: 30_000 });
  const elsewhere = other.getByRole('textbox', { name: 'Message input' });
  await expect(messagesView(other).locator('.message-render')).toHaveCount(2, { timeout: 30_000 });
  await elsewhere.click();
  await other.keyboard.type(`E2E_SLOW_REPLY:${label}`);
  await other.keyboard.press('Enter');
  await expect(messagesView(other)).toContainText('chunk-005', { timeout: 30_000 });

  /** Back in the first tab, the list of running generations names the conversation. */
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });

  /** The side chat follows a run it did not start: its message, the reply as it is written, and its end. */
  await expect(turns).toHaveCount(4, { timeout: 60_000 });
  await expect(turns.nth(2)).toContainText(`E2E_SLOW_REPLY:${label}`);
  await expect(side.getByRole('button', { name: 'Stop generating' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 120_000 });
  await expect(side.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(sideChat.locator('.message-render')).toHaveCount(4);
  await other.close();
});

test('a reply started in another tab takes a queued message in the side chat before its stream opens there @scenario:side-chat-queues-behind-a-run-found-running', async ({
  page,
  context,
}) => {
  test.setTimeout(200_000);
  const { earlierUrl, sideChat, side, turns, field, queued } = await openBeside(page, 'found');
  const conversationId = (await sideChat.getAttribute('data-side-chat')) ?? '';
  const label = uniqueLabel('found');
  const followUp = `Queued behind a run found running ${label}`;
  /** In this tab the stream of the conversation is slow to open, once. */
  let release: (() => void) | undefined;
  let asked = 0;
  await page.route(
    (url) => url.pathname === `/api/agents/chat/stream/${conversationId}`,
    async (route) => {
      asked += 1;
      if (asked === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await route.continue();
    },
  );

  /** The same reader starts a reply in the conversation from another tab. */
  const other = await context.newPage();
  await other.goto(earlierUrl, { timeout: 30_000 });
  await expect(messagesView(other).locator('.message-render')).toHaveCount(2, { timeout: 30_000 });
  await other.getByRole('textbox', { name: 'Message input' }).click();
  await other.keyboard.type(`E2E_SLOW_REPLY:${label}`);
  await other.keyboard.press('Enter');
  await expect(messagesView(other)).toContainText('chunk-005', { timeout: 30_000 });

  /** Back here the side chat finds it running, and asks for its stream. */
  await page.bringToFront();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => asked, { timeout: 30_000 }).toBe(1);

  /**
   * Nothing of the reply has arrived, and the run is already the conversation's: what is
   * written is offered the run's own actions, and Ctrl/Cmd+Enter queues it behind the reply.
   */
  await expect(turns).toHaveCount(2);
  await field.click();
  await page.keyboard.type(followUp);
  await expect(side.getByTestId('during-run-send-button')).toHaveAttribute(
    'data-during-run-action',
    'steer',
    { timeout: 5_000 },
  );
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText(followUp);
  await expect(field).toHaveValue('');

  /** Once the stream opens the reply is read to its end, and the queued message follows it. */
  release?.();
  await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK, { timeout: 90_000 });
  await expect(turns).toHaveCount(6, { timeout: 60_000 });
  await expect(turns.nth(4)).toContainText(followUp);
  await expect(queued).toHaveCount(0);
  await other.close();
});

test('a message queued behind a saved agent’s reply in a side chat is started by the server and followed there @scenario:side-chat-server-queued-turn-is-followed', async ({
  page,
}) => {
  test.setTimeout(180_000);
  let agentId: string | undefined;
  try {
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    const agent = await requestJson<AgentDetail>(page, {
      path: '/api/agents',
      token: await getAccessToken(page),
      method: 'POST',
      body: {
        name: uniqueAgentName('E2E Side Queue Agent'),
        description: 'Playwright verification of a queued turn in a side chat.',
        instructions: 'Follow the deterministic end-to-end request exactly.',
        provider: MOCK_ENDPOINTS[0].label,
        model: MOCK_ENDPOINTS[0].model,
      },
    });
    agentId = agent.id;
    const { sideChat, side, turns, mainTurns, queued, send, write } = await openBeside(
      page,
      'agent-queue',
      { agent: agent.name },
    );
    const label = uniqueLabel('agent-queued');
    const followUp = `Queued for the server ${label}`;

    await send(`E2E_SLOW_REPLY:${label}`);
    await expect(sideChat).toContainText('chunk-010', { timeout: 30_000 });
    await write(followUp);
    /** The queue of an agent's conversation is kept by the server, which starts the turn. */
    const [enqueued] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/agents/chat/queued-turns',
        { timeout: 10_000 },
      ),
      page.keyboard.press('ControlOrMeta+Enter'),
    ]);
    expect(enqueued.ok()).toBeTruthy();
    await expect(queued.filter({ hasText: followUp })).toHaveCount(1);

    /**
     * The reply ends, the server starts the queued turn, and the side chat follows a run it did
     * not start: the turn and its reply arrive, with one copy of the words and nothing waiting.
     */
    await expect(turns).toHaveCount(6, { timeout: 120_000 });
    await expect(turns.nth(3)).toContainText(SLOW_REPLY_LAST_CHUNK);
    await expect(turns.nth(4)).toContainText(followUp);
    await expect(turns.nth(4).locator('.user-turn')).toBeVisible();
    await expect(turns.nth(5)).toContainText(MOCK_REPLY_TEXT, { timeout: 30_000 });
    await expect(turns.filter({ hasText: followUp })).toHaveCount(1);
    await expect(sideChat.getByTestId('pending-turn')).toHaveCount(0);
    await expect(queued).toHaveCount(0);
    await expect(side.getByRole('button', { name: 'Stop generating' })).toHaveCount(0);
    await expect(mainTurns).toHaveCount(2);
  } finally {
    await cleanupAgent(page, agentId);
  }
});
