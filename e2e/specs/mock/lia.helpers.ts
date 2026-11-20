import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import type { Page } from '@playwright/test';

const ENGINE = path.resolve(__dirname, '../../../client/src/components/Lia/engine');
const ORIGIN = 'http://lia.test';

/**
 * Serves Lia's engine modules to a blank page and exposes them as `window.lia[name]`, so a spec
 * can drive the renderer and the engine with a real browser canvas and animation frames.
 */
export async function openLiaEngine(page: Page, modules: readonly string[]) {
  await page.route(`${ORIGIN}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (!name) {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    }
    if (!/^[a-z]+$/.test(name)) {
      return route.fulfill({ status: 404 });
    }
    const source = fs.readFileSync(path.join(ENGINE, `${name}.ts`), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return route.fulfill({ contentType: 'text/javascript', body: outputText });
  });
  await page.goto(`${ORIGIN}/`);
  const imports = modules.map((name) => `import * as ${name} from '/${name}';`).join(' ');
  await page.addScriptTag({
    type: 'module',
    content: `${imports} window.lia = { ${modules.join(', ')} };`,
  });
  await page.waitForFunction(() => 'lia' in window);
}
