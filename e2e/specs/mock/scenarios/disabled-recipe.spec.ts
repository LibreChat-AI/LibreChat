import { join, resolve } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { LintMessage } from './lint.helpers';
import { inOneProject, repoRoot, run } from './lint.helpers';

/**
 * A theme with `disabledStyle: fill` paints a disabled control through the shared recipes; a
 * class list that fades it with its own `opacity-*` keeps fading it under that theme. The
 * configured lint run is what a contributor meets, so the scenario runs it over a probe file.
 */

const ESLINT = resolve(repoRoot, 'node_modules/.bin/eslint');
const RULE = 'design/disabled-recipe';

test.describe('the disabled-recipe design rule', () => {
  test('a disabled dim without a shared recipe fails the design lint @scenario:a-disabled-dim-without-a-shared-recipe-fails-the-design-lint', () => {
    inOneProject();
    test.setTimeout(180_000);

    const probe = 'client/src/__disabled_recipe_probe__.tsx';
    const probePath = join(repoRoot, probe);
    const header = "import { cn, Button, disabledFillClasses } from '@librechat/client';\n";
    const lint = (body: string): LintMessage[] => {
      writeFileSync(probePath, `${header}${body}`);
      const result = run(ESLINT, ['--format', 'json', '--no-warn-ignored', '--', probe]);
      const [report] = JSON.parse(result.stdout) as { messages: LintMessage[] }[];
      return report.messages.filter((message) => message.ruleId === RULE);
    };

    try {
      const faded = lint(
        'export const A = ({ disabled }: { disabled: boolean }) => (\n' +
          "  <input disabled={disabled} className={cn('px-2 disabled:opacity-50', disabled && 'cursor-not-allowed')} />\n" +
          ');\n',
      );
      expect(faded.map((message) => message.message).join('\n')).toContain(
        '`disabled:opacity-50` dims a disabled control without a disabled recipe',
      );

      const chosen = lint(
        "export const A = ({ disabled }: { disabled: boolean }) => <span className={cn(disabled ? 'opacity-50' : '')} />;\n",
      );
      expect(chosen, 'a dim a disabled condition chooses').toHaveLength(1);

      const composed = lint(
        "export const A = () => <input className={cn('px-2 disabled:opacity-50', disabledFillClasses)} />;\n",
      );
      expect(composed, 'a dim composed with the recipe').toEqual([]);

      const primitive = lint(
        'export const A = () => <Button className="disabled:opacity-80">Go</Button>;\n',
      );
      expect(primitive, 'a dim on a primitive that composes the recipe').toEqual([]);
    } finally {
      rmSync(probePath, { force: true });
    }
  });
});
