import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint, sendMessage } from '../helpers';
import { probeStyle } from './style.helpers';

/** The fork and feedback actions `@librechat/chat` now renders on a reply, with the fork request
 *  and the viewer's fork defaults supplied by the app's messages host. */

const uniqueLabel = (name: string) => `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const messagesView = (page: Page) => page.getByTestId('messages-view');
const messageRender = (page: Page, text: string) =>
  page.locator('.message-render').filter({ hasText: text }).last();

async function replyInNewChat(page: Page, label: string) {
  const reply = `E2E reply ${label}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  const response = await sendMessage(page, `E2E_REPLY:${label}`);
  expect(response.ok()).toBeTruthy();
  await expect(messagesView(page).getByText(reply)).toBeVisible({ timeout: 30000 });
  await expect(page).toHaveURL(/\/c\/(?!new)[^/]+$/);
  return reply;
}

test.describe('fork and feedback actions', () => {
  test.setTimeout(120000);

  test('forking the visible branch opens the copy @scenario:fork-visible-branch-opens-copy', async ({
    page,
  }) => {
    const reply = await replyInNewChat(page, uniqueLabel('actions-fork'));
    const sourceUrl = page.url();

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByRole('button', { name: 'Open Fork Menu' }).click();
    const popover = page.getByRole('dialog', { name: 'Fork conversation' });
    await popover.getByRole('button', { name: 'More options' }).click();
    await popover.getByRole('radio', { name: 'Visible', exact: true }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/api/convos/fork'),
        { timeout: 30000 },
      ),
      popover.getByRole('button', { name: 'Fork', exact: true }).click(),
    ]);
    expect(response.ok()).toBeTruthy();
    const { conversation } = (await response.json()) as {
      conversation: { conversationId: string };
    };

    await expect(page).toHaveURL(new RegExp(`/c/${conversation.conversationId}$`));
    expect(page.url()).not.toBe(sourceUrl);
    await expect(page.getByText('Successfully forked conversation', { exact: true })).toBeVisible();
    await expect(messagesView(page).getByText(reply)).toBeVisible();
  });

  test('the fork popover leads with the scope and keeps the extra options collapsed @scenario:fork-popover-leads-with-scope-and-collapses-options', async ({
    page,
  }) => {
    const reply = await replyInNewChat(page, uniqueLabel('fork-popover'));

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByRole('button', { name: 'Open Fork Menu' }).click();
    const popover = page.getByRole('dialog', { name: 'Fork conversation' });
    await expect(popover.getByRole('radio', { name: 'Up to here' })).toBeChecked();

    /** The less common choices wait behind one text link, and stay out of the accessibility tree. */
    /** The link names the action it will take, so it reads "Fewer options" once it is open. */
    const more = popover.getByRole('button', { name: /^(More|Fewer) options$/ });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(popover.getByRole('checkbox', { name: 'Leave out files' })).toHaveCount(0);
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(popover.getByRole('checkbox', { name: 'Leave out files' })).toBeVisible();
    await expect(popover.getByRole('radio', { name: 'Everything' })).toBeChecked();

    await popover.getByRole('radio', { name: 'From here on' }).click();
    const [request] = await Promise.all([
      page.waitForRequest(
        (req) => req.method() === 'POST' && req.url().includes('/api/convos/fork'),
        { timeout: 30000 },
      ),
      popover.getByRole('button', { name: 'Fork', exact: true }).click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ splitAtTarget: true });
  });

  test('message hover buttons snap their hover tint instead of fading it @scenario:message-hover-buttons-snap-their-hover-tint', async ({
    page,
  }) => {
    const label = uniqueLabel('hover-tint');
    const first = await replyInNewChat(page, `${label}-first`);
    const secondReply = `E2E reply ${label}-second`;
    expect((await sendMessage(page, `E2E_REPLY:${label}-second`)).ok()).toBeTruthy();
    await expect(messagesView(page).getByText(secondReply)).toBeVisible({ timeout: 30000 });

    /** The earlier reply's toolbar fades in and out; the latest one stays shown. Neither fades the
     *  tint a hovered button takes. */
    const earlier = messageRender(page, first);
    const latest = messageRender(page, secondReply);
    await earlier.hover();
    const buttons = [
      earlier.getByRole('button', { name: 'Love this' }),
      latest.getByRole('button', { name: 'Love this' }),
      latest.getByRole('button', { name: 'Open Fork Menu' }),
    ];
    /** A plain button fades its colors; the guard keeps the assertion from passing for nothing. */
    expect(await probeStyle(page, 'transition-colors', 'transition-property')).toMatch(/color/);
    for (const button of buttons) {
      await expect(button).toBeVisible();
      const property = await button.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      );
      expect(property).not.toMatch(/color|background/);
    }
  });

  test('a positive rating is saved and survives a reload @scenario:feedback-rating-persists', async ({
    page,
  }) => {
    const reply = await replyInNewChat(page, uniqueLabel('actions-feedback'));

    const row = messageRender(page, reply);
    await row.hover();
    await row.getByRole('button', { name: 'Love this' }).click();
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.request().method() === 'PUT' && res.url().includes('/feedback'),
        { timeout: 30000 },
      ),
      page.getByRole('dialog').getByRole('button').first().click(),
    ]);
    expect(response.ok()).toBeTruthy();

    const rated = row.getByRole('button', { name: 'Love this' });
    await expect(rated).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    const reloaded = messageRender(page, reply);
    await reloaded.hover();
    await expect(reloaded.getByRole('button', { name: 'Love this' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
