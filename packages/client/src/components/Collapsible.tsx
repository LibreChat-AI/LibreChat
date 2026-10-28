import { forwardRef } from 'react';
import { cx } from 'class-variance-authority';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import type {
  ElementRef,
  RefAttributes,
  ComponentPropsWithoutRef,
  ForwardRefExoticComponent,
} from 'react';
import type { FocusOutline } from './Focus';
import { focusOutlineVariants } from './Focus';

type CollapsibleTriggerProps = ComponentPropsWithoutRef<
  typeof CollapsiblePrimitive.CollapsibleTrigger
> & {
  focusOutline?: FocusOutline;
};

const Collapsible: ForwardRefExoticComponent<
  CollapsiblePrimitive.CollapsibleProps & RefAttributes<HTMLDivElement>
> = CollapsiblePrimitive.Root;

const CollapsibleTrigger: ForwardRefExoticComponent<
  CollapsibleTriggerProps & RefAttributes<HTMLButtonElement>
> = forwardRef<ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>, CollapsibleTriggerProps>(
  ({ className, focusOutline, ...props }, ref) => (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={cx(focusOutlineVariants({ focusOutline }), className) || undefined}
      {...props}
    />
  ),
);
CollapsibleTrigger.displayName = CollapsiblePrimitive.CollapsibleTrigger.displayName;

const CollapsibleContent: ForwardRefExoticComponent<
  CollapsiblePrimitive.CollapsibleContentProps & RefAttributes<HTMLDivElement>
> = CollapsiblePrimitive.CollapsibleContent;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
