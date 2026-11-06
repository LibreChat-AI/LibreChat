import path from 'node:path';

/**
 * `chat/boundary`: what a `@librechat/chat` source may load. Every way of naming a module is
 * reduced to one target before it is judged, so the rule holds however the specifier is spelled:
 * a relative path is resolved against the file and stripped of its extension, trailing slash and
 * `/index`; a bare specifier is reduced to its package name. Static imports, re-exports, `import()`
 * and `require()` of a literal or a substitution-free template, `import x = require()` and
 * `import('...')` types are all checked.
 *
 * - Anywhere in the package: nothing outside the package's own sources (the app's `~/` alias,
 *   `client/src`, `@librechat/frontend`), no Recoil, and no import through the package's own name.
 * - In the core (`index.ts` and `core/**`): no UI framework (React, React DOM, Jotai, React Query,
 *   `@librechat/client`, or any subpath of them) and none of the `/react` or `/components` entries.
 *   A core `import()` or `require()` whose specifier cannot be read statically is reported too,
 *   since the rule could not tell what it loads.
 * - Outside specs: no call, `new`, tagged template or member read through another package's import
 *   at module scope. App specs mock whole packages (`@librechat/client`, `librechat-data-provider`),
 *   so a top-level `cn(...)` or a map keyed by `FileSources.local` throws on import. This is fast
 *   feedback for the plain case; `src/__tests__/load.spec.ts` loads every entry with those packages
 *   mocked and catches the rest (aliases, `require`, invoked functions). React and Jotai, which no
 *   spec replaces, are exempt through the `loadSafe` option.
 */

const EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const UI_PACKAGES = new Set(['react', 'react-dom', 'jotai', '@librechat/client']);
const UI_SCOPES = ['@tanstack/'];
const ENTRIES = new Set(['react', 'components']);
const LOAD_SAFE = ['react', 'react-dom', 'jotai', 'jotai/utils'];
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** `cn`, `Client.cn` and `Client['cn']` all start at the identifier they reach through. */
const rootIdentifier = (node) => {
  let current = node;
  while (current.type === 'MemberExpression') current = current.object;
  return current.type === 'Identifier' ? current : undefined;
};

/** Whether `node` runs when its module loads: no function and no instance field defers it. */
const runsOnLoad = (node) => {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (FUNCTIONS.has(parent.type)) return false;
    if (parent.type === 'PropertyDefinition' && !parent.static && child === parent.value) {
      return false;
    }
  }
  return true;
};

const packageName = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/** `dir/react.ts`, `dir/react/`, `dir/react/index.mjs` all name `dir/react`. */
const normalizePath = (target) => {
  let normalized = target.replace(/[\\/]+$/, '').replace(EXTENSION, '');
  normalized = normalized.replace(/[\\/]index$/, '');
  return normalized;
};

const specifierOf = (node) => {
  if (!node) return { known: false };
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return { known: true, value: node.value };
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return { known: true, value: node.quasis[0].value.cooked };
  }
  if (node.type === 'TSLiteralType') return specifierOf(node.literal);
  return { known: false };
};

const boundary = {
  meta: {
    type: 'problem',
    docs: { description: 'Keeps @librechat/chat self-contained and its core free of UI code.' },
    schema: [
      {
        type: 'object',
        properties: {
          sourceRoot: { type: 'string' },
          packageName: { type: 'string' },
          loadSafe: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      app: '@librechat/chat cannot load {{specifier}}; take what it needs from the host instead.',
      recoil:
        '@librechat/chat holds no Recoil state; per-pane run state is Jotai in the React binding.',
      self: '@librechat/chat imports its own modules by relative path, not through {{specifier}}.',
      ui: 'The @librechat/chat core has no UI dependency; {{specifier}} belongs in the /react entry.',
      entry: 'The core cannot load {{specifier}}; the /{{entry}} entry builds on the core.',
      opaque: 'The @librechat/chat core loads only specifiers the boundary can read.',
      load: 'Use {{name}} from {{source}} inside a function, not while the module loads: app specs mock {{source}}, and this throws on import.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const self = options.packageName ?? '@librechat/chat';
    const root = path.resolve(context.cwd, options.sourceRoot ?? 'packages/chat/src');
    const filename = path.resolve(context.filename);
    const relativeFile = path.relative(root, filename);
    if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile)) return {};
    const segments = relativeFile.split(path.sep);
    /** Specs and their support files (`__fixtures__`, `__mocks__`) never load in an app spec. */
    const isSpec =
      segments.some((segment) => /^__(tests|fixtures|mocks)__$/.test(segment)) ||
      /\.(spec|test)\./.test(relativeFile);
    const loadSafe = new Set(options.loadSafe ?? LOAD_SAFE);
    /** Import specifiers that bind a name to another package, mapped to that package. */
    const externalBindings = new Map();
    const usesExternalOnLoad = (node, target) => {
      if (isSpec) return;
      const identifier = rootIdentifier(target);
      if (!identifier) return;
      let variable;
      for (let scope = context.sourceCode.getScope(node); scope && !variable; scope = scope.upper) {
        variable = scope.set.get(identifier.name);
      }
      const source = variable && externalBindings.get(variable.defs[0]?.node);
      if (!source || !runsOnLoad(node)) return;
      context.report({ node, messageId: 'load', data: { name: identifier.name, source } });
    };

    const isCore =
      (segments.length === 1 && /^index\.[cm]?[jt]sx?$/.test(segments[0])) ||
      (segments[0] === 'core' &&
        !segments.includes('__tests__') &&
        !/\.(spec|test)\./.test(relativeFile));

    const judge = (node, specifier) => {
      const report = (messageId, data = {}) =>
        context.report({ node, messageId, data: { specifier, ...data } });

      if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
        const target = normalizePath(path.resolve(path.dirname(filename), specifier));
        const fromRoot = path.relative(root, target);
        if (fromRoot.startsWith('..') || path.isAbsolute(fromRoot)) return report('app');
        const entry = fromRoot.split(path.sep)[0];
        if (isCore && ENTRIES.has(entry)) return report('entry', { entry });
        return;
      }

      if (specifier === '~' || specifier.startsWith('~/')) return report('app');
      const bareSegments = normalizePath(specifier).split('/');
      /** A path alias (`baseUrl`, a bundler alias) can still name the app or an entry bare. */
      if (
        bareSegments.some(
          (segment, index) => segment === 'client' && bareSegments[index + 1] === 'src',
        )
      ) {
        return report('app');
      }
      const name = packageName(specifier);
      if (name === '@librechat/frontend') return report('app');
      if (name === 'recoil') return report('recoil');
      if (name === self) return report('self');
      /** `react` itself is the UI package; any other bare path through `react` or `components`
       *  (`src/react`, `@/components`) is an alias for an entry. */
      const bareEntry =
        name === 'react' ? undefined : bareSegments.find((segment) => ENTRIES.has(segment));
      if (isCore && bareEntry) return report('entry', { entry: bareEntry });
      if (isCore && (UI_PACKAGES.has(name) || UI_SCOPES.some((scope) => name.startsWith(scope)))) {
        return report('ui');
      }
    };

    const check = (node, sourceNode) => {
      const { known, value } = specifierOf(sourceNode);
      if (known) return judge(node, value);
      if (isCore) context.report({ node, messageId: 'opaque' });
    };

    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
          const source = statement.source.value;
          /** Node built-ins (`node:path`) are never replaced by a spec. */
          const local = source.startsWith('.') || source.startsWith('~');
          if (local || source.startsWith('node:') || loadSafe.has(source)) continue;
          statement.specifiers
            .filter((specifier) => specifier.importKind !== 'type')
            .forEach((specifier) => externalBindings.set(specifier, source));
        }
      },
      ImportDeclaration: (node) => check(node, node.source),
      NewExpression: (node) => usesExternalOnLoad(node, node.callee),
      TaggedTemplateExpression: (node) => usesExternalOnLoad(node, node.tag),
      /** The outermost read only: `A.b.c` is one report, and a call reports its own callee. */
      MemberExpression(node) {
        const { parent } = node;
        if (parent.type === 'MemberExpression' && parent.object === node) return;
        if (parent.type === 'CallExpression' && parent.callee === node) return;
        if (parent.type === 'NewExpression' && parent.callee === node) return;
        if (parent.type === 'TaggedTemplateExpression' && parent.tag === node) return;
        usesExternalOnLoad(node, node);
      },
      ExportNamedDeclaration: (node) => node.source && check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
      TSImportType: (node) => check(node, node.argument),
      TSExternalModuleReference: (node) => check(node, node.expression),
      CallExpression(node) {
        usesExternalOnLoad(node, node.callee);
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        check(node, node.arguments[0]);
      },
    };
  },
};

export default {
  meta: { name: 'chat' },
  rules: { boundary },
};
