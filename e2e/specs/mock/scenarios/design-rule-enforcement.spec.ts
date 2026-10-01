import { expect, test } from '@playwright/test';
import {
  designMessages,
  designRuleSeverities,
  inOneProject,
  lintFile,
  lintStdin,
  messagesFor,
  sourceDirectories,
} from './lint.helpers';

/**
 * `CLAUDE.md` asks callers to compose the library's primitives and keep colour on
 * semantic roles, and nothing checked any of it: a caller could write
 * `<Button className="bg-pink-500 p-4">` and hear nothing back. What the caller
 * actually sees now is the point of these two scenarios — a report that names the
 * variant to reach for instead — so both ask the configured flat config, through
 * `--stdin-filename`, which rules reach a path. No file is written into the tree.
 */

const BUTTON_OVERRIDE = [
  "import { Button } from '@librechat/client';",
  '',
  'export default () => <Button className="bg-pink-500 p-1">Go</Button>;',
  '',
].join('\n');

const INLINE_DISPLAY = ["export default () => <i style={{ display: 'none' }} />;", ''].join('\n');

/** The same markup with two spaces before the tag closes: `prettier/prettier`
 *  reports it wherever the config lints at all, which is how a silent design
 *  report is told apart from a path nothing lints. */
const UNFORMATTED_INLINE_DISPLAY = [
  "export default () => <i style={{ display: 'none' }}  />;",
  '',
].join('\n');

test.describe('design-system rules', () => {
  test('a colour override on a primitive names the variant to use instead @scenario:a-color-override-on-button-names-the-variant-to-use', () => {
    inOneProject();
    test.setTimeout(60_000);

    const messages = designMessages(lintStdin('client/src/__probe__.tsx', BUTTON_OVERRIDE));
    const restyle = messagesFor(messages, 'shadcn/no-restyle');

    /** The report has to say what the primitive owns and what to use instead;
     *  a bare "not allowed" would send the caller back to the source. */
    expect(restyle).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '"bg-pink-500" is not allowed on <Button>: <Button> owns its color',
        ),
      ]),
    );
    expect(restyle.join('\n')).toContain('Use a variant: info, success, warning, error, neutral');
    expect(restyle).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"p-1" is not allowed on <Button>: <Button> owns its spacing'),
      ]),
    );

    /** The raw palette is reported on its own account, with the nearest token. */
    expect(messagesFor(messages, 'shadcn/no-raw-colors').join('\n')).toContain(
      '"bg-pink-500" uses the raw Tailwind palette',
    );
  });

  test('a jsx client file is checked by the design rules @scenario:a-jsx-client-file-is-checked-by-the-design-rules', () => {
    inOneProject();
    test.setTimeout(60_000);

    /** The rules reached only `.ts`/`.tsx`, so the client's `.jsx` entry points —
     *  `App.jsx` among them — bypassed every one of them. */
    const jsx = designMessages(lintStdin('client/src/__probe__.jsx', INLINE_DISPLAY));
    expect(messagesFor(jsx, 'shadcn/no-inline-styles').join('\n')).toContain(
      'Inline style sets display',
    );

    /** A spec's fixture markup is an assertion, not a design surface: the
     *  exemption has to win for the same source under every pattern the
     *  repository's tests really use. Each path is also asserted to be linted
     *  at all — `prettier/prettier` still reports on it — so silence here means
     *  the design rules are off rather than the file being ignored. */
    for (const path of [
      'client/src/__probe__.spec.tsx',
      'client/src/__probe__.test.tsx',
      'packages/client/src/__probe__.spec.tsx',
    ]) {
      const report = lintStdin(path, UNFORMATTED_INLINE_DISPLAY);
      expect(designMessages(report), path).toEqual([]);
      expect(messagesFor(report, 'prettier/prettier'), `${path} is not linted at all`).not.toEqual(
        [],
      );
    }

    /** And the app-local `components/ui` path is a caller, not a library: it
     *  holds composites, so an override of a shared primitive there is reported
     *  like any other caller's. */
    const composite = designMessages(
      lintStdin('client/src/components/ui/__probe__.tsx', BUTTON_OVERRIDE),
    );
    expect(messagesFor(composite, 'shadcn/no-restyle').join('\n')).toContain(
      '"bg-pink-500" is not allowed on <Button>',
    );

    /** The one real violation the widened glob exposed, now fixed at the source
     *  rather than recorded in the backlog. */
    expect(designMessages(lintFile('client/src/App.jsx'))).toEqual([]);
  });

  test('every client source directory is policed by the design rules @scenario:every-client-source-directory-is-policed-by-the-design-rules', () => {
    inOneProject();
    test.setTimeout(120_000);

    /**
     * A report says what the rules found; it cannot say where they were asked.
     * A config that narrowed the design block over a subtree with nothing to
     * report — `client/src/routes/**` today — would produce no new diagnostic
     * for any gate to notice, and the styling written there next would never be
     * read. So the question is put to the resolved configuration itself, for
     * one representative path in every directory under the roots.
     *
     * The library is a different profile on purpose: `packages/client/src` owns
     * the primitives, so the rules about overriding one are off there while the
     * rules about colour and inline geometry still hold.
     */
    const caller: Record<string, number> = {
      'shadcn/no-restyle': 2,
      'shadcn/no-raw-colors': 2,
      'shadcn/no-arbitrary-values': 2,
      'shadcn/no-inline-styles': 2,
      'shadcn/require-static-classes': 2,
      'shadcn/no-unknown-classes': 2,
    };
    const library: Record<string, number> = {
      ...caller,
      'shadcn/no-restyle': 0,
      'shadcn/no-arbitrary-values': 0,
      'shadcn/require-static-classes': 0,
    };

    const server = 'api/server/index.js';
    const probes: Record<string, Record<string, number>> = {};
    for (const [root, expected] of [
      ['client/src', caller],
      ['packages/client/src', library],
    ] as const) {
      for (const directory of sourceDirectories(root)) {
        for (const extension of ['ts', 'tsx', 'js', 'jsx']) {
          probes[`${directory}/__coverage_probe__.${extension}`] = expected;
        }
      }
    }
    /** And the profile is a choice, not the default everywhere: server code is
     *  not a caller of the design system and is not policed by these rules. */
    probes[server] = {};
    expect(Object.keys(probes).length, 'the roots hold no source directories').toBeGreaterThan(50);

    const resolved = designRuleSeverities(Object.keys(probes));
    const outside = Object.entries(probes)
      .filter(([path, expected]) => JSON.stringify(resolved[path]) !== JSON.stringify(expected))
      .map(([path]) => `${path}: ${JSON.stringify(resolved[path])}`);
    expect(outside, 'a path the design rules no longer police as expected').toEqual([]);
  });
});
