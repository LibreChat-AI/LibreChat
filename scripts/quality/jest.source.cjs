// Source-alias pass: runs `api/`'s own specs with `@librechat/api` (and its subpaths) aliased to
// `packages/api/src`, so changed source there gets coverage evidence from specs that only import
// the built package. Must run from the repo root with `cwd` set to the measured checkout: Jest's
// `rootDir` and this file's own requires resolve relative to `process.cwd()` at load time.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const API = path.join(ROOT, 'api');
const SRC = path.join(ROOT, 'packages/api/src');
const SRC_SETUP = path.join(ROOT, 'packages/api/jest.setup.cjs');
const base = require(path.join(API, 'jest.config.js'));
const resolver = path.join(__dirname, 'jest.source.resolver.cjs');
const MIRROR = require(resolver).mirrorDir(ROOT);

/** Points the resolver's mirror symlink at this checkout's packages/api/src. Several Jest
 * processes can load this config at once, so a link another process just made is kept.
 * `--listTests` resolves without the mirror and does not need it. */
function linkMirror() {
  if (process.argv.includes('--listTests')) return;
  try {
    if (fs.readlinkSync(MIRROR) === SRC) return;
    fs.rmSync(MIRROR, { force: true });
  } catch {
    // No link yet.
  }
  fs.mkdirSync(path.dirname(MIRROR), { recursive: true });
  try {
    fs.symlinkSync(SRC, MIRROR, 'dir');
  } catch (error) {
    if (error.code !== 'EEXIST' || fs.readlinkSync(MIRROR) !== SRC) throw error;
  }
}
linkMirror();
// `~/` in api/jest.config.js always means api/; the resolver below makes it importer-aware instead.
// A base config may omit either field; treat an absent one as empty rather than crashing.
const {
  '~/(.*)': _tilde,
  '~/data/auth.json': _authMock,
  ...moduleNameMapper
} = base.moduleNameMapper ?? {};

// `roots` must include `SRC`, or related-test selection can never see `@librechat/api`'s alias
// target; `testPathIgnorePatterns` then stops its own specs from re-running as `api/` specs.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

module.exports = {
  ...base,
  rootDir: ROOT,
  roots: [API, SRC],
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? ['/node_modules/']),
    `^${escapeRegExp(SRC)}/`,
  ],
  setupFiles: [
    ...(base.setupFiles ?? []).map((file) => path.join(API, file)),
    ...(fs.existsSync(SRC_SETUP) ? [SRC_SETUP] : []),
  ],
  resolver,
  moduleNameMapper: {
    ...Object.fromEntries(
      Object.entries(moduleNameMapper).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.replace('<rootDir>', API) : value,
      ]),
    ),
    '^@librechat/api$': path.join(SRC, 'index.ts'),
    '^@librechat/api/telemetry$': path.join(SRC, 'telemetry.ts'),
    '^@librechat/api/credentials$': path.join(SRC, 'credentials.ts'),
  },
  // packages/api/src compiles to loose CommonJS: plain `exports.x = x` assignments, as in the
  // built dist bundle. Babel's default output defines re-exports as non-configurable getters,
  // which `jest.spyOn` cannot replace and an import cycle can read before they are set.
  // `modules: false` would leave `import()` for Node, which Jest rejects without
  // `--experimental-vm-modules`, so the dynamic-import plugin transforms it. Both plugins are
  // dependencies of @babel/preset-env and resolve from the measured checkout like the presets.
  // The resolver's mirror of packages/api/src compiles the same way.
  transform: {
    [`^(${escapeRegExp(SRC)}|${escapeRegExp(MIRROR)})/.+\\.[cm]?[jt]sx?$`]: [
      'babel-jest',
      {
        presets: [
          ['@babel/preset-env', { targets: { node: 'current' }, modules: false }],
          '@babel/preset-typescript',
        ],
        plugins: [
          '@babel/plugin-transform-dynamic-import',
          ['@babel/plugin-transform-modules-commonjs', { loose: true }],
        ],
      },
    ],
    ...base.transform,
  },
  coveragePathIgnorePatterns: ['/node_modules/'],
};
