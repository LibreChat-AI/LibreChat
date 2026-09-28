import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CaretSortIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon } from '@radix-ui/react-icons';
import { useNestedPopoverStyle } from './OriginalDialog';
import { cn } from '~/utils';

// @ts-ignore - Radix UI type conflicts with React types
const Select: React.FC<SelectPrimitive.SelectProps> = SelectPrimitive.Root;

// @ts-ignore - Radix UI type conflicts with React types
const SelectGroup: React.ForwardRefExoticComponent<
  SelectPrimitive.SelectGroupProps & React.RefAttributes<HTMLDivElement>
> = SelectPrimitive.Group;

const SelectValue: React.ForwardRefExoticComponent<
  SelectPrimitive.SelectValueProps & React.RefAttributes<HTMLSpanElement>
> = SelectPrimitive.Value;

// @ts-ignore - Radix UI type conflicts with React types
const SelectTrigger: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectTriggerProps & React.RefAttributes<HTMLButtonElement>, 'ref'> &
    React.RefAttributes<HTMLButtonElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className = '', children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-9 w-full items-center justify-between whitespace-nowrap rounded-md border border-border-medium bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-surface-primary placeholder:text-text-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1',
      'rounded-lg hover:bg-surface-hover',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <CaretSortIcon className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

const SelectScrollUpButton: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectScrollUpButtonProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollUpButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton>
>(({ className = '', ...props }, ref) => (
  <SelectPrimitive.ScrollUpButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronUpIcon />
  </SelectPrimitive.ScrollUpButton>
));
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectScrollDownButtonProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.ScrollDownButton>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton>
>(({ className = '', ...props }, ref) => (
  <SelectPrimitive.ScrollDownButton
    ref={ref}
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    {...props}
  >
    <ChevronDownIcon />
  </SelectPrimitive.ScrollDownButton>
));
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

const SelectContent: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectContentProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className = '', children, position = 'popper', style, ...props }, ref) => {
  const nestedStyle = useNestedPopoverStyle();
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        style={{ ...nestedStyle, ...style }}
        className={cn(
          'relative z-40 max-h-96 min-w-[8rem] overflow-hidden rounded-md border border-border-light bg-surface-secondary text-text-primary shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2',
          position === 'popper'
            ? 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1'
            : '',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            'p-1',
            position === 'popper'
              ? 'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]'
              : '',
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectLabelProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(({ className = '', ...props }, ref) => (
  <SelectPrimitive.Label
    ref={ref}
    className={cn('px-2 py-1.5 text-sm font-semibold', className)}
    {...props}
  />
));
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectItemProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className = '', children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none focus:bg-surface-hover focus:text-text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      'rounded-lg hover:bg-surface-hover',
      className,
    )}
    {...props}
  >
    <span className="absolute right-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <CheckIcon className="h-4 w-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator: React.ForwardRefExoticComponent<
  Omit<SelectPrimitive.SelectSeparatorProps & React.RefAttributes<HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(({ className = '', ...props }, ref) => (
  <SelectPrimitive.Separator
    ref={ref}
    className={cn('-mx-1 my-1 h-px bg-surface-tertiary', className)}
    {...props}
  />
));
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
