import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { ClassProp } from 'class-variance-authority/types';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn, peerDisabledInkClasses } from '~/utils';

type LabelVariantOptions =
  | ({ variant?: 'default' | 'section' | null | undefined } & ClassProp)
  | undefined;

/**
 * Typography only, so a non-label element that heads a settings row can reuse a
 * variant without inheriting the label's block layout. Each variant carries its
 * own size, leading and color rather than overriding a shared base: the raw
 * recipe output is not merged for those consumers, and a font size declared
 * after `leading-none` would drop it.
 */
const labelVariants: (props?: LabelVariantOptions) => string = cva('', {
  variants: {
    variant: {
      /** Size, leading and weight are the theme's label roles: `text-sm`, leading 1 and the
       *  surrounding weight by default. */
      default:
        'text-(length:--theme-label-size) leading-(--theme-label-leading) font-theme-label text-text-primary',
      /** Eyebrow above a field or settings group. */
      section: 'text-[11px] font-medium uppercase tracking-wide text-text-secondary',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

const Label: React.ForwardRefExoticComponent<
  Omit<LabelPrimitive.LabelProps & React.RefAttributes<HTMLLabelElement>, 'ref'> & {
    className?: string;
  } & VariantProps<typeof labelVariants> &
    React.RefAttributes<HTMLLabelElement>
> = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & {
    className?: string;
  } & VariantProps<typeof labelVariants>
>(({ className = '', variant, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    {...props}
    {...{
      className: cn(
        'block w-full break-all peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        peerDisabledInkClasses,
        labelVariants({ variant }),
        className,
      ),
    }}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label, labelVariants };
