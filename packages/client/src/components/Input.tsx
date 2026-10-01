import * as React from 'react';
import { fieldControl } from './Field';
import { cn } from '~/utils';
import './Field.css';

/** `title` edits a heading in place, so the field takes the heading's type scale. `inline` shares
 *  a row with icon Buttons, so it takes their height role and the row stays one height when a
 *  theme sizes fields and buttons apart. */
const INPUT_VARIANTS = {
  default: '',
  inline: 'h-theme-button',
  title: 'h-theme-field-lg text-2xl font-semibold tracking-tight',
  'title-sm': 'text-base font-semibold tracking-tight',
} as const;

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
          {...props}
        />
      );
    },
  );

Input.displayName = 'Input';

export { Input };
