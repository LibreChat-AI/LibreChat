import { expect, test } from '@playwright/test';
import { designMessages, lintStdin, messagesFor } from './lint.helpers';

/**
 * Three classes in this app rendered nothing at all, `transition-color`,
 * `pointer-cursor`, `scrollbar-hide`, because nothing could tell a typo from a
 * utility. Moving the colours into `@theme inline` made the theme readable, which
 * is what lets `no-unknown-classes` ask the installed Tailwind whether a class
 * generates CSS and lets `no-raw-colors` spot a token nobody declared. Both
 * report through the flat config, so both are asked here through a stdin probe.
 */

const MISSPELLED = [
  'export default () => <div className="transition-color bg-surfce-primary" />;',
  '',
].join('\n');

const CORRECT = [
  'export default () => <div className="transition-colors bg-surface-primary" />;',
  '',
].join('\n');

test.describe('class and token existence', () => {
  test('compatibility palette utilities still require semantic roles @scenario:compatibility-palette-utilities-still-require-semantic-roles', () => {
    test.setTimeout(60_000);
    const palette = [
      'text-gray-500',
      'dark:bg-gray-650/50',
      'hover:border-green-500',
      'ring-green-550',
    ];
    for (const root of ['client/src', 'packages/client/src']) {
      const reported = designMessages(
        lintStdin(
          `${root}/__probe__.tsx`,
          `export default () => <div className="${palette.join(' ')}" />;\n`,
        ),
      );
      const raw = messagesFor(reported, 'shadcn/no-raw-colors');
      expect(raw).toHaveLength(palette.length);
      for (const utility of palette) {
        expect(raw.some((message) => message.includes(`"${utility}"`))).toBe(true);
      }
      expect(messagesFor(reported, 'shadcn/no-unknown-classes')).toEqual([]);
      expect(designMessages(lintStdin(`${root}/__probe__.tsx`, CORRECT))).toEqual([]);
    }
  });

  test('an unknown utility class is reported by the linter @scenario:an-unknown-utility-class-is-reported-by-the-linter', () => {
    test.setTimeout(60_000);

    const reported = designMessages(lintStdin('client/src/__probe__.tsx', MISSPELLED));

    /** The class generates no CSS, and the report says so and names the class
     *  the author meant, otherwise a typo reads as a deliberate no-op. */
    const unknown = messagesFor(reported, 'shadcn/no-unknown-classes').join('\n');
    expect(unknown).toContain('"transition-color" is not a class this project\'s Tailwind knows');
    expect(unknown).toContain('Did you mean "transition-colors"?');

    /** An undeclared colour token is the same failure wearing a colour's
     *  clothes, and it is reported against the declared token list. */
    const raw = messagesFor(reported, 'shadcn/no-raw-colors').join('\n');
    expect(raw).toContain('"bg-surfce-primary" is not a declared theme color');
    expect(raw).toContain('Did you mean "bg-surface-primary"?');

    /** The one variant class the tree still wrote through a hand-rolled token
     *  rule, `aria-selected:text-token-text-primary` on the animated tabs,
     *  now has nowhere to resolve, and the rules say so rather than leaving the
     *  selected tab unstyled. Its semantic replacement is silent. */
    const stale = designMessages(
      lintStdin(
        'client/src/__probe__.tsx',
        'export default () => <div className="aria-selected:text-token-text-primary" />;\n',
      ),
    );
    expect(messagesFor(stale, 'shadcn/no-raw-colors').join('\n')).toContain(
      '"aria-selected:text-token-text-primary" is not a declared theme color',
    );
    expect(
      designMessages(
        lintStdin(
          'client/src/__probe__.tsx',
          'export default () => <div className="aria-selected:text-text-primary" />;\n',
        ),
      ),
    ).toEqual([]);

    /** The negative control: the correctly spelled neighbours are silent, so the
     *  rules are reporting these two classes rather than the shape of the probe. */
    expect(designMessages(lintStdin('client/src/__probe__.tsx', CORRECT))).toEqual([]);
  });
});
