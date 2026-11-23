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

      const otherBranch = lint(
        "export const A = ({ disabled }: { disabled: boolean }) => <span className={cn(disabled ? 'opacity-50' : disabledFillClasses)} />;\n",
      );
      expect(otherBranch, 'a recipe only on the branch the dim is not on').toHaveLength(1);

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
  test('a spelled-out recipe under the same variants as the dim passes the design lint @scenario:a-spelled-out-recipe-under-the-same-variants-passes-the-design-lint', () => {
    inOneProject();
    test.setTimeout(180_000);

    const probe = 'client/src/__disabled_recipe_spelled_probe__.tsx';
    const probePath = join(repoRoot, probe);
    const lint = (body: string): LintMessage[] => {
      writeFileSync(probePath, `import { cn } from '@librechat/client';\n${body}`);
      const result = run(ESLINT, ['--format', 'json', '--no-warn-ignored', '--', probe]);
      const [report] = JSON.parse(result.stdout) as { messages: LintMessage[] }[];
      return report.messages.filter((message) => message.ruleId === RULE);
    };

    try {
      const shared = lint(
        "export const A = () => <input className={cn('disabled:hover:opacity-50', 'theme-disabled:hover:opacity-100')} />;\n",
      );
      expect(shared, 'a recipe marker followed by a shared variant').toEqual([]);

      const constant = lint(
        "const faded = 'opacity-50 theme-disabled:opacity-100';\n" +
          'export const A = ({ busy }: { busy: boolean }) => <input disabled={busy} className={cn(busy && faded)} />;\n',
      );
      expect(constant, 'a constant that spells its own recipe').toEqual([]);

      const mismatched = lint(
        "export const A = () => <input className={cn('disabled:opacity-50', 'md:theme-disabled:opacity-100')} />;\n",
      );
      expect(mismatched, 'a recipe under a variant the dim lacks').toHaveLength(1);
    } finally {
      rmSync(probePath, { force: true });
    }
  });

  /**
   * Lints one probe file whose cases each sit on a line of their own, and answers, per case,
   * whether the rule reported that line: one ESLint run for the whole scenario.
   */
  const lintCases = (probe: string, cases: Record<string, string>): Record<string, boolean> => {
    const probePath = join(repoRoot, probe);
    const header = "import { cn, disabledFillClasses } from '@librechat/client';\n";
    const labels = Object.keys(cases);
    const body = labels
      .map((label, index) => `export const Case${index} = ${cases[label]};\n`)
      .join('');
    try {
      writeFileSync(probePath, `${header}${body}`);
      const result = run(ESLINT, ['--format', 'json', '--no-warn-ignored', '--', probe]);
      const [report] = JSON.parse(result.stdout) as { messages: LintMessage[] }[];
      const lines = new Set(
        report.messages.filter((message) => message.ruleId === RULE).map((message) => message.line),
      );
      return Object.fromEntries(labels.map((label, index) => [label, lines.has(index + 2)]));
    } finally {
      rmSync(probePath, { force: true });
    }
  };

  test('a recipe that holds whenever the dim does passes the design lint @scenario:a-recipe-that-holds-whenever-the-dim-does-passes-the-design-lint', () => {
    inOneProject();
    test.setTimeout(180_000);

    const reported = lintCases('client/src/__disabled_recipe_holds_probe__.tsx', {
      'a recipe that repeats the disabled variant of the dim':
        "() => <input className={cn('disabled:opacity-50', 'disabled:theme-disabled:opacity-100')} />",
      'a recipe under a smaller breakpoint than the dim':
        "() => <input className={cn('lg:disabled:opacity-50', 'md:theme-disabled:opacity-100')} />",
      'a recipe beside a dim spread into the class map':
        "({ disabled }: { disabled: boolean }) => <input disabled={disabled} className={cn({ ...{ 'opacity-50': disabled }, [disabledFillClasses]: disabled })} />",
      'control: a recipe under another disabled variant':
        "() => <input className={cn('aria-disabled:opacity-50', 'disabled:theme-disabled:opacity-100')} />",
      'control: a recipe under a larger breakpoint than the dim':
        "() => <input className={cn('md:disabled:opacity-50', 'lg:theme-disabled:opacity-100')} />",
      'control: a recipe under another condition than the spread dim':
        "({ disabled, busy }: { disabled: boolean; busy: boolean }) => <input disabled={disabled} className={cn({ ...{ 'opacity-50': disabled }, [disabledFillClasses]: busy })} />",
    });

    expect(reported).toEqual({
      'a recipe that repeats the disabled variant of the dim': false,
      'a recipe under a smaller breakpoint than the dim': false,
      'a recipe beside a dim spread into the class map': false,
      'control: a recipe under another disabled variant': true,
      'control: a recipe under a larger breakpoint than the dim': true,
      'control: a recipe under another condition than the spread dim': true,
    });
  });

  test('a dim whose recipe is overwritten or whose fade is wrapped fails the design lint @scenario:a-dim-whose-recipe-is-overwritten-or-whose-fade-is-wrapped-fails-the-design-lint', () => {
    inOneProject();
    test.setTimeout(180_000);

    const reported = lintCases('client/src/__disabled_recipe_overwritten_probe__.tsx', {
      'a recipe overwritten through a constant computed key':
        "() => { const key = 'theme-disabled:opacity-100'; return <input className={cn('disabled:opacity-50', { 'theme-disabled:opacity-100': true, [key]: false })} />; }",
      'a constant fade under a non-null assertion':
        "({ disabled }: { disabled: boolean }) => { const faded: string | undefined = 'opacity-50'; return <input disabled={disabled} className={cn(disabled && faded!)} />; }",
      'control: a recipe spelled through a constant computed key':
        "() => { const key = 'theme-disabled:opacity-100'; return <input className={cn('disabled:opacity-50', { [key]: true })} />; }",
      'control: a wrapped constant fade composed with the recipe':
        "({ disabled }: { disabled: boolean }) => { const faded: string | undefined = 'opacity-50'; return <input disabled={disabled} className={cn(disabled && faded!, disabledFillClasses)} />; }",
    });

    expect(reported).toEqual({
      'a recipe overwritten through a constant computed key': true,
      'a constant fade under a non-null assertion': true,
      'control: a recipe spelled through a constant computed key': false,
      'control: a wrapped constant fade composed with the recipe': false,
    });
  });
});
