import { PlusCircle } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
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
      render={
        <Button
          size="icon"
          className="size-9"
          variant="header-action"
          aria-label={localize('com_ui_add_multi_conversation')}
          onClick={addConversation}
          data-testid="add-multi-convo-button"
        >
          <PlusCircle className="icon-sm" aria-hidden="true" />
        </Button>
      }
    />
  );
}

export default AddMultiConvo;
