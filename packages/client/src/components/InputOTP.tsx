import * as React from 'react';
import { Minus } from 'lucide-react';
import { OTPInput, OTPInputContext, RenderProps } from 'input-otp';
import { cn, disabledWithinFillClasses } from '~/utils';

const InputOTP: React.ForwardRefExoticComponent<
  (
    | Omit<
        Omit<
          React.InputHTMLAttributes<HTMLInputElement>,
          | 'value'
          | 'onChange'
          | 'maxLength'
          | 'containerClassName'
          | 'textAlign'
          | 'onComplete'
          | 'pushPasswordManagerStrategy'
          | 'pasteTransformer'
          | 'noScriptCSSFallback'
        > & {
          value?: string;
          onChange?: (newValue: string) => unknown;
          maxLength: number;
          textAlign?: 'left' | 'center' | 'right';
          onComplete?: (...args: unknown[]) => unknown;
          pushPasswordManagerStrategy?: 'increase-width' | 'none';
          pasteTransformer?: (pasted: string) => string;
          containerClassName?: string;
          noScriptCSSFallback?: string | null;
        } & {
          render: (props: RenderProps) => React.ReactNode;
          children?: never;
        } & React.RefAttributes<HTMLInputElement>,
        'ref'
      >
    | Omit<
        Omit<
          React.InputHTMLAttributes<HTMLInputElement>,
          | 'value'
          | 'onChange'
          | 'maxLength'
          | 'containerClassName'
          | 'textAlign'
          | 'onComplete'
          | 'pushPasswordManagerStrategy'
          | 'pasteTransformer'
          | 'noScriptCSSFallback'
        > & {
          value?: string;
          onChange?: (newValue: string) => unknown;
          maxLength: number;
          textAlign?: 'left' | 'center' | 'right';
          onComplete?: (...args: unknown[]) => unknown;
          pushPasswordManagerStrategy?: 'increase-width' | 'none';
          pasteTransformer?: (pasted: string) => string;
          containerClassName?: string;
          noScriptCSSFallback?: string | null;
        } & {
          render?: never;
          children: React.ReactNode;
        } & React.RefAttributes<HTMLInputElement>,
        'ref'
      >
  ) &
    React.RefAttributes<HTMLInputElement>
> = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn(
      'flex items-center gap-2 has-[:disabled]:opacity-50',
      disabledWithinFillClasses,
      containerClassName,
    )}
    className={cn('disabled:cursor-not-allowed', className)}
    {...props}
  />
));
InputOTP.displayName = 'InputOTP';

const InputOTPGroup: React.ForwardRefExoticComponent<
  Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<'div'>, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center', className)} {...props} />
  ),
);
InputOTPGroup.displayName = 'InputOTPGroup';

const InputOTPSlot: React.ForwardRefExoticComponent<
  Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, 'ref'> & {
    index: number;
  } & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<
  React.ElementRef<'div'>,
  React.ComponentPropsWithoutRef<'div'> & { index: number }
>(({ index, className, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext);

  if (!inputOTPContext) {
    throw new Error('InputOTPSlot must be used within an OTPInput');
  }

  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index];

  return (
    <div
      ref={ref}
      className={cn(
        'border-border-control relative flex h-11 w-11 items-center justify-center border-y border-r text-base shadow-xs transition-all first:rounded-l-xl first:border-l last:rounded-r-xl',
        isActive && 'ring-focus-control z-10 ring-1',
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink bg-text-primary h-4 w-px duration-1000" />
        </div>
      )}
    </div>
  );
});
InputOTPSlot.displayName = 'InputOTPSlot';

const InputOTPSeparator: React.ForwardRefExoticComponent<
  Omit<React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>, 'ref'> &
    React.RefAttributes<HTMLDivElement>
> = React.forwardRef<React.ElementRef<'div'>, React.ComponentPropsWithoutRef<'div'>>(
  ({ ...props }, ref) => (
    <div ref={ref} role="separator" {...props}>
      <Minus />
    </div>
  ),
);
InputOTPSeparator.displayName = 'InputOTPSeparator';

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
