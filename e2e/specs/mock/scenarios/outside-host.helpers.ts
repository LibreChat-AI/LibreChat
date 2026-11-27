import type { Page } from '@playwright/test';

/**
 * What the outside-host check compares, and the differences it expects today.
 *
 * Each message row is reduced to the elements a reader sees: every visible element that carries
 * text of its own, and every landmark (a button, a link, an image, a code block, a table cell…),
 * keyed by its tag and its text or accessible name, with the computed styles that decide how it
 * reads. Two pages that draw the same transcript the same way produce the same entries; positions
 * and sizes are left out, since the two pages lay the column out at their own widths.
 */

export const STYLE_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'text-decoration-line',
  'text-transform',
  'white-space',
  'border-top-width',
  'border-top-style',
  'border-top-color',
  'border-top-left-radius',
  'padding-top',
  'padding-left',
  'display',
  'opacity',
] as const;

/** Where an entry sits, for the gaps that concern one kind of content. */
export type Scope = 'code' | 'math' | 'link' | 'text';
export type Entry = { key: string; scope: Scope; style: Record<string, string> };
export type Row = { header: Entry[]; body: Entry[] };

/**
 * Runs in the page: the entries of every message row, in document order. Self-contained, since
 * Playwright serializes it into each page.
 */
export function collectRows(): Row[] {
  const props = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'line-height',
    'letter-spacing',
    'color',
    'background-color',
    'text-decoration-line',
    'text-transform',
    'white-space',
    'border-top-width',
    'border-top-style',
    'border-top-color',
    'border-top-left-radius',
    'padding-top',
    'padding-left',
    'display',
    'opacity',
  ];
  const LANDMARKS = new Set([
    'a',
    'button',
    'img',
    'pre',
    'table',
    'th',
    'td',
    'li',
    'blockquote',
    'hr',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'iframe',
    'input',
    'textarea',
  ]);
  const squash = (value: string) => value.replace(/\s+/g, ' ').trim();
  const ownText = (el: Element) =>
    squash(
      [...el.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' '),
    );
  const nameOf = (el: Element) =>
    squash(
      el.getAttribute('aria-label') ??
        el.getAttribute('alt') ??
        el.getAttribute('title') ??
        el.getAttribute('data-outside-app') ??
        '',
    );
  const visible = (el: Element) => {
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  /** Clocks and icons say nothing about the package: relative times move, glyphs are hosts'. An
   *  MCP App is the host's to run, so the placeholder the outside host draws for one is left out. */
  const skipped = (el: Element) =>
    el.closest('time, svg, [data-outside-app]') != null || el.matches('time, svg');
  const scopeOf = (el: Element): Scope => {
    if (el.closest('pre') != null) return 'code';
    if (el.closest('.katex') != null) return 'math';
    if (el.closest('a') != null) return 'link';
    return 'text';
  };
  const entries = (root: Element | null): Entry[] => {
    if (root == null) return [];
    const out: Entry[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (skipped(el) || !visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const own = ownText(el);
      const role = el.getAttribute('role');
      if (!own && !LANDMARKS.has(tag) && role == null) continue;
      const label = (own || nameOf(el)).slice(0, 80);
      const computed = getComputedStyle(el);
      const style: Record<string, string> = {};
      for (const prop of props) {
        style[prop] = computed.getPropertyValue(prop);
      }
      out.push({ key: `${tag}${role ? `[${role}]` : ''}:${label}`, scope: scopeOf(el), style });
    }
    return out;
  };
  /** The author line's words are the host's (a user's name, a model's label, a turn's number), so
   *  only how the line is drawn is compared, and whether it shows the author's icon. */
  const header = (row: Element): Entry[] => {
    const line = row.querySelector('h2');
    if (line == null) return [];
    const computed = getComputedStyle(line);
    const style: Record<string, string> = {};
    for (const prop of props) {
      style[prop] = computed.getPropertyValue(prop);
    }
    const out: Entry[] = [{ key: 'h2', scope: 'text', style }];
    if (line.querySelector('[aria-hidden="true"] > *') != null) {
      out.push({ key: 'icon', scope: 'text', style: {} });
    }
    return out;
  };
  return [...document.querySelectorAll('.message-render')].map((row) => ({
    header: header(row),
    body: entries(row.querySelector('[data-testid="message-body"]')),
  }));
}

export type Difference = {
  fixture: string;
  /** Whether the rows were compared after opening every disclosure in them. */
  opened: boolean;
  row: number;
  part: 'header' | 'body';
  kind: 'missing' | 'extra' | 'style';
  /** The entry's key: its tag and text. */
  key: string;
  scope: Scope;
  /** For a style difference, the properties that differ. */
  changed?: string[];
  /** For a style difference, each property that differs, as `LibreChat -> outside`. */
  detail?: string;
};

/** Pairs entries with the same key in order; what is left over on either side is missing/extra. */
function diffEntries(
  fixture: string,
  opened: boolean,
  row: number,
  part: 'header' | 'body',
  libre: Entry[],
  outside: Entry[],
): Difference[] {
  const out: Difference[] = [];
  const used = new Set<number>();
  let cursor = 0;
  for (const entry of libre) {
    let found = -1;
    for (let index = cursor; index < outside.length; index++) {
      if (!used.has(index) && outside[index].key === entry.key) {
        found = index;
        break;
      }
    }
    if (found < 0) {
      out.push({ fixture, opened, row, part, kind: 'missing', key: entry.key, scope: entry.scope });
      continue;
    }
    used.add(found);
    cursor = found + 1;
    const other = outside[found].style;
    /** A border's color and style draw nothing while neither side has a width. */
    const borderless =
      entry.style['border-top-width'] === '0px' && other['border-top-width'] === '0px';
    const changed = STYLE_PROPS.filter(
      (prop) =>
        entry.style[prop] !== other[prop] &&
        !(borderless && (prop === 'border-top-color' || prop === 'border-top-style')),
    );
    if (changed.length > 0) {
      out.push({
        fixture,
        opened,
        row,
        part,
        kind: 'style',
        key: entry.key,
        scope: entry.scope,
        changed: [...changed],
        detail: changed
          .map((prop) => `${prop}: ${entry.style[prop]} -> ${outside[found].style[prop]}`)
          .join('; '),
      });
    }
  }
  outside.forEach((entry, index) => {
    if (!used.has(index)) {
      out.push({ fixture, opened, row, part, kind: 'extra', key: entry.key, scope: entry.scope });
    }
  });
  return out;
}

export function compareRows(
  fixture: string,
  opened: boolean,
  libre: Row[],
  outside: Row[],
): Difference[] {
  const out: Difference[] = [];
  const count = Math.max(libre.length, outside.length);
  for (let row = 0; row < count; row++) {
    const a = libre[row] ?? { header: [], body: [] };
    const b = outside[row] ?? { header: [], body: [] };
    out.push(...diffEntries(fixture, opened, row, 'header', a.header, b.header));
    out.push(...diffEntries(fixture, opened, row, 'body', a.body, b.body));
  }
  return out;
}

/**
 * A difference the package is known to have today. Each names what LibreChat draws that the
 * package cannot yet, and the change that closes it; when the change lands its differences stop
 * reproducing, and the check fails until the gap is deleted here.
 */
export type Gap = {
  id: string;
  /** What an outside app gets today, and what closes it. */
  why: string;
  matches: (difference: Difference) => boolean;
};

export async function waitForRows(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.message-render').length >= expected,
    count,
    { timeout: 30_000 },
  );
  /** Lazy pieces (KaTeX, the highlighter, images) land after the first paint, and the chat view
   *  keeps its connections open, so "settled" is the rows' markup holding still for a second. */
  await page.evaluate(async () => {
    await document.fonts.ready;
    const snapshot = () =>
      [...document.querySelectorAll('.message-render')].map((row) => row.innerHTML).join('\n');
    let last = snapshot();
    let still = 0;
    for (let waited = 0; waited < 20_000 && still < 4; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const next = snapshot();
      still = next === last ? still + 1 : 0;
      last = next;
    }
  });
}

/**
 * Opens every closed disclosure in the message bodies (a tool's output, a group, a phase, a
 * thought), a few rounds deep since opening one reveals the next, and waits for the rows to settle.
 */
export async function openDisclosures(page: Page, count: number): Promise<void> {
  for (let round = 0; round < 4; round++) {
    const closed = page.locator('[data-testid="message-body"] [aria-expanded="false"]');
    const total = await closed.count();
    if (total === 0) break;
    for (let index = total - 1; index >= 0; index--) {
      await closed
        .nth(index)
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    }
    await waitForRows(page, count);
  }
}

export function describe(difference: Difference): string {
  const where = `${difference.fixture}${difference.opened ? ' (opened)' : ''} row ${difference.row} ${difference.part}`;
  return `${where}: ${difference.kind} ${JSON.stringify(difference.key)}${
    difference.detail ? ` (${difference.detail})` : ''
  }`;
}
