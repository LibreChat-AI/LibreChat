import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { inOneProject, repoRoot, staticChecks } from './lint.helpers';

/**
 * The one backlog scenario that sweeps every root twice: an inline comment must not be a way to
 * silence a design rule. It runs on its own so the shard planner can place it apart from the
 * rest of the backlog in `suppression-baseline.spec.ts`.
 */
test.describe('the recorded design-rule backlog', () => {
  test('silencing a design rule with an inline comment is rejected @scenario:silencing-a-design-rule-with-an-inline-comment-is-rejected', () => {
    inOneProject();
    test.setTimeout(180_000);

    /** An inline comment is the one way to silence a design rule that leaves
     *  nothing behind to review, and a file with no entry could otherwise carry
     *  one past every other check. Two halves answer for it: the diff's design
     *  sources are linted twice — with and without `--no-inline-config` — so
     *  anything a comment is silencing today shows up whatever its spelling, and
     *  the comments themselves are read out of the parser, so a directive that
     *  silences nothing yet is caught as well and a string that reads like one
     *  is not. */
    const probe = 'client/src/__directive_probe__.tsx';
    const probePath = join(repoRoot, probe);
    const violating = 'export default () => <div className="bg-pink-500" />;\n';
    const clean = 'export default () => <div className="bg-surface-primary" />;\n';
    /** Each directive is rejected over a file that violates the rule and over
     *  one that does not: a comment waiting for its first violation is the same
     *  hole a day later. */
    const directives: [string, string, string][] = [
      ['a named disable', '/* eslint-disable shadcn/no-raw-colors */', 'shadcn/no-raw-colors'],
      [
        'a justified disable',
        '/* eslint-disable shadcn/no-raw-colors -- because */',
        'shadcn/no-raw-colors',
      ],
      [
        'a next-line disable',
        '// eslint-disable-next-line shadcn/no-raw-colors',
        'shadcn/no-raw-colors',
      ],
      ['a blanket disable', '/* eslint-disable */', 'a blanket'],
      ['a described blanket disable', '/* eslint-disable -- temporary */', 'a blanket'],
      ['a described next-line disable', '// eslint-disable-next-line -- temporary', 'a blanket'],
      ['rule configuration', '/* eslint shadcn/no-raw-colors: off */', 'shadcn/no-raw-colors'],
      [
        'rule configuration to warn',
        '/* eslint shadcn/no-raw-colors: "warn" */',
        'shadcn/no-raw-colors',
      ],
      [
        'a quoted rule configuration',
        '/* eslint "shadcn/no-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      /** A quoted key is a JSON string, so its escapes belong to the encoding
       *  and not to the rule name. ESLint decodes both of these to the same
       *  rule it disables for the file; a gate that compares the spelling sees
       *  neither. */
      [
        'an escaped rule configuration',
        '/* eslint "shadcn\\/no-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      [
        'a unicode-escaped rule configuration',
        '/* eslint "shadcn\\u002fno-raw-colors": off */',
        'shadcn/no-raw-colors',
      ],
      [
        'a single-quoted rule configuration',
        "/* eslint 'shadcn/no-raw-colors': off */",
        'shadcn/no-raw-colors',
      ],
    ];
    try {
      for (const [label, comment, named] of directives) {
        for (const [state, body] of [
          ['over a violation', violating],
          ['over a clean file', clean],
        ]) {
          writeFileSync(probePath, `${comment}\n${body}`);
          const report = staticChecks([probe, '--only', 'suppressions']);
          expect(report.status, `${label} ${state} passed`).not.toBe(0);
          expect(report.output, `${label} ${state}`).toContain(named);
        }
      }

      /** A blanket disable busy silencing some other rule is the case ESLint's
       *  own unused-directive report cannot see: it is used, so it is not
       *  unused, and it still covers every design rule. */
      writeFileSync(
        probePath,
        '/* eslint-disable */\nconst unused = 1;\nexport default () => <div className="bg-surface-primary" />;\n',
      );
      const used = staticChecks([probe, '--only', 'suppressions']);
      expect(used.status, 'a blanket disable silencing another rule passed').not.toBe(0);
      expect(used.output).toContain('a blanket');

      /** And two things that are not a silenced rule: a directive naming another
       *  rule — the tree carries forty of them — and a string that reads like
       *  one. */
      for (const [label, source] of [
        [
          'a directive for another rule',
          '// eslint-disable-next-line react-hooks/exhaustive-deps\nexport default () => <div className="bg-surface-primary" />;\n',
        ],
        [
          'comment-like text in a string',
          'export default () => <div className="bg-surface-primary" title="/* eslint-disable shadcn/no-raw-colors */" />;\n',
        ],
      ]) {
        writeFileSync(probePath, source);
        const report = staticChecks([probe, '--only', 'suppressions']);
        expect(report.status, `${label}: ${report.output}`).toBe(0);
      }
    } finally {
      rmSync(probePath, { force: true });
    }
  });
});
