import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
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

test.describe('tool group header cascade', () => {
  let markup: string;
  let libraryCss: string;
  let appCss: string;

  test.beforeAll(async ({ browserName }, testInfo) => {
    const fixturePath = testInfo.outputPath(`tool-group-${browserName}.html`);
    mkdirSync(resolve(fixturePath, '..'), { recursive: true });
    const rendered = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/jest/bin/jest.js'),
        'src/components/parts/group/__tests__/Header.spec.tsx',
        '--maxWorkers=2',
        '-t',
        'exports the real group header for the browser cascade checks',
      ],
      {
        cwd: resolve(repoRoot, 'packages/chat'),
        env: { ...process.env, E2E_TOOL_GROUP_CASCADE_FIXTURE: fixturePath },
        encoding: 'utf8',
      },
    );
    expect(rendered.status, rendered.stdout + rendered.stderr).toBe(0);
    markup = readFileSync(fixturePath, 'utf8');
    const compilerPath = testInfo.outputPath('compile-tool-group.cjs');
    const compiledPath = testInfo.outputPath('tool-group-app.css');
    writeFileSync(
      compilerPath,
      `const {readFileSync, writeFileSync} = require('node:fs');
const postcss = require(${JSON.stringify(require.resolve('postcss'))});
const tailwind = require(${JSON.stringify(require.resolve('@tailwindcss/postcss'))});
const input = ${JSON.stringify(resolve(repoRoot, 'client/src/style.css'))};
postcss([tailwind()]).process(readFileSync(input, 'utf8'), {from: input})
  .then(result => writeFileSync(${JSON.stringify(compiledPath)}, result.css))
  .catch(error => { console.error(error); process.exitCode = 1; });`,
    );
    const compiled = run(process.execPath, [compilerPath]);
    expect(compiled.status, compiled.output).toBe(0);
    libraryCss = readFileSync(DIST_STYLESHEET, 'utf8');
    appCss = readFileSync(compiledPath, 'utf8');
  });

  for (const { mode, reference, scenario } of [
    { mode: 'light', reference: false, scenario: '@scenario:tool-group-header-light-cascade' },
    { mode: 'dark', reference: false, scenario: '@scenario:tool-group-header-dark-cascade' },
    { mode: 'light', reference: true, scenario: '@scenario:tool-group-header-light-reference' },
    { mode: 'dark', reference: true, scenario: '@scenario:tool-group-header-dark-reference' },
  ] as const) {
    test(`preserves inherited header appearance ${scenario}`, async ({ page }) => {
      await page.setContent(
        `<!doctype html><html class="${mode}"><head></head><body>
<div class="message-content" style="width:600px" data-version="before">${markup}</div>
<div class="message-content" style="width:600px" data-version="after">${markup}</div>
</body></html>`,
      );
      // Load both complete stylesheets in main.jsx order, including every competing selector.
      await page.addStyleTag({ content: libraryCss });
      await page.addStyleTag({ content: appCss });
      await page.evaluate((changed) => {
        // Freeze dev's original control recipe; the surrounding DOM is pinned by the header spec.
        const before = document.querySelector('[data-version="before"] button')!;
        before.className =
          'text-text-secondary hover:text-text-secondary focus-visible:ring-focus-subtle inline-flex h-auto min-w-0 flex-1 items-center justify-start gap-2 rounded-none bg-transparent p-0 py-1 hover:bg-transparent focus-visible:ring-2 focus-visible:ring-offset-0 focus-visible:outline-none';
        const detail = document.querySelector('[data-version="before"] [title="Create File"]')!;
        detail.classList.replace('max-w-2/5', 'max-w-[40%]');
        if (changed) {
          document.documentElement.style.setProperty('--markdown-font-size', '20px');
          document.documentElement.style.setProperty('--font-size-base', '18px');
          document.documentElement.style.setProperty('--theme-control-font-weight', '800');
          document.body.style.fontWeight = '700';
        }
      }, reference);
      for (const state of ['rest', 'hover', 'focus']) {
        const read = async (version: string) => {
          const button = page.locator(`[data-version="${version}"] button`);
          await page.mouse.move(0, 0);
          await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
          if (state === 'hover') {
            await button.hover();
          } else if (state === 'focus') {
            await page.keyboard.press('Tab');
            await button.focus();
          }
          return button.evaluate((element) => {
            const properties = [
              'font-size',
              'font-weight',
              'line-height',
              'padding',
              'width',
              'height',
              'color',
              'background-color',
              'border-radius',
              'outline',
              'box-shadow',
              'transition-property',
              'transition-duration',
              'max-width',
            ];
            return [
              element,
              ...element.querySelectorAll('[role="status"], [title="Create File"]'),
            ].map((target) => {
              const style = getComputedStyle(target);
              return Object.fromEntries(
                properties.map((name) => [name, style.getPropertyValue(name)]),
              );
            });
          });
        };
        const before = await read('before');
        const after = await read('after');
        expect(after, `${mode} reference=${reference} ${state}`).toEqual(before);
        expect(after[0]['transition-duration']).toBe('0s');
        expect(after[after.length - 1]['max-width']).toBe('40%');
      }
    });
  }
});

/** The client test renders both real consumers. Only this browser lane asks it to save markup,
 *  so ordinary Jest needs neither a browser binary nor the browser lane's services. */
test.describe('phase label animation cascade', () => {
  let fixture: { ticker: string; entrance: string; reduced: string };
  let css: string;

  test.beforeAll(async ({ browserName }, testInfo) => {
    const fixturePath = testInfo.outputPath(`phase-label-${browserName}.json`);
    mkdirSync(resolve(fixturePath, '..'), { recursive: true });
    const rendered = spawnSync(
      process.execPath,
      [
        resolve(repoRoot, 'node_modules/jest/bin/jest.js'),
        'src/components/Chat/Messages/Content/__tests__/ActivityPhaseGroup.test.tsx',
        '--maxWorkers=2',
        '-t',
        'exports real phase consumers for the browser cascade checks',
      ],
      {
        cwd: resolve(repoRoot, 'client'),
        env: { ...process.env, E2E_PHASE_CASCADE_FIXTURE: fixturePath },
        encoding: 'utf8',
      },
    );
    expect(rendered.status, rendered.stdout + rendered.stderr).toBe(0);
    fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
    const compilerPath = testInfo.outputPath('compile.cjs');
    const compiledPath = testInfo.outputPath('app.css');
    writeFileSync(
      compilerPath,
      `const {readFileSync, writeFileSync} = require('node:fs');
const postcss = require(${JSON.stringify(require.resolve('postcss'))});
const tailwind = require(${JSON.stringify(require.resolve('@tailwindcss/postcss'))});
const input = ${JSON.stringify(resolve(repoRoot, 'client/src/style.css'))};
postcss([tailwind()]).process(readFileSync(input, 'utf8'), {from: input})
  .then(result => writeFileSync(${JSON.stringify(compiledPath)}, result.css))
  .catch(error => { console.error(error); process.exitCode = 1; });`,
    );
    const compiled = run(process.execPath, [compilerPath]);
    expect(compiled.status, compiled.output).toBe(0);
    css = `${readFileSync(DIST_STYLESHEET, 'utf8')}\n${readFileSync(compiledPath, 'utf8')}`;
  });

  test('keeps the ticker curve, duration and retired fill @scenario:phase-label-ticker-cascade', async ({
    page,
  }) => {
    await page.setContent(`<style>${css}</style>${fixture.ticker}`);
    await expect(page.locator('.animate-in')).toHaveCSS(
      'animation-timing-function',
      'cubic-bezier(0.16, 1, 0.3, 1)',
    );
    await expect(page.locator('.animate-out')).toHaveCSS(
      'animation-timing-function',
      'cubic-bezier(0.16, 1, 0.3, 1)',
    );
    await expect(page.locator('.animate-in')).toHaveCSS('animation-duration', '0.3s');
    await expect(page.locator('.animate-out')).toHaveCSS('animation-duration', '0.3s');
    await expect(page.locator('.animate-in')).toHaveCSS('animation-fill-mode', 'none');
    await expect(page.locator('.animate-out')).toHaveCSS('animation-fill-mode', 'forwards');
  });

  for (const { reduced, scenario } of [
    { reduced: false, scenario: '@scenario:phase-label-entrance-normal-cascade' },
    { reduced: true, scenario: '@scenario:phase-label-entrance-reduced-cascade' },
  ]) {
    test(`keeps the phase entrance with reduced motion ${reduced} ${scenario}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await page.setContent(`<style>${css}</style>${fixture.entrance}`);
      const card = page.getByTestId('activity-phase-card');
      await expect(card).toHaveCSS(
        'animation-timing-function',
        reduced ? 'ease' : 'cubic-bezier(0.16, 1, 0.3, 1)',
      );
      await expect(card).toHaveCSS('animation-duration', reduced ? '0s' : '0.3s');
      await expect(card).toHaveCSS('animation-fill-mode', 'none');
      await expect(card).toHaveCSS('animation-name', reduced ? 'none' : 'enter');
    });
  }

  test('calms the ticker and shimmer for reduced motion @scenario:phase-label-reduced-motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(`<style>${css}</style>${fixture.reduced}`);
    await expect(page.locator('.shimmer-clip')).toHaveCSS('display', 'none');
    await expect(page.locator('.animate-in, .animate-out')).toHaveCount(0);
  });
});
