import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
  thinkPrompt,
  thinkText,
} from '../helpers';

/**
 * The thought and web search disclosures open and close on a shared grid-rows transition. These
 * scenarios cover what a reader does with them: fold a thought with motion reduced, open a
 * finished search's sources and details, and see the panel motion and the live peek's edge fade
 * the way they were drawn before they moved into the shared stylesheet. Search and grouped-thought
 * conversations are routed fixtures.
 */
test.describe.configure({ timeout: 120_000 });

type Part = Record<string, unknown>;

const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const DONE = 'Part disclosures fixture done.';
const QUERY = 'css view transitions support';
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Serves a one-reply conversation made of `content`, and opens it. */
async function openConversation(page: Page, content: Part[], attachments: Part[] = []) {
  const conversationId = unique('e2e-part-disclosures');
  const now = new Date(0).toISOString();
  const messageId = `${conversationId}-msg`;
  const message = {
    messageId,
    conversationId,
    parentMessageId: NO_PARENT,
    isCreatedByUser: false,
    sender: 'Assistant',
    endpoint: 'Mock Provider A',
    model: 'mock-model-a',
    text: '',
    content: [...content, { type: 'text', text: DONE }],
    attachments: attachments.map((attachment) => ({ ...attachment, messageId })),
    createdAt: now,
    updatedAt: now,
  };
  const conversation = {
    conversationId,
    title: 'Part disclosures',
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
  await expect(messagesView(page).getByText(DONE)).toBeVisible({ timeout: 20000 });
}

const finishedSearch: Part[] = [
  {
    type: 'tool_call',
    tool_call: {
      id: 's1',
      name: 'web_search',
      args: JSON.stringify({ query: QUERY }),
      output: 'results',
      progress: 1,
      type: 'tool_call',
      runStepStatus: 'completed',
    },
  },
];

const searchSources: Part[] = [
  {
    type: 'web_search',
    toolCallId: 's1',
    web_search: {
      turn: 0,
      organic: [{ link: 'https://developer.mozilla.org/', title: 'MDN on view transitions' }],
      topStories: [],
    },
  },
];

/** A command and a thought under one generated title, so the thought is a row in the group. */
const groupedThought: Part[] = [
  {
    type: 'tool_call',
    tool_call: {
      id: 'g1',
      name: 'bash_tool',
      args: '{"command":"echo hi"}',
      output: 'hi',
      progress: 1,
      type: 'tool_call',
      runStepStatus: 'completed',
    },
  },
  { type: 'activity_label', activity_label: 'Checked the command', pending: false },
  { type: 'think', think: 'Checking whether the output matches' },
];

const EXPAND =
  'grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
const REDUCED = 'grid-template-rows 0.01ms linear, opacity 0.01ms linear';
const PANEL_PROPS = [
  'display',
  'grid-template-rows',
  'height',
  'opacity',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
];

/** The inline style a disclosure panel carried before its motion moved into the shared stylesheet. */
const inlinePanel = (open: boolean, reduced = false) =>
  `display: grid; grid-template-rows: ${open ? '1fr' : '0fr'}; opacity: ${open ? 1 : 0}; ` +
  `transition: ${reduced ? REDUCED : EXPAND}`;

const FADE =
  'linear-gradient(to bottom, transparent, black 1.25rem, black calc(100% - 1.25rem), transparent)';
const PEEK_PROPS = ['mask-image', '-webkit-mask-image'];

/** The inline style the live peek carried before its edge fade moved into the shared stylesheet. */
const inlinePeek = `mask-image: ${FADE}; -webkit-mask-image: ${FADE}`;

/**
 * The element's computed values for `props`, the values its own subtree gets when `inline` styles
 * it in place of the stylesheet class in `retired`, and the stylesheet rules that match the element
 * and set one of them: what the app's stylesheet would have to be changing, if the two differ.
 */
function againstInline(locator: Locator, inline: string, props: string[], retired: string[]) {
  return locator.evaluate(
    (node, { inline: style, props: names, retired: classNames }) => {
      const read = (element: Element) =>
        Object.fromEntries(
          names.map((name) => [name, getComputedStyle(element).getPropertyValue(name)]),
        );
      const probe = node.cloneNode(true) as HTMLElement;
      probe.classList.remove(...classNames);
      probe.removeAttribute('data-expanded');
      probe.style.cssText = style;
      node.parentElement?.appendChild(probe);
      const expected = read(probe);
      probe.remove();

      const rules: string[] = [];
      const walk = (list: CSSRuleList) => {
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule) {
            try {
              if (
                /\b(display|opacity|transition|grid-template|mask)/.test(rule.style.cssText) &&
                node.matches(rule.selectorText)
              ) {
                rules.push(`${rule.selectorText} { ${rule.style.cssText} }`);
              }
            } catch {
              /* a selector this engine cannot match against an element */
            }
          } else if (
            'cssRules' in rule &&
            (!(rule instanceof CSSMediaRule) || window.matchMedia(rule.conditionText).matches)
          ) {
            walk((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          walk(sheet.cssRules);
        } catch {
          /* a sheet from another origin cannot be read */
        }
      }
      return { actual: read(node), expected, rules };
    },
    { inline, props, retired },
  );
}

/** Waits out the panel's own transition, then holds it to the old inline style, rows and all. */
async function expectPanelAsBefore(panel: Locator, open: boolean, reduced = false) {
  const compare = () =>
    againstInline(panel, inlinePanel(open, reduced), PANEL_PROPS, ['part-expand']);
  let last = await compare();
  try {
    await expect
      .poll(
        async () => {
          last = await compare();
          return JSON.stringify(last.actual) === JSON.stringify(last.expected);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  } catch (error) {
    expect(last.actual, `rules that match the panel:\n${last.rules.join('\n')}`).toEqual(
      last.expected,
    );
    throw error;
  }
  expect(last.actual.opacity).toBe(open ? '1' : '0');
}

test.describe('part disclosures', () => {
  test('a reader who prefers reduced motion folds a thought and its text leaves the page @scenario:reduced-motion-fold-removes-thought-text', async ({
    page,
  }) => {
    const label = unique('reduced-fold');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
      window.localStorage.setItem('showThinking', 'true');
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, thinkPrompt(label));

    const message = messagesView(page).locator('.message-render').last();
    const header = message.getByRole('button', { name: /Thoughts/ }).first();
    const thought = message.getByText(thinkText(label));
    await expect(header).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 });
    await expect(thought).toBeVisible();

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expect(thought).toHaveCount(0);

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(thought).toBeVisible();
  });

  test('a finished web search opens its sources, and its details show on focus @scenario:finished-web-search-opens-sources-and-shows-details-on-focus', async ({
    page,
  }) => {
    await openConversation(page, finishedSearch, searchSources);
    const view = messagesView(page);
    const row = view.getByRole('button', { name: /Searched the web/ }).first();
    const source = view.getByRole('link', { name: /MDN on view transitions/ });
    await expect(row).toBeVisible();
    if ((await row.getAttribute('aria-expanded')) === 'true') {
      await row.click();
      await expect(source).toHaveCount(0);
    }

    await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', 'https://developer.mozilla.org/');

    await row.press('Enter');
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(source).toHaveCount(0);

    const details = view.getByRole('button', { name: 'Search details' });
    const reveal = details.locator('xpath=..');
    /** The row still holds focus from the keyboard toggle, and focus anywhere in the row reveals it. */
    await row.evaluate((node) => node.blur());
    await page.mouse.move(0, 0);
    await expect(reveal).toHaveCSS('opacity', '0');
    await details.focus();
    await expect(reveal).toHaveCSS('opacity', '1');
    await expect(page.getByText(QUERY)).toBeVisible();
  });

  test('the thought panel keeps its motion and the live peek its edge fade under the app stylesheet @scenario:part-styles-survive-the-app-stylesheet', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const label = unique('cascade');
    await page.addInitScript(() => {
      window.localStorage.setItem('showThinking', 'false');
    });
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await sendMessageAndWaitForCompletion(page, thinkPrompt(label));

    const view = messagesView(page);
    const message = view.locator('.message-render').last();
    const header = message.getByRole('button', { name: /Thoughts/ }).first();
    const panel = message.locator('.part-expand').first();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await expectPanelAsBefore(panel, false);

    /**
     * The live peek draws only while a folded thought streams, and the app folds a streaming
     * tail into its own activity card instead. A stand-in with the peek's class goes where the
     * peek would sit, among the same ancestors, so the app's stylesheet gets to act on it.
     */
    await panel.evaluate((node) => {
      const standIn = document.createElement('div');
      standIn.setAttribute('data-testid', 'peek-stand-in');
      standIn.className = 'thought-peek';
      standIn.textContent = 'A thought that fades at its edges';
      node.parentElement?.insertBefore(standIn, node);
    });
    const peek = await againstInline(message.getByTestId('peek-stand-in'), inlinePeek, PEEK_PROPS, [
      'thought-peek',
    ]);
    expect(peek.actual, `rules that match the peek:\n${peek.rules.join('\n')}`).toEqual(
      peek.expected,
    );
    expect(peek.actual['mask-image']).toContain('linear-gradient');

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expectPanelAsBefore(panel, true);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectPanelAsBefore(panel, true, true);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    /** The same panel inside a search row, and as a row of a tool group, with other ancestors. */
    await openConversation(page, finishedSearch, searchSources);
    const row = messagesView(page)
      .getByRole('button', { name: /Searched the web/ })
      .first();
    if ((await row.getAttribute('aria-expanded')) !== 'true') {
      await row.click();
    }
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expectPanelAsBefore(messagesView(page).locator('.part-expand').first(), true);

    await openConversation(page, groupedThought);
    const group = messagesView(page)
      .getByRole('button', { name: /Checked the command/ })
      .first();
    await group.click();
    const thoughts = messagesView(page)
      .getByRole('button', { name: /Thoughts/ })
      .last();
    await expect(thoughts).toBeVisible();
    const compact = messagesView(page).locator('.part-expand').last();
    await expectPanelAsBefore(compact, false);
    await thoughts.click();
    await expect(thoughts).toHaveAttribute('aria-expanded', 'true');
    await expectPanelAsBefore(compact, true);
  });
});
