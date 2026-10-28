import React, { useMemo } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { OGDialog, OGDialogTitle, OGDialogContent } from '@librechat/client';
import type { TPromptGroup } from 'librechat-data-provider';
import VariableForm from '../forms/VariableForm';
import { detectVariables } from '~/utils';

interface VariableDialogProps extends Omit<DialogPrimitive.DialogProps, 'onOpenChange'> {
  onClose: () => void;
  group: TPromptGroup | null;
  /** Resolved prompt text; falls back to the production prompt when absent. */
  promptText?: string;
}

const VariableDialog: React.FC<VariableDialogProps> = ({ open, onClose, group, promptText }) => {
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
    }
  };

  const mainText = promptText ?? group?.productionPrompt?.prompt ?? '';
  const hasVariables = useMemo(() => detectVariables(mainText), [mainText]);
  if (!group) {
    return null;
  }

  if (!hasVariables) {
    return null;
  }

  return (
    <OGDialog open={open} onOpenChange={handleOpenChange}>
      <OGDialogContent className="text-text-primary max-h-[90vh] max-w-full overflow-y-auto md:max-w-[60vw]">
        <OGDialogTitle>{group.name}</OGDialogTitle>
        <VariableForm group={group} onClose={onClose} promptText={promptText} />
      </OGDialogContent>
    </OGDialog>
  );
};

export default VariableDialog;
