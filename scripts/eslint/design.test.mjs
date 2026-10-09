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
    "<span className={cn(disabled && 'opacity-50', disabledWithinFillClasses)} />",
    "<button disabled={disabled} className={cn(disabled && 'opacity-50', disabledFillClasses)} />",
    "cn('disabled:opacity-60!', 'theme-disabled:opacity-100!')",
    "<button disabled className={cn('opacity-50', disabledFillClasses)} />",
    "cn(disabled && { 'opacity-50': true }, disabledFillClasses)",
    "cn(disabled && 'opacity-50', disabled && disabledFillClasses)",
    "cn(disabled ? 'opacity-50' : '', disabled ? disabledFillClasses : '')",
    "cn('disabled:opacity-50', 'px-2 ' + disabledFillClasses, clsx(disabledInkClasses))",
    "cn('data-[state=not-disabled]:opacity-50 aria-[state=non-disabled]:opacity-40')",
    "cn({ disabled: { true: 'opacity-50' } })",
    "const metadata = { disabled: true, class: 'opacity-50' };",
    "cn(disabled ? '' : (active ? 'opacity-50' : ''))",
    "cn('disabled:opacity-50 theme-disabled:opacity-100!')",
    "cn('disabled:opacity-100!')",
    "cva(disabledFillClasses, { variants: { disabled: { true: 'opacity-50', false: '' } } })",
    "cva('', { variants: { disabled: { true: '', false: 'opacity-50' } } })",
    "import * as client from '@librechat/client'; cn('disabled:opacity-50', client.disabledFillClasses)",
    {
      code: "import { disabledInkClasses } from '../utils'; cn('disabled:opacity-50', disabledInkClasses)",
      filename: '/repo/packages/client/src/components/Menu.tsx',
    },
    "cva(cn('rounded disabled:opacity-50', disabledFillClasses), { variants: {} })",
    "cn('has-[:disabled]:opacity-50', disabledWithinFillClasses)",
    "const label = cn('peer-disabled:opacity-70', peerDisabledInkClasses);",
    '<input className={cn(`disabled:opacity-50 ${size}`, disabledFillClasses)} />',
    "cn('disabled:opacity-50 theme-disabled:bg-surface-disabled theme-disabled:opacity-100')",
    "cn('disabled:opacity-100')",
    "cn(!disabled && active && 'opacity-50')",
    "cn(disabled || active ? 'opacity-50' : '')",
    {
      code: '<Button className="disabled:opacity-80" />',
      options: [{ primitives: ['Button'] }],
    },
    {
      code: 'import { Button as Action } from \'@librechat/client\'; <Action className="disabled:opacity-80" />',
      options: [{ primitives: ['Button'] }],
    },
    {
      code: "import * as ui from '~/components/ui'; <ui.Checkbox className={cn('disabled:opacity-70', size)} />",
      options: [{ primitives: ['Checkbox'], sources: ['@librechat/client', '~/components/ui'] }],
    },
    {
      code: 'import { Button } from \'./Button\'; <Button className="disabled:opacity-80" />',
      filename: '/repo/packages/client/src/components/Dialog.tsx',
      options: [{ primitives: ['Button'] }],
    },
    "import { disabledFillClasses as fill } from '@librechat/client'; cn('disabled:opacity-50', fill)",
    "cn('peer-disabled:opacity-70', peerDisabledInkClasses)",
    "cn('[&:has(:disabled)]:opacity-50', disabledWithinFillClasses)",
    "cn(disabled ? 'opacity-50' : '', disabledInkClasses)",
    "cn({ 'disabled:opacity-50': cond, [disabledFillClasses]: cond })",
    "<input disabled={busy} className={cn(busy ? 'opacity-50' : '', disabledFillClasses)} />",
    "cn('hover:opacity-80 focus:opacity-100 opacity-60')",
    "cn(open ? 'opacity-100' : 'opacity-0')",
    "cn({ 'opacity-50': isLoading })",
    "const recipe = 'theme-disabled:text-text-disabled theme-disabled:opacity-100';",
    "cn(disabled ? 'opacity-50' : '', disabledFillClasses)",
    "const label = 'disabled';",
    "cn('not-disabled:opacity-100 opacity-0')",
    "cn('data-[state=disabled]:opacity-50', utils.disabledInkClasses)",
    "cva('rounded', { variants: { size: { sm: cn('disabled:opacity-50', disabledFillClasses) } } })",
    "cn({ 'disabled:opacity-50': true, [disabledFillClasses]: true })",
    "cn(disabled ? '' : 'opacity-50')",
    "cn(!disabled && 'opacity-50')",
    "cn({ 'opacity-50': disabled === false })",
    "cn('data-[disabled=false]:opacity-50 aria-[disabled=false]:opacity-60')",
    "cn('[&:not(:disabled)]:opacity-50')",
    "cn(isNotDisabled && 'opacity-50')",
    "cn({ 'opacity-50': props.nonDisabled })",
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
      code: "cn(isEnabled ? 'hover:bg-surface-hover' : '', !disabled ? '' : 'opacity-50')",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn('disabled:opacity-50 theme-disabled:bg-surface-disabled')",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn(disabled ? cn('opacity-50') : '')",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn(disabled && active && 'opacity-40')",
      errors: [missing('opacity-40')],
    },
    {
      code: '<Badge className="disabled:opacity-80" />',
      options: [{ primitives: ['Button'] }],
      errors: [missing('disabled:opacity-80')],
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
    {
      code: "cn(disabled ? 'opacity-50' : disabledFillClasses)",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn('disabled:opacity-50', !disabled && disabledFillClasses)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cva('rounded disabled:opacity-50', { variants: { tone: { muted: disabledInkClasses, loud: 'px-2' } } })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cva('rounded', { variants: { size: { sm: 'disabled:opacity-50' } }, compoundVariants: [{ class: disabledFillClasses }] })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cva('', { variants: { disabled: { true: 'opacity-50', false: '' } } })",
      errors: [missing('opacity-50')],
    },
    {
      code: "cva('', { variants: { size: { sm: 'px-2' } }, compoundVariants: [{ disabled: true, class: 'opacity-40' }] })",
      errors: [missing('opacity-40')],
    },
    {
      code: "cn(disabled && 'opacity-50', active && disabledFillClasses)",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn(disabled && 'sm:opacity-50')",
      errors: [missing('sm:opacity-50')],
    },
    {
      code: "cn(disabled ? 'opacity-50' : '', disabled ? '' : disabledFillClasses)",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn(disabled && (active ? 'opacity-50' : ''))",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn(disabled && (active && 'opacity-40'))",
      errors: [missing('opacity-40')],
    },
    {
      code: "cva('disabled:opacity-50', { variants: { tone: { muted: disabledFillClasses } }, defaultVariants: { tone: null } })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cva('disabled:opacity-50', { variants: { tone: { muted: disabledFillClasses } }, defaultVariants: { tone: 'loud' } })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('disabled:opacity-50', disabledFillClasses === other)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('disabled:opacity-50', drop(disabledFillClasses))",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cva('rounded disabled:opacity-50', { variants: { tone: { muted: disabledInkClasses, loud: cn('px-2', disabledFillClasses) } }, defaultVariants: { tone: 'muted' } })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "<span className={cn(disabled && 'opacity-50', disabledFillClasses)} />",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn('[tr[data-disabled=true]_&]:opacity-50', disabledFillClasses)",
      errors: [missing('[tr[data-disabled=true]_&]:opacity-50')],
    },
    {
      code: "<div className={first('disabled:opacity-50', disabledFillClasses)} />",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('disabled:opacity-60!', disabledFillClasses)",
      errors: [missing('disabled:opacity-60!')],
    },
    {
      code: '<button disabled className="opacity-50" />',
      errors: [missing('opacity-50')],
    },
    {
      code: '<button aria-disabled="true" className="px-2 opacity-40" />',
      errors: [missing('opacity-40')],
    },
    {
      code: "cn('disabled:group-disabled:opacity-50', disabledFillClasses)",
      errors: [missing('disabled:group-disabled:opacity-50')],
    },
    {
      code: "cn('disabled:opacity-60!')",
      errors: [missing('disabled:opacity-60!')],
    },
    {
      code: "cn(disabled && { 'opacity-50': true })",
      errors: [missing('opacity-50')],
    },
    {
      code: "cn('peer-disabled:opacity-70', disabledFillClasses)",
      errors: [missing('peer-disabled:opacity-70')],
    },
    {
      code: "cn('has-[:disabled]:opacity-50', disabledInkClasses)",
      errors: [missing('has-[:disabled]:opacity-50')],
    },
    {
      code: "cn('disabled:opacity-50', peerDisabledInkClasses)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "cn('group-disabled:opacity-60', disabledFillClasses)",
      errors: [missing('group-disabled:opacity-60')],
    },
    {
      code: "cva('rounded disabled:opacity-50', { variants: { tone: { muted: disabledInkClasses, loud: disabledFillClasses } } })",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "import { disabledFillClasses } from './styles'; cn('disabled:opacity-50', disabledFillClasses)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "import { disabledFillClasses } from '~/utils'; cn('disabled:opacity-50', disabledFillClasses)",
      filename: '/repo/client/src/components/Row.tsx',
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "const utils = { disabledInkClasses: 'px-2' }; cn('disabled:opacity-50', utils.disabledInkClasses)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: "const disabledFillClasses = 'px-2'; cn('disabled:opacity-50', disabledFillClasses)",
      errors: [missing('disabled:opacity-50')],
    },
    {
      code: 'import { Button } from \'./local\'; <Button className="disabled:opacity-80" />',
      options: [{ primitives: ['Button'] }],
      errors: [missing('disabled:opacity-80')],
    },
    {
      code: 'import * as Ariakit from \'@ariakit/react\'; <Ariakit.Button className="disabled:opacity-80" />',
      options: [{ primitives: ['Button'] }],
      errors: [missing('disabled:opacity-80')],
    },
    {
      code: "<button disabled={importMutation.isLoading} className={cn('px-2', importMutation.isLoading && 'cursor-wait opacity-50')} />",
      errors: [missing('opacity-50')],
    },
    {
      code: "<button disabled={!canOpenDetails} className={cn(canOpenDetails ? 'hover:bg-surface-hover' : 'opacity-50')} />",
      errors: [missing('opacity-50')],
    },
  ],
});
