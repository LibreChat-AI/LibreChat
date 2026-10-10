import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { repoRoot, run } from './lint.helpers';

/**
 * The SPA is not the only consumer of `@librechat/client`, and three of Tailwind
 * 4's changes land on the published components rather than on this app:
 *
 *   - `button` lost its pointer cursor from preflight. The SPA restores it in
 *     its own stylesheet, so the rule has to ship with the package too.
 *   - an uncoloured `border-b` is painted with `currentColor`, so a divider
 *     drawn by a primitive follows the text ink unless the primitive names a
 *     role.
 *   - the radius scale is Tailwind's unless the package states its own, so
 *     `rounded-sm` would mean whatever the current major says it means.
 *
 * The scenario builds what a consumer actually installs: the package's own
 * stylesheet and its published preset, compiled by Tailwind through the
 * documented consumer config, and asks a browser holding nothing else what the
 * primitives' class strings render as.
 */

type ClientManifest = { exports: Record<string, string> };

const PROBE_DIR = resolve(repoRoot, 'e2e/specs/.test-results/published-consumer');
const DIST_STYLESHEET = resolve(repoRoot, 'packages/client/dist/style.css');
const PACKAGE_ROOT = resolve(repoRoot, 'packages/client');

/** The class strings below are the published primitives' own, copied from the
 *  components so the probe cannot drift away from what ships. */
const ACCORDION_ITEM = 'border-b border-border-light';
const CHECKBOX_BOX = 'h-4 w-4 shrink-0 rounded-sm border';
const SEARCH_FIELD = 'w-full bg-transparent text-sm';
const BUTTON_DISABLED = 'disabled:cursor-not-allowed';

test.describe('the published package appearance', () => {
  test('a standalone consumer keeps the package cursor, borders and radii @scenario:a-standalone-consumer-keeps-the-package-cursor-border-and-radii', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(PROBE_DIR, { recursive: true });

    /** What the consumer imports as `@librechat/client/style.css` and
     *  `@librechat/client/theme.css`. Both are build artifacts, so the mock lane
     *  and the verify runner build the packages first; building here as well
     *  keeps the scenario runnable on its own. */
    const manifest = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as ClientManifest;
    const tokenStylesheet = resolve(PACKAGE_ROOT, manifest.exports['./theme.css']);
    if (!existsSync(DIST_STYLESHEET) || !existsSync(tokenStylesheet)) {
      const built = run('npm', ['run', 'build', '--prefix', PACKAGE_ROOT]);
      expect(built.status, `the component library did not build:\n${built.output}`).toBe(0);
    }

    /** The markup the compile is allowed to see, so the utilities it emits are
     *  exactly the ones the primitives ask for. */
    const markup = `<div id="divider" class="${ACCORDION_ITEM}">divider</div>
<div id="box" class="${CHECKBOX_BOX}"></div>
<input id="search" class="${SEARCH_FIELD}" placeholder="Search" />
<button id="enabled" class="${BUTTON_DISABLED}">enabled</button>
<button id="disabled" class="${BUTTON_DISABLED}" disabled>disabled</button>
<div id="gray-500" class="bg-gray-500"></div>
<div id="green-500" class="bg-green-500"></div>
<div id="gray-950" class="bg-gray-950"></div>
<div id="green-950" class="bg-green-950"></div>`;
    const probeMarkup = join(PROBE_DIR, 'probe.html');
    writeFileSync(probeMarkup, markup);

    /** Compile the complete stylesheet example itself, so a missing import in
     *  the README cannot be hidden by a separately maintained correct fixture. */
    const readme = readFileSync(resolve(PACKAGE_ROOT, 'src/theme/README.md'), 'utf8');
    const documentedStylesheet = [...readme.matchAll(/```css\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((stylesheet) => stylesheet.includes("@import '@librechat/client/style.css';"));
    expect(documentedStylesheet, 'the complete consumer stylesheet is documented').toBeDefined();
    const documentedConfig = [...readme.matchAll(/```js\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((config) => config.includes("require('@librechat/client/tailwind-preset')"));
    expect(documentedConfig, 'the consumer preset configuration is documented').toBeDefined();
    const consumerConfig = join(PROBE_DIR, 'tailwind.config.cjs');
    writeFileSync(consumerConfig, documentedConfig!);
    const entry = join(PROBE_DIR, 'consumer.css');
    writeFileSync(
      entry,
      [
        documentedStylesheet!
          .replace("@import '@librechat/client/theme.css';", `@import '${tokenStylesheet}';`)
          .replace("@import '@librechat/client/style.css';", `@import '${DIST_STYLESHEET}';`)
          .replace(/@config '[^']+';/, `@config '${consumerConfig}';`),
        `@source '${probeMarkup}';`,
        '',
      ].join('\n'),
    );

    const compiler = join(PROBE_DIR, 'compile.cjs');
    const compiled = join(PROBE_DIR, 'consumer.out.css');
    const baseline = join(PROBE_DIR, 'baseline.css');
    const baselineCompiled = join(PROBE_DIR, 'baseline.out.css');
    writeFileSync(baseline, `@import 'tailwindcss' source(none);\n@source '${probeMarkup}';\n`);
    writeFileSync(
      compiler,
      `const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const { readFileSync, writeFileSync } = require('node:fs');
Promise.all(${JSON.stringify([
        [entry, compiled],
        [baseline, baselineCompiled],
      ])}.map(async ([input, output]) => {
  const result = await postcss([tailwind()]).process(readFileSync(input, 'utf8'), { from: input });
  writeFileSync(output, result.css);
}))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
`,
    );
    const compile = run(process.execPath, [compiler]);
    expect(compile.status, `the consumer stylesheet did not compile:\n${compile.output}`).toBe(0);
    const consumerCss = readFileSync(compiled, 'utf8');

    /** The consumer's own page restates two roles as channel triplets, the way
     *  the ThemeProvider writes them, so the probe can tell them from the stock
     *  values `theme.css` ships. Everything else is what a consumer following
     *  the theme README gets. */
    await page.setContent(
      `<!doctype html><html><head><style>
        :root { --border-light: 10 20 30; --text-secondary: 40 50 60; }
        body { color: rgb(200 0 0); }
      </style></head><body>${markup}</body></html>`,
    );
    const read = (id: string, properties: string[]) =>
      page.evaluate(
        ([selector, names]) => {
          const element = document.getElementById(selector as string)!;
          const styles = getComputedStyle(element);
          return Object.fromEntries(
            (names as string[]).map((name) => [name, styles.getPropertyValue(name)]),
          );
        },
        [id, properties] as const,
      );

    const palette = ['gray-500', 'green-500', 'gray-950', 'green-950'];
    const readPalette = () => Promise.all(palette.map((id) => read(id, ['background-color'])));
    const baselineStyle = await page.addStyleTag({
      content: readFileSync(baselineCompiled, 'utf8'),
    });
    const defaultPalette = await readPalette();
    await baselineStyle.evaluate((element) => element.remove());
    await page.addStyleTag({ content: consumerCss });
    expect(await readPalette(), 'the library must preserve the host Tailwind palette').toEqual(
      defaultPalette,
    );

    /** Tailwind 4 renamed the radius steps (the old `sm` is `xs`, and `sm` is
     *  0.25rem), so the package states its own: `rounded-sm` reads the theme's
     *  `--theme-radius-sm`, which ships at the app's `calc(0.5rem - 4px)`. */
    const box = await read('box', ['border-radius']);
    expect(box['border-radius']).toBe('4px');

    /** And the step is a theme property, so a theme retunes it the way the
     *  ThemeProvider does, by writing the property on the root. */
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--theme-radius-sm', '10px'),
    );
    expect((await read('box', ['border-radius']))['border-radius']).toBe('10px');
    await page.evaluate(() => document.documentElement.style.removeProperty('--theme-radius-sm'));

    /** The px offset holds the corner the app draws at any root font size: at a
     *  10px root the step is 5px - 4px, exactly as in the app. */
    await page.evaluate(() => document.documentElement.style.setProperty('font-size', '10px'));
    expect((await read('box', ['border-radius']))['border-radius']).toBe('1px');
    await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));

    /** A search field's placeholder reads as secondary text, not as the field's
     *  own ink at half strength, which is what Tailwind 4's preflight would
     *  leave a consumer with. */
    const placeholder = await page.evaluate(() => {
      const element = document.getElementById('search')!;
      return getComputedStyle(element, '::placeholder').color;
    });
    expect(placeholder).toBe('rgb(40, 50, 60)');

    /** A primitive's divider takes its colour from the role it names, not from
     *  the text ink Tailwind 4 would otherwise inherit. */
    const divider = await read('divider', ['border-bottom-color', 'color']);
    expect(divider['border-bottom-color']).toBe('rgb(10, 20, 30)');
    expect(divider['border-bottom-color']).not.toBe(divider.color);

    /** The pointer cursor ships with the package, and it ships in `base`, so a
     *  disabled button still reads as not-allowed. */
    expect((await read('enabled', ['cursor'])).cursor).toBe('pointer');
    expect((await read('disabled', ['cursor'])).cursor).toBe('not-allowed');
  });
});
