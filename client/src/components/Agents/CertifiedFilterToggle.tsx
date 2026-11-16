import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface CertifiedFilterToggleProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** Styled as a sibling of the category pills so the filter row reads as one set. */
function CertifiedFilterToggle({ checked, onCheckedChange }: CertifiedFilterToggleProps) {
  const localize = useLocalize();
  const label = localize('com_agents_filter_certified');

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      className={cn(
        'focus-visible:ring-text-primary inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-full border px-2.5 text-xs font-medium whitespace-nowrap select-none focus-visible:ring-2 focus-visible:outline-hidden focus-visible:ring-inset',
        checked
          ? 'border-border-chrome-heavy bg-surface-active-alt text-text-primary'
          : 'border-border-chrome bg-surface-secondary text-text-secondary hover:bg-surface-hover hover:text-text-primary',
      )}
      onClick={() => onCheckedChange(!checked)}
    >
      {label}
    </button>
  );
}

export default CertifiedFilterToggle;
