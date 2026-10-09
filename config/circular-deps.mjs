import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');

/**
 * Module graphs checked for cycles. `alias` mirrors each target's tsconfig
 * paths (or module-alias for the legacy server); `internal` lists the aliased
 * specifier prefixes that are first-party alongside relative/absolute imports.
 * `minModules` is a resolution-rot guard: if a graph shrinks below it, the
 * scan is no longer seeing the real codebase and must fail rather than
 * silently pass.
 */
const targets = [
  {
    name: '@librechat/api',
    dir: 'packages/api',
    entries: ['src/index.ts', 'src/telemetry.ts'],
    alias: { '~': 'src' },
    internal: ['~'],
    minModules: 200,
  },
  {
    name: 'librechat-data-provider',
    dir: 'packages/data-provider',
    entries: ['src/index.ts', 'src/react-query/index.ts'],
    alias: { 'librechat-data-provider/react-query': 'src/react-query/index.ts', src: 'src' },
    internal: ['src/', 'librechat-data-provider/react-query'],
    minModules: 20,
    /**
     * Grandfathered: the core type modules (schemas, config, api-endpoints,
     * types/{assistants,agents,runs,web}) hold six pre-existing type-only
     * knots that need their own untangling PR. Runtime edges are still
     * enforced; the exclusion is logged on every run so it cannot read as
     * full coverage.
     */
    typeEdges: false,
  },
  {
    name: '@librechat/data-schemas',
    dir: 'packages/data-schemas',
    entries: ['src/index.ts', 'src/admin/capabilities.ts'],
    alias: { '~': 'src' },
    internal: ['~'],
    minModules: 75,
  },
  {
    name: '@librechat/client',
    dir: 'packages/client',
    entries: ['src/index.ts'],
    alias: { '~': 'src' },
    internal: ['~'],
    minModules: 100,
  },
  {
    name: 'api server',
    dir: 'api',
    entries: ['server/index.js'],
    alias: { '~': '.' },
    internal: ['~'],
    minModules: 150,
  },
];

/**
 * Recursively collects every type-only dependency specifier: `import type` /
 * `export type ... from` declarations, inline type specifiers (`import { type
 * Foo } from` — kind lives on the child specifier, source on the parent), and
 * `import('...')` type expressions (TSImportType), which nest arbitrarily deep
 * inside other declarations. All forms carry the specifier as `source.value`.
 */
const collectTypeSpecifiers = (node, specifiers) => {
  if (node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectTypeSpecifiers(item, specifiers);
    }
    return;
  }
  const typeOnly =
    node.type === 'TSImportType' ||
    (node.importKind ?? node.exportKind) === 'type' ||
    (Array.isArray(node.specifiers) &&
      node.specifiers.some((s) => (s.importKind ?? s.exportKind) === 'type'));
  if (typeOnly && typeof node.source?.value === 'string') {
    specifiers.add(node.source.value);
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') {
      collectTypeSpecifiers(value, specifiers);
    }
  }
};

/**
 * Bundlers erase type-only edges before building the module graph, so purely
 * type-level cycles (the declaration-graph kind) would never be reported.
 * Re-materialize each type-only specifier as a bare side-effect import so the
 * scanned graph carries type edges too. Uses the real parser (not a regex) so
 * imports inside string templates never count.
 */
const typeEdgesPlugin = (parseAst) => ({
  name: 'type-edges',
  transform(code, id) {
    const extension = /\.([mc]?tsx?)(?:$|\?)/.exec(id)?.[1];
    if (!extension) {
      return null;
    }
    const { body } = parseAst(code, { lang: extension.endsWith('x') ? 'tsx' : 'ts' });
    const specifiers = new Set();
    collectTypeSpecifiers(body, specifiers);
    if (specifiers.size === 0) {
      return null;
    }
    const edges = [...specifiers].map((s) => `\nimport ${JSON.stringify(s)};`).join('');
    return { code: code + edges, map: null };
  },
});

/** Stub style/asset imports: rolldown no longer bundles CSS, and assets carry no module edges. */
const assetsPlugin = {
  name: 'assets-as-empty',
  load(id) {
    if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp)(?:$|\?)/.test(id)) {
      return { code: 'export {};', moduleType: 'js' };
    }
    return null;
  },
};

/** Loads the rolldown instance the tsdown builds run on, keeping resolution semantics identical. */
async function loadRolldown() {
  const apiRequire = createRequire(path.join(root, 'packages/api/package.json'));
  const tsdownRequire = createRequire(apiRequire.resolve('tsdown'));
  const { rolldown } = await import(pathToFileURL(tsdownRequire.resolve('rolldown')).href);
  const { parseAst } = await import(pathToFileURL(tsdownRequire.resolve('rolldown/parseAst')).href);
  return { rolldown, parseAst };
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (message) => message.replace(/\u001B\[[0-9;]*m/g, '');
const relativize = (message) => stripAnsi(message).replaceAll(root + path.sep, '');

async function scan({ rolldown, parseAst }, target) {
  const cycles = [];
  const unresolved = [];
  const isInternal = (id) =>
    id.startsWith('.') || path.isAbsolute(id) || target.internal.some((p) => id.startsWith(p));
  const alias = Object.fromEntries(
    Object.entries(target.alias).map(([key, dir]) => [key, path.join(root, target.dir, dir)]),
  );

  try {
    const build = await rolldown({
      input: target.entries.map((entry) => path.join(root, target.dir, entry)),
      platform: 'node',
      resolve: { alias },
      external: (id) => !isInternal(id),
      plugins: [...(target.typeEdges === false ? [] : [typeEdgesPlugin(parseAst)]), assetsPlugin],
      checks: { circularDependency: true },
      onLog(_level, log) {
        if (log.code === 'CIRCULAR_DEPENDENCY') {
          cycles.push(relativize(log.message));
        } else if (log.code === 'UNRESOLVED_IMPORT') {
          unresolved.push(relativize(log.message));
        }
      },
    });
    const { output } = await build.generate({ format: 'cjs' });
    const modules = output.reduce((sum, chunk) => sum + (chunk.moduleIds?.length ?? 0), 0);
    await build.close();
    return { target, cycles, unresolved, modules, error: null };
  } catch (error) {
    return { target, cycles, unresolved, modules: 0, error };
  }
}

function report({ target, cycles, unresolved, modules, error }) {
  const problems = [];
  if (error) {
    problems.push(`build failed: ${relativize(error.message)}`);
  }
  if (cycles.length > 0) {
    problems.push(...cycles);
  }
  if (unresolved.length > 0) {
    problems.push(...unresolved.map((message) => `unresolved first-party import: ${message}`));
  }
  if (!error && modules < target.minModules) {
    problems.push(
      `graph has ${modules} modules, below the ${target.minModules} floor; the scan is no longer resolving the real codebase`,
    );
  }

  if (problems.length === 0) {
    const scope =
      target.typeEdges === false
        ? 'runtime edges only, type edges grandfathered'
        : 'runtime + type edges';
    console.log(`✓ ${target.name}: no circular dependencies (${modules} modules, ${scope})`);
    return true;
  }
  console.error(`✗ ${target.name}:`);
  for (const problem of problems) {
    console.error(`    ${problem}`);
  }
  return false;
}

const engine = await loadRolldown();
const results = await Promise.all(targets.map((target) => scan(engine, target)));
const passed = results.map(report).every(Boolean);

if (!passed) {
  console.error('\nCircular dependency check failed.');
  process.exit(1);
}
