import { OGDialogContent, OGDialog, OGDialogTitle } from '@librechat/client';
import type {
  TPromptGroup,
  PromptSelection,
  TResolvedPromptResponse,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import PromptDetails from '../display/PromptDetails';
import { useLocalize } from '~/hooks';

const PreviewPrompt = ({
  group,
  chatIndex,
  open,
  onOpenChange,
  onCloseAutoFocus,
  selection,
  showActions,
  substituteVariables,
  getVersionLabel,
  footer,
}: {
  group: TPromptGroup;
  /** The chat composer's index, forwarded to `PromptDetails` so its Use
   *  button can close a variable dialog opened from this preview on a
   *  chat change; undefined when this preview has no associated chat. */
  chatIndex?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: () => void;
  /** The revision to show. Defaults to Production. */
  selection?: PromptSelection;
  showActions?: boolean;
  substituteVariables?: boolean;
  getVersionLabel?: (resolved: TResolvedPromptResponse | undefined) => string;
  /** Rendered below the prompt details, for example a link to the prompt. */
  footer?: ReactNode;
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
          selection={selection}
          showActions={showActions}
          substituteVariables={substituteVariables}
          getVersionLabel={getVersionLabel}
          onUsePrompt={() => onOpenChange(false)}
        />
        {footer}
      </OGDialogContent>
    </OGDialog>
  );
};

export default PreviewPrompt;
