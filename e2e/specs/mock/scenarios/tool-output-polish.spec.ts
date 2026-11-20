import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import { messagesView } from '../helpers';

/**
 * Tool output cards: the copy button overlays the output and reveals on hover or keyboard focus,
 * the full output sits in the fixed max-height scroll box, and the row header shows no pressed fill.
 */

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LINE_COUNT = 60;
const lineLabel = (n: number) => `line-${String(n).padStart(3, '0')}`;

async function seedToolConversation(page: Page): Promise<void> {
  const conversationId = unique('e2e-tool-output');
  const now = new Date(0).toISOString();
  const output = Array.from({ length: LINE_COUNT }, (_, i) => lineLabel(i + 1)).join('\n');
  const message = {
    messageId: `${conversationId}-msg`,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [
      {
        type: 'tool_call',
        tool_call: {
          id: `${conversationId}-tool`,
          name: 'lookup_records',
          args: JSON.stringify({ query: 'numbered lines' }),
          output,
          progress: 1,
        },
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Tool output polish',
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
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([message]),
    }),
  );
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });
}

/** The tool row header: the disclosure button inside the `tool-call` row (ProgressText.tsx). */
const rowHeader = (page: Page): Locator =>
  messagesView(page).getByTestId('tool-call').getByRole('button').first();

/** Seeds the conversation and makes sure the row is expanded, whatever the auto-expand preference. */
async function openToolRow(page: Page): Promise<{ header: Locator; output: Locator }> {
  await seedToolConversation(page);
  const header = rowHeader(page);
  await expect(header).toBeVisible({ timeout: 15000 });
  if ((await header.getAttribute('aria-expanded')) !== 'true') {
    await header.click();
  }
  await expect(header).toHaveAttribute('aria-expanded', 'true');
  const output = messagesView(page)
    .locator('pre', { hasText: lineLabel(1) })
    .first();
  await expect(output).toBeVisible({ timeout: 15000 });
  return { header, output };
}

const opacityOf = (locator: Locator) =>
  locator.evaluate((el) => Number.parseFloat(getComputedStyle(el).opacity));

test.describe('tool output polish', () => {
  test.afterEach(async ({ page }) => {
    await page.unrouteAll();
  });

  test('copy reveals on hover or focus @scenario:tool-output-copy-reveals-on-hover-or-focus', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { header, output } = await openToolRow(page);
    const copy = messagesView(page)
      .getByTestId('tool-call')
      .locator('xpath=following-sibling::*')
      .getByRole('button', { name: 'Copy', exact: true });
    await expect(copy).toHaveCount(1);
    const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);

    if (!canHover) {
      await expect.poll(() => opacityOf(copy)).toBe(1);
      await copy.focus();
      await expect.poll(() => opacityOf(copy)).toBe(1);
      return;
    }

    await page.mouse.move(1, 1);
    await expect.poll(() => opacityOf(copy)).toBe(0);

    await output.hover();
    await expect.poll(() => opacityOf(copy)).toBe(1);

    await page.mouse.move(1, 1);
    await expect.poll(() => opacityOf(copy)).toBe(0);

    /* Tabbing on from the row header reaches the copy button (the scrollable output box can
       take a stop first); focus-visible reveals it. */
    await header.focus();
    for (let presses = 0; presses < 5; presses++) {
      await page.keyboard.press('Tab');
      if (await copy.evaluate((el) => el === document.activeElement)) {
        break;
      }
    }
    await expect(copy).toBeFocused();
    await expect.poll(() => opacityOf(copy)).toBe(1);
  });

  test('output renders in full inside the scroll box @scenario:tool-output-shows-full-output', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { output } = await openToolRow(page);
    await expect(output).toContainText(lineLabel(1));
    await expect(output).toContainText(lineLabel(LINE_COUNT));
    await expect(messagesView(page).getByRole('button', { name: 'Show more' })).toHaveCount(0);
    const { scrollHeight, clientHeight } = await output.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
  });

  test('pressing the row header shows no fill @scenario:tool-row-header-has-no-pressed-fill', async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { header } = await openToolRow(page);
    const background = () => header.evaluate((el) => getComputedStyle(el).backgroundColor);
    await page.mouse.move(1, 1);
    const resting = await background();

    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    if (box == null) {
      return;
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    try {
      await expect.poll(background).toBe(resting);
    } finally {
      await page.mouse.up();
    }
  });
});
