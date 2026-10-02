import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import { messagesView } from '../helpers';
import {
  computedStyles,
  normalizeColor,
  probePlaceholderColor,
  probeStyle,
  themeValue,
  useStoredTheme,
} from './style.helpers';
import type { Page } from '@playwright/test';
import type { SeedMessage } from '../db';

/**
 * The Tailwind v4 upgrade is meant to be visually invisible, and three of its
 * renamings decide whether it is: v4 moved the blur scale up a step, it defaults
 * `border-color` to `currentColor` where v3 used gray-200, and it defaults a
 * placeholder to the field's own colour at half opacity. Each scenario reads what
 * the app paints and compares it to a probe painted by the same stylesheet, so
 * the assertion survives a theme, a mode and the token move in the next commit.
 */

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const ARTIFACT_TEXT = [
  ':::artifact{identifier="e2e-v4-panel" type="application/vnd.code" title="panel.py"}',
  '```python',
  'print("panel")',
  '```',
  ':::',
].join('\n');
const TWO_PARAGRAPHS = 'The first paragraph.\n\nThe second paragraph.';
const BUILDER_SELECT_CLASSES =
  'rounded-lg border border-token-border-medium bg-transparent px-2 py-0 text-sm';

/** Seed one assistant turn carrying an artifact and open its panel. */
async function openArtifactPanel(page: Page, conversationId: string): Promise<void> {
  const message: SeedMessage = {
    messageId: randomUUID(),
    parentMessageId: ROOT_PARENT,
    text: ARTIFACT_TEXT,
    isCreatedByUser: false,
    sender: 'Assistant',
    model: 'mock-model-a',
  };
  await seedConversations(getE2EUser().email, [
    { conversationId, title: 'Tailwind v4 rendering', updatedAt: new Date() },
  ]);
  await seedMessages(getE2EUser().email, conversationId, [message]);
  await page.goto(`/c/${conversationId}`, { timeout: 30000 });

  const trigger = messagesView(page).locator('[data-artifact-trigger]').first();
  await expect(trigger).toBeVisible({ timeout: 30000 });
  await trigger.click();
  await expect(page.locator('#artifact-viewer')).toBeVisible({ timeout: 30000 });
}

test.describe('Tailwind v4 rendering', () => {
  /** The artifact panel and its resize handle are desktop surfaces: the side
   *  panel group does not mount below `md`, so the scenarios that read them
   *  declare the viewport they describe instead of inheriting a phone. */
  test.use({ viewport: { width: 1280, height: 900 } });

  test('a small blur surface still blurs by four pixels @scenario:a-small-blur-surface-still-blurs-by-four-pixels', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const conversationId = randomUUID();
    try {
      await openArtifactPanel(page, conversationId);

      /** The artifact panel's refresh scrim stands in for the six small-blur
       *  sites the upgrade touched: v3's `blur-sm` was 4px, v4's is 8px, and the
       *  4px step is now called `blur-xs`. The scrim is always mounted, so its
       *  filter is readable while it is still transparent. */
      const scrim = page.locator('#artifact-viewer [role="status"]').first();
      await expect(scrim).toBeAttached({ timeout: 30000 });

      const { backdropFilter } = await computedStyles(scrim, ['backdropFilter']);
      expect(backdropFilter).toBe('blur(4px)');
      expect(backdropFilter).not.toBe('blur(8px)');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the resize handle border follows the theme @scenario:the-resize-handle-border-follows-the-theme', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const conversationId = randomUUID();
    /** Dark mode is what separates the two candidates: the app's compatibility
     *  shim paints a fixed light gray, while the semantic role follows the
     *  theme — and only the role ships with the package. */
    await useStoredTheme(page, 'dark');
    try {
      await openArtifactPanel(page, conversationId);
      await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);

      /** The panel-group separator, not the sidebar's resize strip: only this
       *  one carries the grip whose border is under test. */
      const grip = page.locator('[role="separator"] > div').first();
      await expect(grip).toBeAttached({ timeout: 30000 });

      const { borderTopColor, color } = await computedStyles(grip, ['borderTopColor', 'color']);
      const expected = await normalizeColor(
        page,
        `rgb(${await themeValue(page, '--border-light')})`,
      );
      expect(borderTopColor).toBe(expected);
      /** A bare `border` under v4 inherits `currentColor`, which is what the
       *  published primitive drew before it named a role. */
      expect(borderTopColor).not.toBe(color);
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('the app keeps its v3 border and placeholder defaults @scenario:the-app-keeps-its-v3-border-and-placeholder-defaults', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/c/new', { timeout: 30000 });

    const composer = page.getByRole('textbox', { name: 'Message input' });
    await expect(composer).toBeVisible({ timeout: 30000 });

    /** v4's preflight would paint an uncoloured border with `currentColor`. The
     *  app restores v3's gray-200 through `theme()`, so a bare `border` has to
     *  match the palette entry the shim names. The reference is the root
     *  `--gray-200` triplet the app declares in its own stylesheet, not a
     *  `border-gray-200` probe: no source under `client/src` or
     *  `packages/client/src` writes that class, so Tailwind never generates it
     *  and a probe carrying it would read back the shim's own value — passing
     *  even if the shim named the wrong gray. */
    const bare = await probeStyle(page, 'border', 'border-top-color');
    const gray200 = await normalizeColor(page, `rgb(${await themeValue(page, '--gray-200')})`);
    const inherited = await probeStyle(page, 'border', 'color');
    expect(bare).toBe(gray200);
    expect(bare).not.toBe(inherited);

    /** And v4 would paint a placeholder as the field's own colour at half
     *  opacity. The app restores gray-400, read from the root `--gray-400`
     *  triplet for the same reason as the border: no source writes
     *  `text-gray-400` any more, so a probe carrying it generates no CSS. The
     *  composer sets its own `placeholder:` role, so the probe is a plain
     *  field, which is what the preflight rule governs. */
    const placeholder = await probePlaceholderColor(page);
    const gray400 = await normalizeColor(page, `rgb(${await themeValue(page, '--gray-400')})`);
    const body = await probeStyle(page, '', 'color');
    expect(placeholder).toBe(gray400);
    expect(placeholder).not.toBe(body);

    /** And v4 drops `cursor: pointer` from buttons, which the app restores in
     *  `@layer base`. The layer is the point: a `cursor-*` utility has to keep
     *  winning, or `disabled:cursor-not-allowed` on a disabled control and
     *  `cursor-default` on a menu trigger would both read as a pointer. */
    const button = await probeStyle(page, '', 'cursor', 'button');
    const overridden = await probeStyle(page, 'cursor-default', 'cursor', 'button');
    expect(button).toBe('pointer');
    expect(overridden).toBe('default');
  });

  test('a paragraph keeps its margin utility @scenario:a-paragraph-keeps-its-margin-utility', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const conversationId = randomUUID();
    const userEmail = getE2EUser().email;
    const message: SeedMessage = {
      messageId: randomUUID(),
      parentMessageId: ROOT_PARENT,
      text: TWO_PARAGRAPHS,
      isCreatedByUser: false,
      sender: 'Assistant',
      model: 'mock-model-a',
    };

    await useStoredTheme(page, 'light');
    try {
      await seedConversations(userEmail, [
        { conversationId, title: 'Tailwind v4 paragraph margins', updatedAt: new Date() },
      ]);
      await seedMessages(userEmail, conversationId, [message]);
      await page.goto(`/c/${conversationId}`, { timeout: 30000 });

      const utilityTop = await probeStyle(page, 'my-4', 'margin-top', 'p');
      const utilityBottom = await probeStyle(page, 'my-4', 'margin-bottom', 'p');
      expect(utilityTop).toBe('16px');
      expect(utilityBottom).toBe('16px');

      /** A real rendered element whose margin utility the reset would zero. The
       *  markdown body is not that element: its paragraphs sit inside `.prose`,
       *  whose own unlayered `:where(p)` rules outrank `mb-2` under either
       *  Tailwind, and its last child is zeroed on purpose. The assistant row's
       *  name header carries `mb-1` with nothing else claiming its margin. */
      const header = messagesView(page).locator('h2:not(.sr-only)').first();
      await expect(header).toBeVisible({ timeout: 30000 });
      const rendered = await computedStyles(header, ['marginBottom']);
      expect(rendered.marginBottom).toBe('4px');
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });

  test('a desktop-only control is revealed at desktop width @scenario:a-desktop-only-control-is-revealed-at-desktop-width', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await useStoredTheme(page, 'light');
    await page.goto('/c/new', { timeout: 30000 });

    /** `hidden … md:flex` is how the SPA reveals a control on desktop — the
     *  header's trace, export/share and temporary-chat cluster, the composer's
     *  MCP label. The app's stylesheet declared its own `.hidden`, a duplicate
     *  of the utility, and unlayered it outranked every layered variant, so
     *  those controls computed `display: none` at every width. Every `.hidden`
     *  rule the page loads now comes from the utilities layer, where a
     *  responsive variant can still win. */
    const unlayered = await page.evaluate(() => {
      const offenders: string[] = [];
      const visit = (rules: CSSRuleList, layered: boolean) => {
        for (const rule of Array.from(rules)) {
          const grouping = rule as CSSGroupingRule & { name?: string; selectorText?: string };
          const inLayer =
            layered ||
            (rule.constructor.name === 'CSSLayerBlockRule' && grouping.name === 'utilities');
          if (grouping.selectorText === '.hidden' && !layered) {
            offenders.push(grouping.cssText.slice(0, 80));
          }
          if (grouping.cssRules) {
            visit(grouping.cssRules, inLayer);
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          visit(sheet.cssRules, false);
        } catch {
          // Cross-origin stylesheets cannot expose cssRules; the app's own can.
        }
      }
      return offenders;
    });
    expect(unlayered).toEqual([]);

    expect(await probeStyle(page, 'hidden md:flex', 'display')).toBe('flex');
    expect(await probeStyle(page, 'hidden md:block', 'display')).toBe('block');

    /** A class with no reveal beside it still hides, and below `md` the
     *  desktop-only control goes back to hidden, which is what a phone saw
     *  under Tailwind 3. */
    expect(await probeStyle(page, 'hidden', 'display')).toBe('none');
    await page.setViewportSize({ width: 500, height: 900 });
    expect(await probeStyle(page, 'hidden md:flex', 'display')).toBe('none');
  });

  test('a list link keeps its no-underline utility @scenario:a-list-link-keeps-its-no-underline-utility', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await useStoredTheme(page, 'light');
    await page.goto('/c/new', { timeout: 30000 });

    /** `mobile.css` paints every list link blue, bold and underlined. It is two
     *  element selectors, so a class beat it under v3 — which is how the source
     *  and skill cards that carry `no-underline` looked. Unlayered under v4 it
     *  outranked the utility instead. Layered, the utility wins again while an
     *  unclassed list link keeps the treatment. */
    const decorated = await page.evaluate(() => {
      const list = document.createElement('ul');
      list.innerHTML =
        '<li><a id="probe-plain" href="#">plain</a></li>' +
        '<li><a id="probe-utility" class="no-underline" href="#">carded</a></li>';
      document.body.append(list);
      const read = (id: string) => {
        const style = getComputedStyle(document.getElementById(id) as HTMLElement);
        return { decoration: style.textDecorationLine, weight: style.fontWeight };
      };
      const result = { plain: read('probe-plain'), utility: read('probe-utility') };
      list.remove();
      return result;
    });

    expect(decorated.utility.decoration).toBe('none');
    expect(decorated.plain.decoration).toBe('underline');
    /** The rule still owns what no utility claims. */
    expect(decorated.utility.weight).toBe('700');
  });

  test('a native select keeps its token styling @scenario:a-native-select-keeps-its-token-styling', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await useStoredTheme(page, 'light');
    await page.goto('/c/new', { timeout: 30000 });

    const expectedRadius = await probeStyle(page, 'rounded-lg', 'border-radius');
    const expectedBackground = await probeStyle(page, 'bg-transparent', 'background-color');
    const expectedFontSize = await probeStyle(page, 'text-sm', 'font-size');
    const expectedPaddingRight = await probeStyle(page, 'px-2', 'padding-right');
    const white = await normalizeColor(page, 'white');
    const select = await page.evaluate((className) => {
      const probe = document.createElement('select');
      probe.className = className;
      probe.innerHTML = '<option>Probe</option>';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const values = {
        borderRadius: style.borderRadius,
        backgroundColor: style.backgroundColor,
        fontSize: style.fontSize,
        paddingRight: style.paddingRight,
      };
      probe.remove();
      return values;
    }, BUILDER_SELECT_CLASSES);

    expect(select.borderRadius).toBe(expectedRadius);
    expect(select.backgroundColor).toBe(expectedBackground);
    expect(select.backgroundColor).not.toBe(white);
    expect(select.fontSize).toBe(expectedFontSize);
    expect(select.paddingRight).toBe(expectedPaddingRight);
  });

  test('classes ignored by Tailwind 3 stay inert @scenario:classes-tailwind-3-ignored-stay-inert', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const conversationId = randomUUID();
    try {
      await openArtifactPanel(page, conversationId);

      const panel = await computedStyles(page.locator('#artifact-viewer'), ['transitionDuration']);
      const transitionMs = panel.transitionDuration.endsWith('ms')
        ? Number.parseFloat(panel.transitionDuration)
        : Number.parseFloat(panel.transitionDuration) * 1000;
      expect(transitionMs).toBe(150);

      const forbidden = await page.evaluate(() => {
        const tokens = [
          'duration-250',
          'duration-350',
          'h-19',
          'w-19',
          'w-30',
          'w-100',
          'max-w-11/12',
          'border-1',
          'scrollbar-none',
          '@container',
        ];
        const selectors: string[] = [];
        const visit = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            if ('selectorText' in rule) {
              selectors.push((rule as CSSStyleRule).selectorText);
            }
            if ('cssRules' in rule) {
              visit((rule as CSSGroupingRule).cssRules);
            }
          }
        };

        for (const sheet of Array.from(document.styleSheets)) {
          try {
            visit(sheet.cssRules);
          } catch {
            // Cross-origin stylesheets cannot expose cssRules; app stylesheets do.
          }
        }

        return tokens.map((token) => {
          const needle = `.${CSS.escape(token)}`;
          const found = selectors.some((selector) => {
            let start = selector.indexOf(needle);
            while (start !== -1) {
              const next = selector[start + needle.length];
              if (!next || !/[A-Za-z0-9_-]/.test(next)) return true;
              start = selector.indexOf(needle, start + needle.length);
            }
            return false;
          });
          return { token, found };
        });
      });
      for (const { token, found } of forbidden) {
        expect(found, `unexpected generated selector for .${token}`).toBe(false);
      }
    } finally {
      await deleteMessagesByConversation([conversationId]);
      await deleteConversations([conversationId]);
    }
  });
});
