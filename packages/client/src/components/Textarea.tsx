import * as React from 'react';
import { fieldBase, fieldEmbedded, fieldFlush, fieldInvalid } from './Field';
import { cn } from '~/utils';
import './Field.css';

/** `document` is a long-form editor that reads like the text it will become. `flush` draws no
 *  border or ring because the surrounding frame owns the indicator, and `embedded` fills a row
 *  edge to edge. */
const TEXTAREA_VARIANTS: Record<
  'default' | 'transparent' | 'document' | 'flush' | 'embedded',
  string
> = {
  default: 'bg-surface-secondary',
  transparent: 'bg-transparent',
  document: 'bg-transparent text-base leading-relaxed',
  flush: `bg-transparent ${fieldFlush}`,
  embedded: fieldEmbedded,
};

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  variant?: keyof typeof TEXTAREA_VARIANTS;
};

const Textarea: React.ForwardRefExoticComponent<
  TextareaProps & React.RefAttributes<HTMLTextAreaElement>
> = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', variant = 'default', ...props }, ref) => {
    return (
      <textarea
        className={cn(
          fieldBase,
          fieldInvalid,
          TEXTAREA_VARIANTS[variant],
          'min-h-20 resize-none',
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Textarea.displayName = 'Textarea';

export { Textarea };
