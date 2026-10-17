import { OGDialogContent, OGDialog, OGDialogTitle } from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import PromptDetails from '../display/PromptDetails';
import { useLocalize } from '~/hooks';

const PreviewPrompt = ({
  group,
  chatIndex,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  group: TPromptGroup;
  /** The chat composer's index, forwarded to `PromptDetails` so its Use
   *  button can close a variable dialog opened from this preview on a
   *  chat change; undefined when this preview has no associated chat. */
  chatIndex?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: () => void;
}) => {
  const localize = useLocalize();
  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="w-11/12 max-w-5xl overflow-hidden"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <OGDialogTitle className="sr-only">{localize('com_ui_preview')}</OGDialogTitle>
        <PromptDetails
          group={group}
          chatIndex={chatIndex}
          onUsePrompt={() => onOpenChange(false)}
        />
      </OGDialogContent>
    </OGDialog>
  );
};

export default PreviewPrompt;
