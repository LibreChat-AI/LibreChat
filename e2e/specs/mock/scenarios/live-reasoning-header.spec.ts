import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from '../helpers';

const ENDPOINT = { label: 'Mock Provider F', model: 'mock-model-f' };
const uniqueLabel = () => `list-think-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

/** The sentences of the streamed plan; the header shows at least one of them, alone. */
const ITEMS = [
  'Check the refs.',
  'Compare the ordering.',
  'Read the notes.',
  'The docs confirm the flag exists.',
  'The notes agree.',
  'Use the cache.',
  'Skip the read.',
];

/**
 * Every line the live card's header shows from now on, read back through the handle. The page
 * records them itself: a line holds for a second, and a look from here can fall between two.
 */
async function recordHeaderLines(page: Page) {
  return page.evaluateHandle(() => {
    const seen = { lines: [] as string[] };
    const read = () => {
      const line = document.querySelector(
        '[data-testid="messages-view"] [data-testid="activity-phase-card"] button [title]',
      );
      /** Only a live line shimmers; the summary a settled card takes is not this line. */
      const title = line?.querySelector('.shimmer') == null ? null : line.getAttribute('title');
      if (title != null && seen.lines[seen.lines.length - 1] !== title) {
        seen.lines.push(title);
      }
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['title'],
    });
    return seen;
  });
}

test.describe('live reasoning header', () => {
  test('names a markdown thought by its sentences, never a list marker or citation anchor @scenario:live-reasoning-header-plain-sentences', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const label = uniqueLabel();
    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, ENDPOINT);
    const header = await recordHeaderLines(page);
    const run = await sendMessage(page, `E2E_LIST_THINK_REPLY:${label}`);
    expect(run.ok()).toBeTruthy();
    await expect(messagesView(page).getByText(`E2E list think reply done ${label}`)).toBeVisible({
      timeout: 60000,
    });

    const lines = await header.evaluate((seen) => seen.lines);
    expect(
      lines.some((line) => ITEMS.includes(line)),
      `lines: ${lines.join(' | ')}`,
    ).toBe(true);
    for (const line of lines) {
      /** A whole sentence or the generic line: no ordinal such as `2.`, no bullet, no line
       *  above glued on, and no anchor in either the decoded or the escaped form. */
      expect(line, `header line "${line}"`).toMatch(/^(Thinking\.\.\.|Thinking…|.*\p{L}.*[.!?])$/u);
      expect(line).not.toMatch(/^[-*+•]\s|:\s|turn\d+search\d+|\\ue20|[\ue200-\ue206]/);
    }
  });
});
