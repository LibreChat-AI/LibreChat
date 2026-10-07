import * as React from 'react';
import { floatingField } from './floating';
import { fieldControl } from './Field';
import { cn } from '~/utils';
import './Field.css';

/** `title` edits a heading in place, so the field takes the heading's type scale. `inline` shares
 *  a row with icon Buttons, so it takes their height role and the row stays one height when a
 *  theme sizes fields and buttons apart. `floating` is the sign-in form field whose label rests
 *  inside it and lifts on focus. */
const INPUT_VARIANTS: Record<'default' | 'inline' | 'title' | 'title-sm' | 'floating', string> = {
  default: '',
  inline: 'h-theme-button',
  title: 'h-theme-field-lg text-2xl font-semibold tracking-tight',
  'title-sm': 'text-base font-semibold tracking-tight',
  floating: floatingField,
};

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  colorTransition?: boolean;
  variant?: keyof typeof INPUT_VARIANTS;
};

const Input: React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>> =
  React.forwardRef<HTMLInputElement, InputProps>(
    ({ className, colorTransition, variant = 'default', ...props }, ref) => {
      return (
        <input
          className={cn(
            fieldControl,
            'ring-offset-surface-primary',
            INPUT_VARIANTS[variant],
            colorTransition && 'transition-colors',
            className ?? '',
          )}
          ref={ref}
          placeholder={variant === 'floating' ? ' ' : undefined}
          {...props}
        />
      );
    },
  );

Input.displayName = 'Input';

export { Input };
