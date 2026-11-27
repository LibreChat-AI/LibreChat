import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

/**
 * `@librechat/chat/standalone.css` is the one stylesheet an app without Tailwind loads to draw
 * the chat. This asks a browser whether it draws a conversation the way LibreChat does: the app
 * renders one, the same markup is then set into a page that has that stylesheet and nothing
 * else, and what each element computes to is read in both.
 */

/** What an element looks like, leaving out what follows from the width of the page around it. */
const PROPERTIES = [
  'font-size',
  'line-height',
  'font-weight',
  'font-family',
  'font-style',
  'color',
  'background-color',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'border-top-width',
  'border-bottom-width',
  'border-left-width',
  'border-right-width',
  'border-top-color',
  'border-bottom-color',
  'border-left-color',
  'border-right-color',
  'border-top-style',
  'border-radius',
  'list-style-type',
  'display',
  'position',
  'max-width',
  'text-decoration-line',
  'white-space',
  'overflow-x',
  'overflow-y',
  'text-align',
  'letter-spacing',
  'vertical-align',
  'word-break',
  'border-collapse',
  'opacity',
  'box-sizing',
  'cursor',
  'flex-direction',
  'align-items',
  'justify-content',
  'box-shadow',
  'visibility',
  'text-transform',
];

/** The reader's settings the app writes on the document. Another app sets none of them. */
const APP_SETTINGS = ['--ui-scale', '--markdown-font-size'];

type Styles = Record<string, string>;

/**
 * Every element of every message, in document order. Math and code blocks are left out: the
 * app's own renderers draw those, with KaTeX's stylesheet and a highlighting theme of its own.
 */
function read(properties: string[]): Record<string, Styles> {
  const read: Record<string, Styles> = {};
  const rows = document.querySelectorAll('[data-testid="messages-view"] .message-render');
  rows.forEach((row, at) => {
    [row, ...Array.from(row.querySelectorAll('*'))].forEach((element, index) => {
      if (element.closest('.katex, pre') != null) {
        return;
      }
      const computed = getComputedStyle(element);
      const styles: Styles = { class: element.getAttribute('class') ?? '' };
      for (const property of properties) {
        styles[property] = computed.getPropertyValue(property);
      }
      styles['::before content'] = getComputedStyle(element, '::before').content;
      styles['::marker color'] = getComputedStyle(element, '::marker').color;
      read[`message ${at} <${element.tagName.toLowerCase()}> #${index}`] = styles;
    });
  });
  return read;
}

/** A border that is not drawn has a color nobody sees; an automatic margin follows the page. */
function compared(property: string, styles: Styles): boolean {
  const side = /^border-(top|bottom|left|right)-color$/.exec(property)?.[1];
  if (side != null) {
    return styles[`border-${side}-width`] !== '0px';
  }
  if (property === 'margin-left' || property === 'margin-right') {
    return !/(^|\s)-?m[xlrse]?-auto(\s|$)/.test(styles.class);
  }
  return property !== 'class';
}

test.describe('the stylesheet for an app without Tailwind', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'standalone-css-'));
  test.afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('draws a conversation as the app does, and nothing outside its class', async ({
    page,
    context,
  }) => {
    test.setTimeout(240_000);
    const sheet = join(scratch, 'standalone.css');
    execFileSync(process.execPath, [
      resolve(__dirname, '../../../scripts/css-chat.mts'),
      '--out',
      sheet,
    ]);
    const css = readFileSync(sheet, 'utf8');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    expect((await sendMessage(page, 'E2E_STREAMING_MARKDOWN_REPLY')).ok()).toBeTruthy();
    const rows = messagesView(page).locator('.message-render');
    await expect(rows.last().getByText('E2E streaming markdown final paragraph.')).toBeVisible({
      timeout: 90_000,
    });
    for (const prompt of ['E2E_MARKDOWN_REPLY', 'E2E_MATH_REPLY']) {
      const before = await rows.count();
      expect((await sendMessage(page, prompt)).ok()).toBeTruthy();
      await expect(rows).toHaveCount(before + 2, { timeout: 60_000 });
    }
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0, {
      timeout: 60_000,
    });
    /** The reveal of the last reply and the hover controls settle before anything is read. */
    await page.waitForTimeout(2500);

    const host = await context.newPage();
    await host.setViewportSize({ width: 1280, height: 900 });

    for (const mode of ['light', 'dark']) {
      await page.evaluate((name) => {
        document.documentElement.classList.remove('light', 'dark');
        document.documentElement.classList.add(name);
      }, mode);
      await page.waitForTimeout(600);
      const app = await page.evaluate(read, PROPERTIES);
      const document = await page.evaluate((settings) => {
        const root = window.document.documentElement;
        const style = root.style.cssText
          .split(';')
          .filter((declaration) => !settings.some((name) => declaration.trim().startsWith(name)))
          .join(';');
        return {
          classes: root.className,
          direction: root.getAttribute('dir') ?? 'ltr',
          style,
          body: window.document.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, ''),
        };
      }, APP_SETTINGS);

      await host.setContent(
        `<!doctype html><html class="${document.classes}" dir="${document.direction}" ` +
          `style="${document.style.replace(/"/g, '&quot;')}"><head><style>${css}</style></head>` +
          '<body><h1 id="heading" class="table collapse border">A heading of the app’s own</h1>' +
          '<button id="button" type="button">A button of the app’s own</button>' +
          `<div class="librechat">${document.body}</div></body></html>`,
      );
      await host.waitForTimeout(1500);
      const standalone = await host.evaluate(read, PROPERTIES);

      expect(Object.keys(standalone), mode).toEqual(Object.keys(app));
      expect(Object.keys(app).length, mode).toBeGreaterThan(150);
      const differences = Object.entries(app).flatMap(([element, styles]) =>
        Object.keys(styles)
          .filter((property) => compared(property, styles))
          .filter((property) => styles[property] !== standalone[element][property])
          .map(
            (property) =>
              `${mode}: ${element} ${property}: ${styles[property]} in the app, ` +
              `${standalone[element][property]} here`,
          ),
      );
      expect(differences).toEqual([]);

      /** Outside the class the page is the app's: no reset, and no utility by a shared name. */
      const outside = await host.evaluate(() => {
        const heading = getComputedStyle(window.document.getElementById('heading') as HTMLElement);
        const button = getComputedStyle(window.document.getElementById('button') as HTMLElement);
        return {
          display: heading.display,
          visibility: heading.visibility,
          weight: heading.fontWeight,
          margin: heading.marginTop,
          edge: heading.borderTopWidth,
          padding: button.paddingLeft,
          cursor: button.cursor,
        };
      });
      expect(outside.display, mode).toBe('block');
      expect(outside.visibility, mode).toBe('visible');
      expect(outside.weight, mode).toBe('700');
      expect(outside.margin, mode).not.toBe('0px');
      expect(outside.edge, mode).toBe('0px');
      expect(outside.padding, mode).not.toBe('0px');
      expect(outside.cursor, mode).toBe('default');
    }
  });
});
