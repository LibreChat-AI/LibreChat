import { useState } from 'react';
import type { TMessage } from 'librechat-data-provider';
import MultiMessage from './MultiMessage';
import { useLocalize } from '~/hooks';

export default function MessagesView({
  messagesTree: _messagesTree,
  conversationId,
}: {
  messagesTree?: TMessage[] | null;
  conversationId: string;
}) {
  const localize = useLocalize();
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);
  return (
    <div className="min-h-0 flex-1 overflow-hidden" data-testid="messages-view">
      <div className="relative h-full">
        <div className="h-full w-full overflow-y-auto">
          <div className="flex flex-col pb-16 text-sm">
            {(_messagesTree && _messagesTree.length === 0) || _messagesTree === null ? (
              <div className="bg-surface-secondary text-text-tertiary flex w-full items-center justify-center gap-1 p-3 text-sm">
                {localize('com_ui_nothing_found')}
              </div>
            ) : (
              <>
                <div>
                  <MultiMessage
                    key={conversationId} // avoid internal state mixture
                    messagesTree={_messagesTree}
                    messageId={conversationId ?? null}
                    setCurrentEditId={setCurrentEditId}
                    currentEditId={currentEditId ?? null}
                  />
                </div>
              </>
            )}
            <div className="group h-0 w-full shrink-0" />
          </div>
        </div>
      </div>
    </div>
  );
}
