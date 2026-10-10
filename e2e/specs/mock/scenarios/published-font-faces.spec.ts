import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { inOneProject, repoRoot, run } from './lint.helpers';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * `@librechat/client/theme.css` names Inter, Roboto Mono and Inconsolata, and ships their faces:
 * `fonts.css` declares them against the package's own files, which the host's bundler resolves
 * and emits. The consumer scenario builds the documented setup with Vite and
 * `@tailwindcss/postcss`, the combination where a relative `url()` in an imported stylesheet is
 * read against the wrong file, and asks a browser whether each family actually loaded. The app
 * scenario reads the same faces out of the app's own build.
 */

const PROBE_DIR = resolve(repoRoot, 'e2e/specs/.test-results/published-font-faces');
const PACKAGE_ROOT = resolve(repoRoot, 'packages/client');
const FONT_SOURCES = resolve(PACKAGE_ROOT, 'src/theme/fonts');

const FAMILIES = ['Inter', 'Roboto Mono', 'Inconsolata'];

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
};

/** Renders text in `family` and reports the status of each face the browser loaded for it. */
function loadFamily(page: Page, family: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    const faces = await document.fonts.load(`16px "${name}"`, 'probe');
    return faces.map((face) => face.status);
  }, family);
}

test.describe('the published font faces', () => {
  test('a Vite consumer of theme.css loads the package fonts @scenario:a-vite-consumer-loads-the-package-fonts', async ({
    page,
  }) => {
    inOneProject();
    test.setTimeout(300_000);
    rmSync(PROBE_DIR, { recursive: true, force: true });
    mkdirSync(PROBE_DIR, { recursive: true });

    const distFonts = resolve(PACKAGE_ROOT, 'dist/fonts');
    const shipped = readdirSync(FONT_SOURCES);
    let built = true;
    try {
      built = shipped.every((name) => readdirSync(distFonts).includes(name));
    } catch {
      built = false;
    }
    if (!built) {
      const result = run('npm', ['run', 'build', '--prefix', PACKAGE_ROOT]);
      expect(result.status, `the component library did not build:\n${result.output}`).toBe(0);
    }

    /** The documented consumer setup, verbatim except for where its config file lives. The
     *  package itself resolves through node_modules, as it does in a consumer's install. */
    const readme = readFileSync(resolve(PACKAGE_ROOT, 'src/theme/README.md'), 'utf8');
    const blocks = (lang: string) =>
      [...readme.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]);
    const stylesheet = blocks('css').find((css) =>
      css.includes("@import '@librechat/client/style.css';"),
    );
    const tailwindConfig = blocks('js').find((js) =>
      js.includes("require('@librechat/client/tailwind-preset')"),
    );
    const postcssConfig = blocks('js').find((js) => js.includes("'@tailwindcss/postcss'"));
    expect(stylesheet, 'the complete consumer stylesheet is documented').toBeDefined();
    expect(tailwindConfig, 'the consumer preset configuration is documented').toBeDefined();
    expect(postcssConfig, 'the consumer PostCSS configuration is documented').toBeDefined();

    writeFileSync(join(PROBE_DIR, 'tailwind.config.cjs'), tailwindConfig!);
    writeFileSync(join(PROBE_DIR, 'postcss.config.cjs'), postcssConfig!);
    writeFileSync(
      join(PROBE_DIR, 'style.css'),
      stylesheet!.replace(/@config '[^']+';/, "@config './tailwind.config.cjs';"),
    );
    writeFileSync(join(PROBE_DIR, 'main.js'), "import './style.css';\n");
    writeFileSync(
      join(PROBE_DIR, 'index.html'),
      `<!doctype html><html><head><script type="module" src="./main.js"></script></head>
<body><p class="font-sans">Sans</p><code class="font-mono">mono</code></body></html>`,
    );

    /** Vite warns, rather than fails, when a `url()` does not resolve and leaves it to 404 at
     *  runtime, so the build reports its warnings and the test reads them. */
    const outDir = join(PROBE_DIR, 'dist');
    const builder = join(PROBE_DIR, 'build.mjs');
    writeFileSync(
      builder,
      `import { build, createLogger } from 'vite';
const logger = createLogger('warn');
const warnings = [];
logger.warn = (message) => warnings.push(message);
logger.warnOnce = (message) => warnings.push(message);
await build({
  root: ${JSON.stringify(PROBE_DIR)},
  configFile: false,
  customLogger: logger,
  build: { outDir: ${JSON.stringify(outDir)}, emptyOutDir: true },
});
console.log(JSON.stringify(warnings));
`,
    );
    const bundled = run(process.execPath, [builder]);
    expect(bundled.status, `the consumer did not build:\n${bundled.output}`).toBe(0);
    expect(bundled.output).not.toContain("didn't resolve at build time");
    /** An `@import` after `@config` is skipped by Vite's inliner, which would drop the
     *  component stylesheet from the documented setup. */
    expect(bundled.output).not.toContain('@import statements must precede');

    /** Every face ships from the package unchanged, beside the component stylesheet. */
    const assets = readdirSync(join(outDir, 'assets'));
    const bundledCss = assets
      .filter((asset) => asset.endsWith('.css'))
      .map((asset) => readFileSync(join(outDir, 'assets', asset), 'utf8'))
      .join('\n');
    expect(bundledCss).toContain('.animated-tab-panel');
    shipped
      .filter((name) => name.endsWith('.woff2'))
      .forEach((name) => {
        const stem = name.replace(/\.woff2$/, '');
        const emitted = assets.find(
          (asset) => asset.startsWith(`${stem}-`) && asset.endsWith('.woff2'),
        );
        expect(emitted, `${name} was not emitted`).toBeDefined();
        expect(
          readFileSync(join(outDir, 'assets', emitted!)).equals(
            readFileSync(join(FONT_SOURCES, name)),
          ),
        ).toBe(true);
      });

    await page.route('http://consumer.test/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const path = pathname === '/' ? '/index.html' : pathname;
      try {
        const body = readFileSync(join(outDir, path));
        await route.fulfill({ body, contentType: CONTENT_TYPES[extname(path)] ?? 'text/plain' });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
    await page.goto('http://consumer.test/');

    for (const family of FAMILIES) {
      expect({ family, statuses: await loadFamily(page, family) }).toEqual({
        family,
        statuses: ['loaded'],
      });
    }
    /** The stock families are what the plain utilities render. */
    expect(
      await page.locator('p.font-sans').evaluate((el) => getComputedStyle(el).fontFamily),
    ).toMatch(/^Inter,/);
    expect(
      await page.locator('code.font-mono').evaluate((el) => getComputedStyle(el).fontFamily),
    ).toMatch(/^"Roboto Mono",/);
  });

  test('the app loads its stock faces and licences from the package @scenario:the-app-loads-its-stock-faces-from-the-package', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
      timeout: 30000,
    });

    for (const family of ['Inter', 'Roboto Mono']) {
      expect({ family, statuses: await loadFamily(page, family) }).toEqual({
        family,
        statuses: ['loaded'],
      });
    }

    for (const name of readdirSync(FONT_SOURCES)) {
      const response = await page.request.get(`/assets/fonts/${name}`);
      expect([name, response.status()]).toEqual([name, 200]);
      expect((await response.body()).equals(readFileSync(join(FONT_SOURCES, name)))).toBe(true);
    }
  });
});
