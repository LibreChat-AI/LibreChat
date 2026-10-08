import type { TUserMemory } from 'librechat-data-provider';
import MemoryCardActions from './MemoryCardActions';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface MemoryCardProps {
  memory: TUserMemory;
  hasUpdateAccess: boolean;
}

const formatDate = (dateString: string): string => {
  return new Date(dateString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
};

export default function MemoryCard({ memory, hasUpdateAccess }: MemoryCardProps) {
  const localize = useLocalize();
  const displayKey = memory.key || localize('com_ui_memory');

  return (
    <div
      className={cn(
        'group rounded-lg px-3 py-2.5',
        /** No border: a column of boxed rows reads as a stack of cards rather than
         *  as one list. The hover fill is what says "row" instead. */
        'hover:bg-surface-active-alt bg-transparent',
      )}
    >
      {/* Row 1: Key + Agent badge + Actions */}
      <div className="flex items-center gap-2">
        <span className="text-text-primary truncate text-sm font-medium">{displayKey}</span>
        {memory.agentId != null && (
          <span
            className="bg-surface-tertiary text-text-secondary shrink-0 truncate rounded-full px-2 py-0.5 text-xs"
            title={localize('com_ui_memory_agent_badge')}
          >
            {memory.agentName ?? memory.agentId}
          </span>
        )}
        {hasUpdateAccess && (
          <div className="ml-auto shrink-0">
            <MemoryCardActions memory={memory} />
          </div>
        )}
      </div>

      {/* Row 2: Value + Date */}
      <div className="mt-1 flex items-baseline gap-2">
        <p className="text-text-primary min-w-0 flex-1 truncate text-sm" title={memory.value}>
          {memory.value}
        </p>
        <span className="text-text-secondary shrink-0 text-xs">
          {formatDate(memory.updated_at)}
        </span>
      </div>
    </div>
  );
}
