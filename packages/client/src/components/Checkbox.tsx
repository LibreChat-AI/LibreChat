import * as React from 'react';
import { Check } from 'lucide-react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { cn, disabledFillClasses } from '~/utils';

type BaseCheckboxProps = Omit<
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
  'aria-label' | 'aria-labelledby'
> & {
  asChild?: boolean;
};

export type CheckboxProps =
  | (BaseCheckboxProps & {
      'aria-label': string;
      'aria-labelledby'?: never;
    })
  | (BaseCheckboxProps & {
      'aria-labelledby': string;
      'aria-label'?: never;
    });

const Checkbox: React.ForwardRefExoticComponent<
  CheckboxProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<React.ElementRef<typeof CheckboxPrimitive.Root>, CheckboxProps>(
  ({ className = '', ...props }, ref) => (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        'peer border-border-xheavy ring-offset-surface-primary focus-visible:ring-focus-control data-[state=checked]:bg-surface-inverted data-[state=checked]:text-text-inverted size-theme-checkbox shrink-0 rounded-sm border focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
        disabledFillClasses,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className={cn('flex items-center justify-center')}>
        <Check className="size-theme-checkbox" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  ),
);
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

/**
 * The checkbox's appearance without its behaviour, for a control that already carries
 * the state itself, e.g. a `Button` with `aria-pressed`. Radix's checkbox is a
 * `<button>`, so nesting one inside another control puts two interactive elements in
 * the same place: unreachable by keyboard, and announced twice by a screen reader.
 * This is a span, so the control around it stays the only thing there.
 */
const CheckboxGlyph: React.FC<{ checked: boolean; className?: string }> = ({
  checked,
  className = '',
}) => (
  <span
    aria-hidden="true"
    className={cn(
      'border-border-xheavy size-theme-checkbox flex shrink-0 items-center justify-center rounded-sm border',
      checked && 'bg-surface-inverted text-text-inverted',
      className,
    )}
  >
    {checked && <Check className="size-theme-checkbox" />}
  </span>
);
CheckboxGlyph.displayName = 'CheckboxGlyph';

export { Checkbox, CheckboxGlyph };
