import { useState, useMemo, useCallback } from 'react';
import { Send } from 'lucide-react';
import { Button } from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import { useLocalize, useSubmitMessage } from '~/hooks';
import { useRecordPromptUsage } from '~/data-provider';
import VariableDialog from '../dialogs/VariableDialog';
import SharePrompt from '../dialogs/SharePrompt';
import { detectVariables } from '~/utils';

interface PromptActionsProps {
  group: TPromptGroup;
  mainText: string;
  onUsePrompt?: () => void;
}

const PromptActions = ({ group, mainText, onUsePrompt }: PromptActionsProps) => {
  const localize = useLocalize();
  const { submitPrompt } = useSubmitMessage();
  const { mutate: recordUsage } = useRecordPromptUsage();
  const [showVariableDialog, setShowVariableDialog] = useState(false);

  const hasVariables = useMemo(
    () => detectVariables(group.productionPrompt?.prompt ?? ''),
    [group.productionPrompt?.prompt],
  );

  const handleUsePrompt = useCallback(() => {
    if (hasVariables) {
      setShowVariableDialog(true);
    } else {
      submitPrompt(mainText);
      if (group._id) {
        recordUsage(group._id);
      }
      onUsePrompt?.();
    }
  }, [hasVariables, submitPrompt, mainText, onUsePrompt, group._id, recordUsage]);

  const handleVariableDialogClose = useCallback(() => {
    setShowVariableDialog(false);
    onUsePrompt?.();
  }, [onUsePrompt]);

  return (
    <>
      <div className="flex w-full gap-2 sm:justify-end sm:gap-3">
        <SharePrompt group={group} disabled={false} />

        <Button
          variant="submit"
          onClick={handleUsePrompt}
          className="flex-1 sm:min-w-40 sm:flex-none"
          aria-label={localize('com_ui_use_prompt')}
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          {localize('com_ui_use_prompt')}
        </Button>
      </div>

      <VariableDialog open={showVariableDialog} onClose={handleVariableDialogClose} group={group} />
    </>
  );
};

export default PromptActions;
