import fs from 'node:fs';
import path from 'node:path';

/** Packages no app spec replaces: React and Jotai belong at module scope (`memo`, `atom`). */
const LOAD_SAFE = /^(react|react-dom|jotai)(\/|$)/;
const SOURCE = /\.(ts|tsx)$/;
const SPEC = /(\.(spec|test)\.|\/__(tests|mocks|fixtures)__\/)/;
const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\(\s*|import\s+)['"]([^'"]+)['"]/g;

const root = path.resolve(__dirname, '..');

const sources = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(file);
    return SOURCE.test(file) && !SPEC.test(file) ? [file] : [];
  });

/** Every other package the package's sources load, by the exact specifier they use. */
const externals = (): string[] => {
  const found = new Set<string>();
  for (const file of sources(root)) {
    for (const [, specifier] of fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (!specifier.startsWith('.') && !LOAD_SAFE.test(specifier)) found.add(specifier);
    }
  }
  return [...found].sort();
};

/**
 * This spec mocks workspace packages on purpose, an exception to the repository's real-logic
 * testing rule: its subject is the mock itself. App specs replace `@librechat/client` and
 * `librechat-data-provider` wholesale, and the failure it guards against (an entry that throws
 * on import under those mocks) only exists under them. Every other spec here uses the real
 * packages.
 *
 * A package the way an app spec's factory mock leaves it: a module whose every export is missing.
 * Handing an export on is harmless; calling one, constructing one or reading a member of one is
 * what throws, and that is the failure this spec catches.
 */
const missingExports = (): object =>
  new Proxy({}, { get: (_target, key) => (key === '__esModule' ? true : undefined) });

describe('loading the package while its dependencies are mocked', () => {
  const mocked = externals();

  it('finds the packages the sources load', () => {
    expect(mocked).toEqual(
      expect.arrayContaining(['@librechat/client', 'librechat-data-provider']),
    );
  });

  it.each(['index', 'react', 'components'])('loads the %s entry without touching them', (entry) => {
    jest.isolateModules(() => {
      for (const specifier of mocked) {
        jest.doMock(specifier, missingExports, { virtual: true });
      }
      expect(() => jest.requireActual(path.join(root, entry))).not.toThrow();
    });
  });
});
