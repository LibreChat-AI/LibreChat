import { useState } from 'react';
import { OGDialog, OGDialogContent } from '@librechat/client';
import type { AgentItem } from '../items/types';
import { AgentPickerPortalContext } from '../../Advanced/AgentList';
import ItemDialogHeader from './ItemDialogHeader';
import ItemDialogBody from './ItemDialogBody';
import { cn } from '~/utils';

interface Props {
  item: AgentItem | null;
  agentId: string;
  onClose: () => void;
}

export default function ItemDialog({ item, agentId, onClose }: Props) {
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const isOrchestration = item?.kind === 'builtin' && item.id === 'orchestration';
  const isAction = item?.kind === 'action';
  return (
    <OGDialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent
        ref={setPortalElement}
        className={cn(
          'w-11/12 gap-0 rounded-2xl p-0 md:max-h-[85dvh]',
          isOrchestration ? 'overflow-visible' : 'overflow-hidden',
          isAction ? 'max-w-5xl' : 'max-w-[35rem]',
        )}
        data-testid="item-dialog"
      >
        {item && (
          <div className="flex max-h-[85dvh] flex-col">
            <ItemDialogHeader item={item} />
            <div
              className={cn(
                'px-6 pt-2 pb-6',
                isAction
                  ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                  : 'flex-1 overflow-y-auto',
              )}
            >
              <AgentPickerPortalContext.Provider value={portalElement}>
                <ItemDialogBody item={item} agentId={agentId} onClose={onClose} />
              </AgentPickerPortalContext.Provider>
            </div>
          </div>
        )}
      </OGDialogContent>
    </OGDialog>
  );
}
