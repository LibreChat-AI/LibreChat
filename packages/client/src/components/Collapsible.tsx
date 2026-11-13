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
  /** `disclosure`: a row that toggles a panel, with its own focus ring. */
  appearance?: 'disclosure';
};

type CollapsibleContentProps = CollapsiblePrimitive.CollapsibleContentProps & {
  /** `height`: rolls the panel open and closed, and skips the roll under reduced motion. */
  motion?: 'height';
};

const DISCLOSURE_TRIGGER = 'focus-visible:ring-text-primary gap-2 rounded-sm focus-visible:ring-2';
const HEIGHT_MOTION =
  'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none';

const Collapsible: ForwardRefExoticComponent<
  CollapsiblePrimitive.CollapsibleProps & RefAttributes<HTMLDivElement>
> = CollapsiblePrimitive.Root;

const CollapsibleTrigger: ForwardRefExoticComponent<
  CollapsibleTriggerProps & RefAttributes<HTMLButtonElement>
> = forwardRef<ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>, CollapsibleTriggerProps>(
  ({ className, focusOutline, appearance, ...props }, ref) => (
    <CollapsiblePrimitive.CollapsibleTrigger
      ref={ref}
      className={
        cx(
          focusOutlineVariants({ focusOutline }),
          appearance === 'disclosure' && DISCLOSURE_TRIGGER,
          className,
        ) || undefined
      }
      {...props}
    />
  ),
);
CollapsibleTrigger.displayName = CollapsiblePrimitive.CollapsibleTrigger.displayName;

const CollapsibleContent: ForwardRefExoticComponent<
  CollapsibleContentProps & RefAttributes<HTMLDivElement>
> = forwardRef<ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>, CollapsibleContentProps>(
  ({ className, motion, ...props }, ref) => (
    <CollapsiblePrimitive.CollapsibleContent
      ref={ref}
      className={cx(motion === 'height' && HEIGHT_MOTION, className) || undefined}
      {...props}
    />
  ),
);
CollapsibleContent.displayName = CollapsiblePrimitive.CollapsibleContent.displayName;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
