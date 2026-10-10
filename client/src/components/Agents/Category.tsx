import type { TranslationKeys } from '~/hooks';
import { useAgentCategories, useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface AgentCategoryBadgeProps {
  category?: string;
  className?: string;
}

export default function AgentCategoryBadge({ category, className }: AgentCategoryBadgeProps) {
  const localize = useLocalize();
  const { categories } = useAgentCategories();
  if (!category) {
    return null;
  }
  const label = categories.find((item) => item.value === category)?.label;
  let displayName = label || category.charAt(0).toUpperCase() + category.slice(1);
  if (label?.startsWith('com_')) {
    displayName = localize(label as TranslationKeys);
  }
  return (
    <span
      className={cn(
        'border-border-light bg-surface-tertiary text-text-secondary inline-flex max-w-full items-center rounded-full border px-2.5 py-1 text-xs leading-4 font-medium',
        className,
      )}
    >
      <span className="min-w-0 break-words">{displayName}</span>
    </span>
  );
}
