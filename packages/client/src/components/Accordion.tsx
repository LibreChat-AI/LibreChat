import * as React from 'react';
import { ChevronDownIcon } from '@radix-ui/react-icons';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { cn } from '~/utils';

const Accordion: React.ForwardRefExoticComponent<
  (AccordionPrimitive.AccordionSingleProps | AccordionPrimitive.AccordionMultipleProps) &
    React.RefAttributes<HTMLDivElement>
> = AccordionPrimitive.Root;

const AccordionItem: React.ForwardRefExoticComponent<
  Omit<AccordionPrimitive.AccordionItemProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className = '', ...props }, ref) => (
  <AccordionPrimitive.Item ref={ref} className={cn(className)} {...props} />
));
AccordionItem.displayName = 'AccordionItem';

const AccordionTrigger: React.ForwardRefExoticComponent<
  Omit<AccordionPrimitive.AccordionTriggerProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className = '', children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex flex-1 items-center justify-between py-4 text-sm font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronDownIcon className="text-text-secondary h-4 w-4 shrink-0 transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent: React.ForwardRefExoticComponent<
  Omit<AccordionPrimitive.AccordionContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className = '', children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-x-visible overflow-y-hidden text-sm transition-opacity data-[state=closed]:opacity-0 data-[state=open]:opacity-100"
    {...props}
  >
    <div className={cn('pt-0 pb-4', className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
