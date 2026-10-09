import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import design from './design.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const missing = (dim) => ({ messageId: 'missing', data: { dim } });

tester.run('design/disabled-recipe', design.rules['disabled-recipe'], {
  valid: [
    "cn('px-2 disabled:opacity-50', disabledFillClasses)",
    "cva('rounded disabled:opacity-50', { variants: { tone: { muted: disabledInkClasses } } })",
    "cn('has-[:disabled]:opacity-50', disabledWithinFillClasses)",
    "const label = cn('peer-disabled:opacity-70', peerDisabledInkClasses);",
    '<input className={cn(`disabled:opacity-50 ${size}`, disabledFillClasses)} />',
    "cn('disabled:opacity-50 theme-disabled:bg-surface-disabled')",
    "cn('hover:opacity-80 focus:opacity-100 opacity-60')",
    "cn(open ? 'opacity-100' : 'opacity-0')",
    "cn({ 'opacity-50': isLoading })",
    "const recipe = 'theme-disabled:text-text-disabled theme-disabled:opacity-100';",
    "cn(disabled ? 'opacity-50' : '', disabledFillClasses)",
    "const label = 'disabled';",
    "cn('not-disabled:opacity-100 opacity-0')",
    "cn('data-[state=disabled]:opacity-50', utils.disabledInkClasses)",
    "cva('rounded', { variants: { size: { sm: 'disabled:opacity-50' } }, compoundVariants: [{ class: disabledFillClasses }] })",
    "cn({ 'disabled:opacity-50': true, [disabledFillClasses]: true })",
  ],
  invalid: [
    {
      code: '<button className="px-2 disabled:opacity-50" />',
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('rounded aria-disabled:opacity-40')",
      errors: [missing('aria-disabled:opacity-40')],
    },
    {
      code: "cn('data-[disabled]:pointer-events-none data-[disabled]:opacity-50')",
      errors: [missing('data-[disabled]:opacity-50')],
    },
    {
      code: "cn('group-disabled:opacity-60')",
      errors: [missing('group-disabled:opacity-60')],
    },
    {
      code: "cn('has-[:disabled]:opacity-50')",
      errors: [missing('has-[:disabled]:opacity-50')],
    },
    {
      code: "cn('sm:disabled:!opacity-30')",
      errors: [missing('sm:disabled:!opacity-30')],
    },
    {
      code: "cn('px-2', disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-hover')",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn(isDisabled && 'opacity-40')",
      errors: [missing('opacity-40')],
    },
    {
      code: "cn({ 'opacity-50': props.disabled })",
      errors: [missing('opacity-50')],
    },
    {
      code: 'const base = `rounded disabled:opacity-50 ${tone}`;',
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "const styles = { base: 'disabled:opacity-50' }; cn(styles.base, disabledFillClasses);",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('aria-[disabled=true]:opacity-50')",
      errors: [missing('aria-[disabled=true]:opacity-50')],
    },
    {
      code: "cn('data-[state=disabled]:opacity-50')",
      errors: [missing('data-[state=disabled]:opacity-50')],
    },
    {
      code: "cn('[&:disabled]:opacity-40')",
      errors: [missing('[&:disabled]:opacity-40')],
    },
    {
      code: "const props = { className: 'disabled:opacity-50', disabledFillClasses: false };",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "const props = { className: 'disabled:opacity-50', footer: cn(disabledFillClasses) };",
      errors: [missing('disabled:opacity-50')],
    },
  ],
});
