import * as React from 'react';
import { cva } from 'class-variance-authority';
import type { ClassProp } from 'class-variance-authority/types';
import { composerSubmitClasses } from '~/utils/composer';
import { disabledFillClasses } from '~/utils/theme';
import { cn } from '~/utils';

type IconButtonVariantProps = {
  variant?:
    | 'default'
    | 'primary'
    | 'secondary'
    | 'ghost'
    | 'row-action'
    | 'destructive'
    | 'submit'
    | null;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'theme' | null;
  shape?: 'round' | 'square' | 'control' | 'theme' | null;
};

const iconButtonVariants: (props?: IconButtonVariantProps & ClassProp) => string = cva(
  [
    'inline-flex shrink-0 items-center justify-center text-text-primary transition-colors duration-theme-fast focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary disabled:pointer-events-none disabled:opacity-50',
    disabledFillClasses,
  ],
  {
    variants: {
      variant: {
        default: 'bg-surface-secondary hover:bg-surface-hover hover:active:bg-surface-pressed',
        primary:
          'bg-surface-inverted text-text-inverted hover:bg-surface-inverted-hover hover:active:bg-surface-inverted-pressed',
        secondary:
          'border border-border-light bg-surface-secondary hover:bg-surface-hover hover:active:bg-surface-pressed',
        ghost: 'bg-transparent hover:bg-surface-hover hover:active:bg-surface-pressed',
        /** An action inside a list row whose highlight is already `surface-hover`,
         *  so its own hover takes the active fill to stay visible on top of it. */
        'row-action': 'bg-transparent hover:bg-surface-active',
        destructive:
          'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
        /** The composer's submit slot: send, stop and the during-run send share it. */
        submit: cn(
          'hover:bg-surface-inverted-hover hover:active:bg-surface-inverted-pressed',
          composerSubmitClasses(),
        ),
      },
      size: {
        xs: 'size-6',
        sm: 'size-8',
        md: 'size-9',
        lg: 'size-10',
        theme: 'size-theme-control',
      },
      shape: {
        round: 'rounded-full',
        square: 'rounded-lg',
        /** The theme's control corner: softer than `square`, short of the full circle of `round`. */
        control: 'rounded-theme-control',
        theme: 'rounded-theme-control-round',
      },
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'md',
      shape: 'round',
    },
  },
);

export interface IconButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'>,
    IconButtonVariantProps {
  label: string;
}

const IconButton: React.ForwardRefExoticComponent<
  IconButtonProps & React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, label, type = 'button', variant, size, shape, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      className={cn(iconButtonVariants({ variant, size, shape, className }))}
      {...props}
    />
  ),
);

IconButton.displayName = 'IconButton';

export { IconButton, iconButtonVariants };
