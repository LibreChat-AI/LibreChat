import { PlusCircle } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import useMultiConvo from '~/hooks/Chat/useMultiConvo';
import { useLocalize } from '~/hooks';

function AddMultiConvo() {
  const localize = useLocalize();
  const { show, addConversation } = useMultiConvo();

  if (!show) {
    return null;
  }

  return (
    <TooltipAnchor
      description={localize('com_ui_add_multi_conversation')}
      role="button"
      tabIndex={0}
      aria-label={localize('com_ui_add_multi_conversation')}
      onClick={addConversation}
      data-testid="add-multi-convo-button"
      className="border-border-light bg-presentation text-text-primary hover:bg-surface-tertiary inline-flex size-9 shrink-0 items-center justify-center rounded-xl border transition-all ease-in-out disabled:pointer-events-none disabled:opacity-50"
    >
      <PlusCircle className="icon-sm" aria-hidden="true" />
    </TooltipAnchor>
  );
}

export default AddMultiConvo;
