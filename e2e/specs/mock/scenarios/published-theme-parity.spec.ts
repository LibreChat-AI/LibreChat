import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * The app and a consumer of `@librechat/client` are meant to render the same
 * theme contract: the same radius, font, type and shadow scales, the same color
 * roles, and the same stock value behind each. The app compiles the package's
 * theme sources directly, while a consumer compiles what the build copies into
 * `dist` through the `./theme.css` export and the published preset, so the two
 * drift apart the moment one of them grows a mapping or a default the other
 * lacks, or the build stops shipping a file the export imports.
 *
 * This scenario compiles both from what each actually loads, renders the same
 * probe under each in a browser, and compares what the browser computes, in
 * light and in dark.
 */

type ClientManifest = { exports: Record<string, string>; files: string[] };

const PROBE_DIR = resolve(repoRoot, 'e2e/specs/.test-results/published-theme-parity');
const PACKAGE_ROOT = resolve(repoRoot, 'packages/client');
const APP_STYLESHEET = resolve(repoRoot, 'client/src/style.css');
const DIST_STYLESHEET = resolve(PACKAGE_ROOT, 'dist/style.css');

/** The theme sources the build copies, each of which must ship unchanged. */
const THEME_SOURCES = ['tokens.css', 'defaults.css'];

const SCALE = [
  'rounded',
  'rounded-sm',
  'rounded-md',
  'rounded-lg',
  'rounded-xl',
  'rounded-2xl',
  'rounded-3xl',
  'rounded-theme-control',
  'rounded-theme-control-round',
  'rounded-theme-surface',
  'rounded-theme-surface-lg',
  'font-sans',
  'font-mono',
  'font-theme-ui',
  'font-display',
  'text-xs',
  'text-sm',
  'text-base',
  'text-lg',
  'text-xl',
  'text-2xl',
  'shadow',
  'shadow-2xs',
  'shadow-xs',
  'shadow-sm',
  'shadow-md',
  'shadow-lg',
  'shadow-xl',
  'shadow-2xl',
  'shadow-theme-surface',
];
const COMPUTED = [
  'border-top-left-radius',
  'font-family',
  'font-size',
  'line-height',
  'box-shadow',
  'background-color',
];

/** Every custom property a rule in `stylesheet` declares. */
function declaredProperties(stylesheet: string): string[] {
  return [...new Set(Array.from(stylesheet.matchAll(/^\s+(--[\w-]+):/gm), (match) => match[1]))];
}

function compile(entries: Array<[string, string]>): void {
  const compiler = join(PROBE_DIR, 'compile.cjs');
  writeFileSync(
    compiler,
    `const postcss = require('postcss');
const tailwind = require('@tailwindcss/postcss');
const { readFileSync, writeFileSync } = require('node:fs');
Promise.all(${JSON.stringify(entries)}.map(async ([input, output]) => {
  const result = await postcss([tailwind()]).process(readFileSync(input, 'utf8'), { from: input });
  writeFileSync(output, result.css);
}))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
`,
  );
  const compiled = run(process.execPath, [compiler]);
  expect(compiled.status, `a stylesheet did not compile:\n${compiled.output}`).toBe(0);
}

type Snapshot = Record<string, Record<string, string>>;

/** What the browser computes for every probe element and every root property, per mode. */
async function snapshot(
  page: Page,
  css: string,
  markup: string,
  properties: string[],
): Promise<Record<'light' | 'dark', Snapshot>> {
  await page.setContent(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  await page.addStyleTag({ content: css });
  const read = () =>
    page.evaluate(
      ([computed, rootProperties]) => {
        const result: Record<string, Record<string, string>> = {};
        const rootStyles = getComputedStyle(document.documentElement);
        result[':root'] = Object.fromEntries(
          rootProperties.map((name) => [name, rootStyles.getPropertyValue(name).trim()]),
        );
        document.querySelectorAll<HTMLElement>('[data-probe]').forEach((element) => {
          const styles = getComputedStyle(element);
          result[element.dataset.probe!] = Object.fromEntries(
            computed.map((name) => [name, styles.getPropertyValue(name)]),
          );
        });
        return result;
      },
      [COMPUTED, properties] as const,
    );

  const light = await read();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  const dark = await read();
  return { light, dark };
}

test.describe('the published theme contract', () => {
  test('a consumer renders the scales, roles and defaults the app renders @scenario:a-consumer-renders-the-theme-contract-the-app-renders', async ({
    page,
  }) => {
    inOneProject();
    test.setTimeout(300_000);
    mkdirSync(PROBE_DIR, { recursive: true });

    const manifest = JSON.parse(
      readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as ClientManifest;
    const tokenStylesheet = resolve(PACKAGE_ROOT, manifest.exports['./theme.css']);
    const distDirectory = dirname(tokenStylesheet);
    const shipped = THEME_SOURCES.map((name) => join(distDirectory, name));
    if (![DIST_STYLESHEET, ...shipped].every((file) => existsSync(file))) {
      const built = run('npm', ['run', 'build', '--prefix', PACKAGE_ROOT]);
      expect(built.status, `the component library did not build:\n${built.output}`).toBe(0);
    }

    /** The build output is the contract: every theme source ships byte for byte, so a
     *  stale `dist` fails here instead of comparing the app against an older package. */
    THEME_SOURCES.forEach((name) => {
      const source = readFileSync(resolve(PACKAGE_ROOT, 'src/theme', name), 'utf8');
      expect(
        readFileSync(join(distDirectory, name), 'utf8'),
        `dist/${name} differs from src/theme/${name}; rebuild the package`,
      ).toBe(source);
    });

    /** Every stylesheet the export imports has to resolve inside the published files, or
     *  it resolves in the monorepo and fails in the consumer's install. */
    const exported = readFileSync(tokenStylesheet, 'utf8');
    const imports = Array.from(exported.matchAll(/@import '([^']+)'/g), (match) => match[1]);
    expect(imports).toContain('./defaults.css');
    imports.forEach((specifier) => {
      const target = resolve(distDirectory, specifier);
      expect(existsSync(target), `${specifier} is missing from the build output`).toBe(true);
      const path = relative(PACKAGE_ROOT, target);
      expect(
        manifest.files.some((entry) => path === entry || path.startsWith(`${entry}/`)),
        `${path} is not inside the published files: ${manifest.files.join(', ')}`,
      ).toBe(true);
    });

    const colors = Array.from(exported.matchAll(/--color-([\w-]+):/g), (match) => `bg-${match[1]}`);
    expect(colors.length).toBeGreaterThan(80);
    const candidates = [...SCALE, ...colors];
    const markup = candidates
      .map((candidate) => `<div data-probe="${candidate}" class="${candidate}">probe</div>`)
      .join('\n');
    const probeMarkup = join(PROBE_DIR, 'probe.html');
    writeFileSync(probeMarkup, markup);

    /** The consumer compiles the documented setup, pointed at the build output. */
    const readme = readFileSync(resolve(PACKAGE_ROOT, 'src/theme/README.md'), 'utf8');
    const documentedStylesheet = [...readme.matchAll(/```css\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((stylesheet) => stylesheet.includes("@import '@librechat/client/style.css';"));
    const documentedConfig = [...readme.matchAll(/```js\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .find((config) => config.includes("require('@librechat/client/tailwind-preset')"));
    expect(documentedStylesheet, 'the complete consumer stylesheet is documented').toBeDefined();
    expect(documentedConfig, 'the consumer preset configuration is documented').toBeDefined();
    const consumerConfig = join(PROBE_DIR, 'tailwind.config.cjs');
    writeFileSync(
      consumerConfig,
      documentedConfig!.replace(
        "require('@librechat/client/tailwind-preset')",
        `require(${JSON.stringify(resolve(PACKAGE_ROOT, manifest.exports['./tailwind-preset']))})`,
      ),
    );
    const consumerEntry = join(PROBE_DIR, 'consumer.css');
    writeFileSync(
      consumerEntry,
      [
        documentedStylesheet!
          .replace("@import '@librechat/client/theme.css';", `@import '${tokenStylesheet}';`)
          .replace("@import '@librechat/client/style.css';", `@import '${DIST_STYLESHEET}';`)
          .replace(/@config '[^']+';/, `@config '${consumerConfig}';`),
        `@source '${probeMarkup}';`,
        '',
      ].join('\n'),
    );

    /** The app compiles its own entry, exactly as its build does. */
    const appEntry = join(PROBE_DIR, 'app.css');
    writeFileSync(appEntry, `@import '${APP_STYLESHEET}';\n@source '${probeMarkup}';\n`);

    const consumerCompiled = join(PROBE_DIR, 'consumer.out.css');
    const appCompiled = join(PROBE_DIR, 'app.out.css');
    compile([
      [consumerEntry, consumerCompiled],
      [appEntry, appCompiled],
    ]);

    const defaults = readFileSync(join(distDirectory, 'defaults.css'), 'utf8');
    const properties = declaredProperties(defaults);
    expect(properties).toEqual(expect.arrayContaining(['--border-control', '--theme-radius-sm']));

    const app = await snapshot(page, readFileSync(appCompiled, 'utf8'), markup, properties);
    const consumer = await snapshot(
      page,
      readFileSync(consumerCompiled, 'utf8'),
      markup,
      properties,
    );

    /** Guard against a vacuous match: the probe has to render something in both. */
    expect(app.light['rounded-sm']['border-top-left-radius']).toBe('4px');
    expect(app.light['text-sm']['font-size']).toBe('14px');
    expect(app.light['bg-surface-primary']['background-color']).toBe('rgb(255, 255, 255)');
    expect(app.dark[':root']['--surface-primary']).not.toBe(
      app.light[':root']['--surface-primary'],
    );

    expect(consumer.light).toEqual(app.light);
    expect(consumer.dark).toEqual(app.dark);
  });
});
