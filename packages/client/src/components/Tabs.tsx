import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn, disabledInkClasses } from '~/utils';

const Tabs: React.ForwardRefExoticComponent<
  TabsPrimitive.TabsProps & React.RefAttributes<HTMLDivElement>
> = TabsPrimitive.Root;

const TabsList: React.ForwardRefExoticComponent<
  Omit<TabsPrimitive.TabsListProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'bg-surface-primary inline-flex items-center justify-center rounded-md',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger: React.ForwardRefExoticComponent<
  Omit<TabsPrimitive.TabsTriggerProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Trigger
    className={cn(
      'text-text-secondary data-[state=active]:bg-surface-primary data-[state=active]:text-text-primary rounded-theme-tab min-w-theme-tab inline-flex items-center justify-center px-3 py-1.5 text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50',
      disabledInkClasses,
      className,
    )}
    {...props}
    ref={ref}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent: React.ForwardRefExoticComponent<
  Omit<TabsPrimitive.TabsContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className = '', ...props }, ref) => (
  <TabsPrimitive.Content className={cn('mt-2 rounded-md p-6', className)} {...props} ref={ref} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
