import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { clickHouseTheme } from '../../../../packages/client/src/theme/themes/clickhouse';
import { NEW_CHAT_PATH } from '../helpers';
import { probeStyle } from './style.helpers';

/**
 * The field and nav variants are rendered from the built primitives (server-side markup, the
 * classes the components really emit) into the running app, so its stylesheet and active theme
 * decide what is painted. Each expectation is read back from the browser, either off the call site
 * the variant replaces or off a probe carrying the role.
 */
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1280, height: 800 } });

const THEME_PARAM = 'e2eTheme';
const THEMES = ['default', 'clickhouse'] as const;
type ThemeChoice = (typeof THEMES)[number];

type Primitives = {
  Input: React.ElementType;
  Textarea: React.ElementType;
  TextareaAutosize: React.ElementType;
  SecretInput: React.ElementType;
  Button: React.ElementType;
};

async function primitives(): Promise<Primitives> {
  return (await import('../../../../packages/client/dist/index.mjs')) as Primitives;
}

/** Same bridge as the other theme specs: the URL picks the stored definition. */
async function installThemeBridge(page: Page) {
  await page.addInitScript(
    ([param, definition]) => {
      const wanted = new URL(location.href).searchParams.get(param);
      if (wanted === null) {
        return;
      }
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
      if (wanted === 'clickhouse') {
        localStorage.setItem('theme-definition', JSON.stringify(definition));
        localStorage.setItem('theme-source', 'definition');
      } else {
        localStorage.removeItem('theme-definition');
        localStorage.removeItem('theme-source');
      }
    },
    [THEME_PARAM, clickHouseTheme] as const,
  );
}

async function openWithMarkup(page: Page, theme: ThemeChoice, markup: string) {
  await installThemeBridge(page);
  await page.goto(`${NEW_CHAT_PATH}?${THEME_PARAM}=${theme}`, { timeout: 15000 });
  await page.getByTestId('nav-user').waitFor({ timeout: 15000 });
  await page.evaluate((html) => {
    const host = document.createElement('div');
    host.id = 'variant-host';
    host.className = 'bg-surface-primary text-text-primary fixed top-0 left-0 z-[9999] p-4';
    host.innerHTML = html;
    document.body.append(host);
  }, markup);
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

const styleOf = (page: Page, selector: string, properties: string[], focus = false) =>
  page.evaluate(
    async ([sel, names, focused]) => {
      const node = document.querySelector<HTMLElement>(sel);
      if (node == null) {
        throw new Error(`no element for ${sel}`);
      }
      if (focused) {
        node.focus();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      const style = getComputedStyle(node);
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]));
    },
    [selector, properties, focus] as [string, string[], boolean],
  );

const FIELD_PROPS = [
  'border-top-width',
  'border-top-left-radius',
  'padding-top',
  'padding-left',
  'font-size',
  'background-color',
  'box-shadow',
];

for (const theme of THEMES) {
  test.describe(`field and nav variants (${theme} theme)`, () => {
    test(`a flush field draws no border and no focus ring, and keeps its other metrics @scenario:field-flush-draws-no-edge`, async ({
      page,
    }) => {
      const { Input, Textarea, TextareaAutosize } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            h(Input, { 'aria-label': 'flush', id: 'flush', variant: 'flush' }),
            h(Input, {
              'aria-label': 'legacy',
              id: 'legacy',
              className: 'border-0 focus-visible:ring-0',
            }),
            h(Input, { 'aria-label': 'bordered', id: 'bordered' }),
            h(Textarea, { 'aria-label': 'tflush', id: 'tflush', variant: 'flush' }),
            h(TextareaAutosize, { 'aria-label': 'aflush', id: 'aflush', variant: 'flush' }),
          ),
        ),
      );

      for (const id of ['flush', 'tflush', 'aflush']) {
        const resting = await styleOf(page, `#${id}`, ['border-top-width']);
        expect(resting['border-top-width']).toBe('0px');
        const focused = await styleOf(page, `#${id}`, ['box-shadow', 'border-top-width'], true);
        expect(focused['border-top-width']).toBe('0px');
        expect(focused['box-shadow']).toBe('none');
      }

      const bordered = await styleOf(page, '#bordered', ['border-top-width']);
      expect(bordered['border-top-width']).not.toBe('0px');

      if (theme === 'default') {
        expect(await styleOf(page, '#flush', FIELD_PROPS, true)).toEqual(
          await styleOf(page, '#legacy', FIELD_PROPS, true),
        );
      }
    });

    test(`an embedded field fills its row edge to edge from the tertiary fill @scenario:field-embedded-fills-row`, async ({
      page,
    }) => {
      const { Input, TextareaAutosize } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            h(Input, { 'aria-label': 'embedded', id: 'embedded', variant: 'embedded' }),
            h(Input, {
              'aria-label': 'legacy',
              id: 'legacy',
              className: 'bg-surface-tertiary-alt h-auto w-full rounded-none border-0 p-2 text-sm',
            }),
            h(TextareaAutosize, { 'aria-label': 'auto', id: 'auto', variant: 'embedded' }),
          ),
        ),
      );

      const embedded = await styleOf(page, '#embedded', FIELD_PROPS);
      expect(embedded['border-top-width']).toBe('0px');
      expect(embedded['border-top-left-radius']).toBe('0px');
      expect(embedded['padding-top']).toBe('8px');
      expect(embedded['padding-left']).toBe('8px');
      expect(embedded['font-size']).toBe('14px');
      if (theme === 'default') {
        expect(embedded['background-color']).toBe(
          await probeStyle(page, 'bg-surface-tertiary-alt', 'background-color'),
        );
        const metrics = [
          ...FIELD_PROPS.filter((name) => name !== 'background-color'),
          'height',
          'width',
        ];
        expect(await styleOf(page, '#embedded', metrics)).toEqual(
          await styleOf(page, '#legacy', metrics),
        );
      }
      const auto = await styleOf(page, '#auto', ['border-top-width', 'border-top-left-radius']);
      expect(auto).toEqual({ 'border-top-width': '0px', 'border-top-left-radius': '0px' });
    });

    test(`a framed editor draws the medium border, the rounded box and the focus-control ring @scenario:field-framed-matches-editor-box`, async ({
      page,
    }) => {
      const { TextareaAutosize } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            h(TextareaAutosize, { 'aria-label': 'framed', id: 'framed', variant: 'framed' }),
            h(TextareaAutosize, {
              'aria-label': 'legacy',
              id: 'legacy',
              className:
                'rounded-xl border border-border-medium bg-transparent focus-visible:ring-2 focus-visible:ring-focus-control text-text-primary placeholder:text-text-secondary',
            }),
          ),
        ),
      );

      await page.evaluate(() =>
        document.documentElement.setAttribute('data-input-modality', 'keyboard'),
      );
      const props = [...FIELD_PROPS, 'border-top-color', 'color'];
      expect(await styleOf(page, '#framed', props, true)).toEqual(
        await styleOf(page, '#legacy', props, true),
      );
      const framed = await styleOf(
        page,
        '#framed',
        ['border-top-color', 'box-shadow', 'color', 'outline-style'],
        true,
      );
      expect(framed['outline-style']).toBe('none');
      expect(framed['border-top-color']).toBe(
        await probeStyle(page, 'border-border-medium', 'border-top-color'),
      );
      expect(framed['color']).toBe(await probeStyle(page, 'text-text-primary', 'color'));
      expect(framed['box-shadow']).not.toBe('none');
    });

    test(`an invalid Input or Textarea draws the destructive border @scenario:field-invalid-destructive-border`, async ({
      page,
    }) => {
      const { Input, Textarea } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            h(Input, { 'aria-label': 'ok', id: 'ok' }),
            h(Input, { 'aria-label': 'bad', id: 'bad', 'aria-invalid': true }),
            h(Textarea, { 'aria-label': 'tbad', id: 'tbad', 'aria-invalid': true }),
          ),
        ),
      );

      const destructive = await probeStyle(page, 'border-border-destructive', 'border-top-color');
      const ok = await styleOf(page, '#ok', ['border-top-color']);
      expect(ok['border-top-color']).not.toBe(destructive);
      for (const id of ['bad', 'tbad']) {
        expect((await styleOf(page, `#${id}`, ['border-top-color']))['border-top-color']).toBe(
          destructive,
        );
      }

      await page.evaluate(() =>
        document.documentElement.setAttribute('data-input-modality', 'pointer'),
      );
      for (const id of ['bad', 'tbad']) {
        const focused = await styleOf(
          page,
          `#${id}`,
          ['border-top-color', 'box-shadow', 'outline-style'],
          true,
        );
        expect(focused['border-top-color']).toBe(destructive);
        expect(focused['box-shadow']).toBe('none');
        expect(focused['outline-style']).toBe('none');
      }
      const okFocused = await styleOf(page, '#ok', ['border-top-color'], true);
      expect(okFocused['border-top-color']).not.toBe(destructive);
    });

    test(`a nav button rests secondary, hovers on the nav fill and marks the current item with aria-pressed @scenario:button-nav-roles`, async ({
      page,
    }) => {
      const { Button } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            { className: 'flex gap-2' },
            h(Button, { id: 'rest', variant: 'nav', size: 'icon', 'aria-pressed': false }, 'a'),
            h(Button, { id: 'current', variant: 'nav', size: 'icon', 'aria-pressed': true }, 'b'),
          ),
        ),
      );

      const secondary = await probeStyle(page, 'text-text-secondary', 'color');
      const primary = await probeStyle(page, 'text-text-primary', 'color');
      const navHover = await probeStyle(page, 'bg-surface-nav-hover', 'background-color');
      const navSelected = await probeStyle(page, 'bg-surface-nav-selected', 'background-color');

      const rest = await styleOf(page, '#rest', ['color', 'background-color']);
      expect(rest['color']).toBe(secondary);
      expect(rest['background-color']).toBe('rgba(0, 0, 0, 0)');

      const current = await styleOf(page, '#current', ['color', 'background-color']);
      expect(current['color']).toBe(primary);
      expect(current['background-color']).toBe(navSelected);

      await page.locator('#rest').hover();
      await expect
        .poll(async () => (await styleOf(page, '#rest', ['background-color']))['background-color'])
        .toBe(navHover);
      await page.mouse.move(0, 400);
      await page.locator('#current').hover();
      expect((await styleOf(page, '#current', ['background-color']))['background-color']).toBe(
        navSelected,
      );
    });

    test(`the floating label chip paints the field fill when the theme fills fields @scenario:floating-label-chip-field-fill`, async ({
      page,
    }) => {
      const { SecretInput } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(h(SecretInput, { id: 'secret', variant: 'floating', label: 'Password', value: '' })),
      );

      const chip = await page.evaluate(
        () => getComputedStyle(document.querySelector('label[for="secret"]')!).backgroundColor,
      );
      const expectedRole =
        theme === 'clickhouse' ? 'theme-field-fill:bg-field-fill' : 'bg-surface-primary';
      expect(chip).toBe(await probeStyle(page, expectedRole, 'background-color'));
    });

    test(`every field primitive and variant resolves its fill, edge, ring and outline the same way in each state @scenario:field-variant-matrix`, async ({
      page,
    }) => {
      const { Input, Textarea, TextareaAutosize, SecretInput } = await primitives();
      type Fill = 'field' | 'secondary' | 'transparent' | 'embedded';
      type Cell = {
        id: string;
        node: (props: Record<string, unknown>) => React.ReactElement;
        fill: Fill;
        bordered: boolean;
        ring: boolean;
        keyboardOutline: boolean;
        pointerEdge: 'reset' | 'keep' | 'none';
      };
      const lcField = (
        id: string,
        node: Cell['node'],
        fill: Fill,
        variant: 'edged' | 'flush' | 'embedded',
      ): Cell => ({
        id,
        node,
        fill,
        bordered: variant === 'edged',
        ring: variant !== 'flush',
        keyboardOutline: false,
        pointerEdge: variant === 'edged' ? 'reset' : 'none',
      });
      const input = (variant: string) => (p: Record<string, unknown>) =>
        h(Input, { ...p, variant });
      const secret = (variant: string) => (p: Record<string, unknown>) =>
        h(SecretInput, { ...p, variant });
      const area = (variant: string) => (p: Record<string, unknown>) =>
        h(Textarea, { ...p, variant });
      const auto = (variant: string) => (p: Record<string, unknown>) =>
        h(TextareaAutosize, { ...p, variant });
      const cells: Cell[] = [
        lcField('input-default', input('default'), 'field', 'edged'),
        lcField('input-floating', input('floating'), 'field', 'edged'),
        lcField('input-flush', input('flush'), 'transparent', 'flush'),
        lcField('input-embedded', input('embedded'), 'embedded', 'embedded'),
        lcField('secret-default', secret('default'), 'field', 'edged'),
        lcField('secret-flush', secret('flush'), 'transparent', 'flush'),
        lcField('secret-embedded', secret('embedded'), 'embedded', 'embedded'),
        lcField('textarea-default', area('default'), 'secondary', 'edged'),
        lcField('textarea-transparent', area('transparent'), 'transparent', 'edged'),
        lcField('textarea-document', area('document'), 'transparent', 'edged'),
        lcField('textarea-flush', area('flush'), 'transparent', 'flush'),
        lcField('textarea-embedded', area('embedded'), 'embedded', 'embedded'),
        {
          id: 'auto-default',
          node: auto('default'),
          fill: 'transparent',
          bordered: false,
          ring: false,
          keyboardOutline: true,
          pointerEdge: 'none',
        },
        {
          id: 'auto-framed',
          node: auto('framed'),
          fill: 'transparent',
          bordered: true,
          ring: true,
          keyboardOutline: false,
          pointerEdge: 'keep',
        },
        {
          id: 'auto-flush',
          node: auto('flush'),
          fill: 'transparent',
          bordered: false,
          ring: false,
          keyboardOutline: false,
          pointerEdge: 'none',
        },
        {
          id: 'auto-embedded',
          node: auto('embedded'),
          fill: 'embedded',
          bordered: false,
          ring: false,
          keyboardOutline: true,
          pointerEdge: 'none',
        },
      ];

      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            ...cells.flatMap((cell) => [
              h(
                'div',
                { key: cell.id },
                cell.node({ id: cell.id, 'aria-label': cell.id, value: '', onChange: () => null }),
              ),
              h(
                'div',
                { key: `${cell.id}-bad` },
                cell.node({
                  id: `${cell.id}-bad`,
                  'aria-label': `${cell.id}-bad`,
                  'aria-invalid': true,
                  value: '',
                  onChange: () => null,
                }),
              ),
            ]),
          ),
        ),
      );

      const transparent = 'rgba(0, 0, 0, 0)';
      const fills: Record<Fill, string> = {
        field:
          theme === 'clickhouse'
            ? await probeStyle(page, 'theme-field-fill:bg-field-fill', 'background-color')
            : transparent,
        secondary:
          theme === 'clickhouse'
            ? await probeStyle(page, 'theme-field-fill:bg-field-fill', 'background-color')
            : await probeStyle(page, 'bg-surface-secondary', 'background-color'),
        transparent,
        embedded: await probeStyle(page, 'bg-surface-tertiary-alt', 'background-color'),
      };
      const destructive = await probeStyle(page, 'border-border-destructive', 'border-top-color');
      const resetEdge =
        theme === 'clickhouse'
          ? await page.evaluate(() => {
              const probe = document.createElement('div');
              probe.style.cssText =
                'border:1px solid rgb(var(--border-field-focus, var(--focus-control)))';
              document.body.append(probe);
              const color = getComputedStyle(probe).borderTopColor;
              probe.remove();
              return color;
            })
          : await probeStyle(page, 'border-border-light', 'border-top-color');

      const read = (id: string, modality: 'keyboard' | 'pointer' | null) =>
        page.evaluate(
          async ([target, mode]) => {
            const node = document.getElementById(target) as HTMLElement;
            if (document.activeElement instanceof HTMLElement) {
              document.activeElement.blur();
            }
            if (mode === null) {
              document.documentElement.removeAttribute('data-input-modality');
            } else {
              document.documentElement.setAttribute('data-input-modality', mode);
              node.focus();
            }
            await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
            const style = getComputedStyle(node);
            const rings = style.boxShadow
              .split(/,(?![^(]*\))/)
              .map((shadow) => shadow.trim())
              .filter((shadow) => shadow !== 'none' && !shadow.includes('inset'))
              .filter((shadow) =>
                /(^|\s)[1-9]\d*(\.\d+)?px/.test(shadow.replace(/rgba?\([^)]*\)/, '')),
              );
            return {
              fill: style.backgroundColor,
              width: style.borderTopWidth,
              edge: style.borderTopColor,
              ring: rings.length > 0,
              outline: style.outlineStyle !== 'none' && style.outlineColor !== 'rgba(0, 0, 0, 0)',
            };
          },
          [id, modality] as const,
        );

      for (const cell of cells) {
        const label = `${theme} ${cell.id}`;
        const rest = await read(cell.id, null);
        expect.soft(rest.fill, `${label} fill`).toBe(fills[cell.fill]);
        expect.soft(rest.width !== '0px', `${label} draws an edge`).toBe(cell.bordered);

        const keyboard = await read(cell.id, 'keyboard');
        expect.soft(keyboard.fill, `${label} fill on keyboard focus`).toBe(fills[cell.fill]);
        expect.soft(keyboard.ring, `${label} ring on keyboard focus`).toBe(cell.ring);
        expect
          .soft(keyboard.outline, `${label} outline on keyboard focus`)
          .toBe(cell.keyboardOutline);

        const pointer = await read(cell.id, 'pointer');
        expect.soft(pointer.ring, `${label} ring on pointer focus`).toBe(false);
        expect.soft(pointer.outline, `${label} outline on pointer focus`).toBe(false);
        if (cell.pointerEdge === 'reset') {
          expect.soft(pointer.edge, `${label} edge on pointer focus`).toBe(resetEdge);
        }
        if (cell.pointerEdge === 'keep') {
          expect.soft(pointer.edge, `${label} edge on pointer focus`).toBe(rest.edge);
        }

        if (!cell.bordered) {
          continue;
        }
        for (const mode of [null, 'keyboard', 'pointer'] as const) {
          const bad = await read(`${cell.id}-bad`, mode);
          expect.soft(bad.edge, `${label} invalid edge (${mode ?? 'rest'})`).toBe(destructive);
          if (mode === 'pointer') {
            expect.soft(bad.ring, `${label} invalid ring on pointer focus`).toBe(false);
            expect.soft(bad.outline, `${label} invalid outline on pointer focus`).toBe(false);
          }
        }
      }
    });

    test(`flush and framed editors keep the outline as the only indicator under forced colors @scenario:field-variant-matrix`, async ({
      page,
    }) => {
      const { TextareaAutosize } = await primitives();
      await openWithMarkup(
        page,
        theme,
        render(
          h(
            'div',
            null,
            h(TextareaAutosize, { 'aria-label': 'flush', id: 'flush', variant: 'flush' }),
            h(TextareaAutosize, { 'aria-label': 'framed', id: 'framed', variant: 'framed' }),
          ),
        ),
      );
      await page.emulateMedia({ forcedColors: 'active' });
      for (const id of ['flush', 'framed']) {
        const outline = await page.evaluate(async (target) => {
          document.documentElement.setAttribute('data-input-modality', 'keyboard');
          const node = document.getElementById(target) as HTMLElement;
          node.focus();
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          return getComputedStyle(node).outlineStyle;
        }, id);
        expect(outline, `${theme} ${id} outline under forced colors`).not.toBe('none');
      }
    });
  });
}
