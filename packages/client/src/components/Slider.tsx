import * as React from 'react';
import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '~/utils';

type SliderProps = React.ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & {
  className?: string;
  onDoubleClick?: () => void;
  'aria-describedby'?: string;
  'aria-valuetext'?: string;
} & (
    | { 'aria-label': string; 'aria-labelledby'?: never }
    | { 'aria-labelledby': string; 'aria-label'?: never }
    | { 'aria-label': string; 'aria-labelledby': string }
  );

const Slider: React.ForwardRefExoticComponent<SliderProps & React.RefAttributes<HTMLSpanElement>> =
  React.forwardRef<React.ElementRef<typeof SliderPrimitive.Root>, SliderProps>(
    (
      {
        className,
        onDoubleClick,
        'aria-labelledby': ariaLabelledBy,
        'aria-label': ariaLabel,
        'aria-describedby': ariaDescribedBy,
        'aria-valuetext': ariaValueText,
        ...props
      },
      ref,
    ) => (
      <SliderPrimitive.Root
        ref={ref}
        {...props}
        {...{
          className: cn(
            'relative flex w-full cursor-pointer touch-none select-none items-center',
            className,
          ),
          onDoubleClick,
        }}
      >
        <SliderPrimitive.Track
          {...{
            className: 'relative h-2 w-full grow overflow-hidden rounded-full bg-surface-tertiary',
          }}
        >
          <SliderPrimitive.Range {...{ className: 'absolute h-full bg-surface-inverted' }} />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          {...{
            className:
              'block h-5 w-5 rounded-full border-2 border-border-xheavy bg-surface-primary ring-offset-surface-primary transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
            'aria-labelledby': ariaLabelledBy,
            'aria-label': ariaLabel,
            'aria-describedby': ariaDescribedBy,
            'aria-valuetext': ariaValueText,
          }}
        />
      </SliderPrimitive.Root>
    ),
  );
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
