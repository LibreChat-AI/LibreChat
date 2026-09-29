import * as React from 'react';
import { fieldBase } from './Field';
import { cn } from '~/utils';
import './Field.css';

/** `document` is a long-form editor that reads like the text it will become. */
const TEXTAREA_VARIANTS = {
  default: 'bg-surface-secondary',
  transparent: 'bg-transparent',
  document: 'bg-transparent text-base leading-relaxed',
} as const;

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  variant?: keyof typeof TEXTAREA_VARIANTS;
};

const Textarea: React.ForwardRefExoticComponent<
  TextareaProps & React.RefAttributes<HTMLTextAreaElement>
> = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', variant = 'default', ...props }, ref) => {
    return (
      <textarea
        className={cn(fieldBase, TEXTAREA_VARIANTS[variant], 'min-h-20 resize-none', className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
