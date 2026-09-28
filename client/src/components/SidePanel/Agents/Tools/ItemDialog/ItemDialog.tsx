import { OGDialog, OGDialogContent } from '@librechat/client';
import type { AgentItem } from '../items/types';
import ItemDialogHeader from './ItemDialogHeader';
import ItemDialogBody from './ItemDialogBody';
import { cn } from '~/utils';

interface Props {
  item: AgentItem | null;
  agentId: string;
  onClose: () => void;
}

export default function ItemDialog({ item, agentId, onClose }: Props) {
  const isAction = item?.kind === 'action';
  return (
    <OGDialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent
        className={cn(
          'w-11/12 gap-0 overflow-hidden rounded-2xl p-0 md:max-h-[85dvh]',
          isAction ? 'max-w-5xl' : 'max-w-[560px]',
        )}
        data-testid="item-dialog"
      >
        {item && (
          <div className="flex max-h-[85dvh] flex-col">
            <ItemDialogHeader item={item} />
            <div
              className={cn(
                'px-6 pb-6 pt-2',
                isAction
                  ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                  : 'flex-1 overflow-y-auto',
              )}
            >
              <ItemDialogBody item={item} agentId={agentId} onClose={onClose} />
            </div>
          </div>
        )}
      </OGDialogContent>
    </OGDialog>
  );
}
