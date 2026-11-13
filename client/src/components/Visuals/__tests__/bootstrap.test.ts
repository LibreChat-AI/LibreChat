import { VisualBridgeMethod } from 'librechat-data-provider';
import type { VisualTheme } from '../theme';
import {
  readLinkRequest,
  readBridgeParams,
  readContentHeight,
  visualThemeCss,
  visualThemeMessage,
  injectVisualBootstrap,
} from '../bootstrap';

const theme: VisualTheme = {
  appearance: 'dark',
  variables: { '--foreground': 'rgb(255 255 255)', '--chart-1': 'rgb(9 140 238)' },
};

const bootstrapAt = (html: string) => injectVisualBootstrap(html, theme).indexOf('<style id=');

describe('injectVisualBootstrap', () => {
  it('goes first inside an existing head, ahead of the page styles', () => {
    const html = '<!doctype html><html><head><style>p{}</style></head><body></body></html>';
    const out = injectVisualBootstrap(html, theme);
    expect(out.startsWith('<!doctype html><html><head><meta charset="utf-8">')).toBe(true);
    expect(out.indexOf('librechat-visual-theme')).toBeLessThan(out.indexOf('<style>p{}'));
  });

  it('adds a head after <html> or the doctype when the page has none', () => {
    expect(injectVisualBootstrap('<html><body>x</body></html>', theme)).toMatch(
      /^<html><head><meta charset="utf-8">/,
    );
    expect(injectVisualBootstrap('<!DOCTYPE html><p>x</p>', theme)).toMatch(
      /^<!DOCTYPE html><head><meta/,
    );
  });

  it('wraps a bare fragment in a standards-mode document', () => {
    expect(injectVisualBootstrap('<svg></svg>', theme)).toMatch(/^<!doctype html><head>.*<svg>/);
  });

  it('ignores a <head> that only appears inside a comment or script', () => {
    const html = '<!-- <head> --><script>const s = "<head>";</script><html><head></head></html>';
    const out = injectVisualBootstrap(html, theme);
    expect(bootstrapAt(html)).toBeGreaterThan(out.indexOf('<html><head>'));
  });

  it('keeps an author charset and viewport instead of adding its own', () => {
    const html =
      '<html><head><meta charset="utf-8"><meta name="viewport" content="width=500"></head></html>';
    const out = injectVisualBootstrap(html, theme);
    expect(out.match(/charset/g)).toHaveLength(1);
    expect(out.match(/name="viewport"/g)).toHaveLength(1);
  });
});

describe('visualThemeCss', () => {
  it('styles plain elements without outranking any rule the page writes', () => {
    const css = visualThemeCss(theme);
    const base = css.slice(css.indexOf('}') + 1);
    const selectors = [...base.matchAll(/([^{}]+)\{/g)].map((match) => match[1]);
    expect(selectors.length).toBeGreaterThan(10);
    /** True when the selector is exactly one `:where(…)`, which has no specificity. */
    const isWhereOnly = (selector: string) => {
      if (!selector.startsWith(':where(')) {
        return false;
      }
      let depth = 0;
      for (let index = ':where'.length; index < selector.length; index++) {
        if (selector[index] === '(') {
          depth += 1;
        } else if (selector[index] === ')') {
          depth -= 1;
        }
        if (depth === 0) {
          return index === selector.length - 1;
        }
      }
      return false;
    };
    for (const selector of selectors.filter((entry) => !entry.startsWith('@media'))) {
      /* A pseudo-element after the `:where()` adds one element's weight, which any page rule
       * naming the element itself still outranks. */
      const target = selector.replace(/\)::[\w-]+$/, ')');
      expect(['html', 'body'].includes(target) || isWhereOnly(target)).toBe(true);
    }
  });

  it('writes the appearance and variables onto :root', () => {
    expect(visualThemeCss(theme)).toContain(
      ':root{color-scheme:dark;--foreground:rgb(255 255 255);--chart-1:rgb(9 140 238);}',
    );
  });

  it('drops invalid names and characters that could close the rule', () => {
    const css = visualThemeCss({
      appearance: 'light',
      variables: { '--ok': 'red;}</style><script>', color: 'blue' },
    });
    expect(css).toContain('--ok:red/stylescript;');
    expect(css).not.toContain('color:blue');
    expect(css).not.toContain('</style>');
  });

  it('pairs with the host-context-changed notification', () => {
    expect(visualThemeMessage(theme)).toEqual({
      jsonrpc: '2.0',
      method: VisualBridgeMethod.hostContextChanged,
      params: { css: visualThemeCss(theme) },
    });
  });
});

describe('frame messages', () => {
  const notify = (method: string, params: unknown) => ({ jsonrpc: '2.0', method, params });

  it('reads the params of a JSON-RPC message for one method only', () => {
    const ready = { jsonrpc: '2.0', method: VisualBridgeMethod.proxyReady };
    expect(readBridgeParams(ready, VisualBridgeMethod.proxyReady)).toEqual({});
    expect(readBridgeParams(ready, VisualBridgeMethod.sizeChanged)).toBeUndefined();
    expect(
      readBridgeParams({ method: VisualBridgeMethod.proxyReady }, VisualBridgeMethod.proxyReady),
    ).toBeUndefined();
    expect(readBridgeParams('ready', VisualBridgeMethod.proxyReady)).toBeUndefined();
  });

  it('reads the reported content height, leaving bounds to the host', () => {
    expect(readContentHeight(notify(VisualBridgeMethod.sizeChanged, { height: 321.5 }))).toBe(
      321.5,
    );
    expect(readContentHeight(notify(VisualBridgeMethod.sizeChanged, { height: '9' }))).toBe(
      undefined,
    );
    expect(readContentHeight(notify(VisualBridgeMethod.openLink, { height: 10 }))).toBe(undefined);
  });

  it('only accepts http(s) links', () => {
    expect(
      readLinkRequest(notify(VisualBridgeMethod.openLink, { url: 'https://a.example/x' })),
    ).toBe('https://a.example/x');
    expect(
      readLinkRequest(notify(VisualBridgeMethod.openLink, { url: 'javascript:alert(1)' })),
    ).toBe(undefined);
    expect(readLinkRequest(notify(VisualBridgeMethod.openLink, { url: 'data:text/html,x' }))).toBe(
      undefined,
    );
    expect(readLinkRequest(notify(VisualBridgeMethod.openLink, { url: 'not a url' }))).toBe(
      undefined,
    );
  });
});
