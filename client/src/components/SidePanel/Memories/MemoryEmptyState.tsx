import { Brain } from 'lucide-react';
import { EmptyState } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface MemoryEmptyStateProps {
  isFiltered?: boolean;
}

export default function MemoryEmptyState({ isFiltered = false }: MemoryEmptyStateProps) {
  const localize = useLocalize();

  if (isFiltered) {
    return <EmptyState icon={Brain} description={localize('com_ui_no_memories_match')} />;
  }

  return (
    <EmptyState
      icon={Brain}
      title={localize('com_ui_no_memories_title')}
      description={localize('com_ui_no_memories')}
    />
  );
}
