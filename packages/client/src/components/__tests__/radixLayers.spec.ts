import { join } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * Radix coordinates nested layers and focus scopes through module-level state,
 * so a dialog and the popover inside it cooperate only while they import the
 * *same copy* of these packages. Duplicates are silent: the popover opens
 * behind the dialog's overlay with pointer events off and cannot hold focus —
 * which is how the Run Code settings became unusable (#15738), and what
 * #11023's modal tooltip and dropdown regressions look like from the other
 * side of the same split.
 *
 * Read from the lockfile rather than from resolution, so the invariant holds
 * for whoever installs it next rather than for whatever this machine happens
 * to have on disk.
 */
const SINGLETONS = ['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope'];

type Lockfile = { packages: Record<string, { version?: string }> };

const lockfile = (): Lockfile =>
  JSON.parse(readFileSync(join(__dirname, '../../../../../package-lock.json'), 'utf8')) as Lockfile;

describe('Radix layer packages', () => {
  it.each(SINGLETONS)('resolves %s to a single copy', (name) => {
    const paths = Object.keys(lockfile().packages).filter((path) =>
      path.endsWith(`node_modules/${name}`),
    );

    expect(paths).toEqual([`node_modules/${name}`]);
  });
});
