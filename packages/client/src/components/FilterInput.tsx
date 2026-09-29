import * as React from 'react';
import { cn, disabledFillClasses, peerDisabledInkClasses } from '~/utils';

export interface FilterInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'placeholder'> {
  /** The label text shown in the floating label */
  label: string;
  /** Unique identifier for the input - used to link label */
  inputId: string;
  /** Container className for custom styling */
  containerClassName?: string;
  /** Surface behind the floating label, matching the input's surrounding panel. */
  surface?: 'primary' | 'presentation' | 'dialog';
}

/**
 * A standardized filter/search input component with a floating label
 * that animates up when focused or has a value.
 *
 * @example
 * <FilterInput
 *   inputId="bookmarks-filter"
 *   label={localize('com_ui_bookmarks_filter')}
 *   value={searchQuery}
 *   onChange={(e) => setSearchQuery(e.target.value)}
 * />
 */
/** The floating label breaks the field's top border, so it has to paint the
 *  surface behind it. The surface is painted on the container and inherited by the
 *  label, so a field on another panel names it through `surface` rather than the
 *  label drifting from its host. */
const SURFACE_CLASSES: Record<NonNullable<FilterInputProps['surface']>, string> = {
  primary: 'bg-surface-primary-alt',
  presentation: 'bg-presentation',
  dialog: 'bg-surface-dialog',
};

const FilterInput: React.ForwardRefExoticComponent<
  FilterInputProps & React.RefAttributes<HTMLInputElement>
> = React.forwardRef<HTMLInputElement, FilterInputProps>(
  ({ className, label, inputId, containerClassName, surface = 'primary', ...props }, ref) => {
    return (
      <div className={cn('relative', SURFACE_CLASSES[surface], containerClassName)}>
        <input
          id={inputId}
          ref={ref}
          placeholder=" "
          aria-label={label}
          className={cn(
            'peer border-border-light text-text-primary ring-offset-surface-primary placeholder:text-text-secondary flex h-9 w-full rounded-lg border bg-transparent px-3 py-2 text-sm focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
            disabledFillClasses,
            className,
          )}
          {...props}
        />
        <label
          htmlFor={inputId}
          className={cn(
            peerDisabledInkClasses,
            'text-text-secondary pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm transition-all duration-200 peer-focus:top-0 peer-focus:bg-inherit peer-focus:px-1 peer-focus:text-xs peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:bg-inherit peer-[:not(:placeholder-shown)]:px-1 peer-[:not(:placeholder-shown)]:text-xs',
          )}
        >
          {label}
        </label>
      </div>
    );
  },
);

FilterInput.displayName = 'FilterInput';

export { FilterInput };
