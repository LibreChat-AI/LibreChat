import { useCallback, useRef, useState } from 'react';
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
  const isOrchestration =
    item?.kind === 'builtin' && (item.id === 'subagents' || item.id === 'handoffs');
  const isAction = item?.kind === 'action';
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node;
    setPortalElement(node);
  }, []);

  /** Without this, Radix focuses the first focusable element, which for orchestration items is
   *  the info hover card trigger, so the card opens on focus as soon as the dialog does. */
  const handleOpenAutoFocus = (event: Event) => {
    event.preventDefault();
    contentRef.current?.focus();
  };
  return (
    <OGDialog open={item !== null} onOpenChange={(next) => !next && onClose()}>
      <OGDialogContent
        ref={setContent}
        tabIndex={-1}
        focusOutline="hidden"
        onOpenAutoFocus={handleOpenAutoFocus}
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
