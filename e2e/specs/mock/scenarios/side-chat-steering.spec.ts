import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken, MOCK_REPLY_TEXT, conversationRow } from '../helpers';
import { openChatHistory } from './sidebar';
import {
  PROVIDER_C,
  SLOW_REPLY_LAST_CHUNK,
  uniqueLabel,
  isSteer,
  openBeside,
  steerOnEnter,
  WIDE,
} from './side-chat.helpers';

/**
 * What the reader does to a reply in flight in a conversation open beside the chat is what they
 * do in main chat: a message queued behind it goes out when it ends, a steer joins it where the
 * run takes one and becomes the next message where it does not, an interrupt continues it, and
 * a Stop leaves the queue for them to send. All of it is that conversation's: the chat on screen
 * gains nothing.
 */
test.use(WIDE);

test.beforeEach(({ page }) => steerOnEnter(page));

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
