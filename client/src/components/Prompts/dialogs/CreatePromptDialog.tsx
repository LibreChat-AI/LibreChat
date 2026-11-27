import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import CreatePromptForm from '../forms/CreatePromptForm';
import { useLocalize } from '~/hooks';

interface CreatePromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
}

export default function CreatePromptDialog({
  open,
  onOpenChange,
  children,
}: CreatePromptDialogProps) {
  const localize = useLocalize();
  const navigate = useNavigate();

  const handleSuccess = useCallback(
    (groupId: string) => {
      onOpenChange(false);
      navigate(`/prompts/${groupId}`);
    },
    [navigate, onOpenChange],
  );

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      {children}
      <OGDialogContent className="w-11/12 max-w-5xl">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_ui_create_prompt')}</OGDialogTitle>
        </OGDialogHeader>
        {/* Padding keeps the name field's floating label and focus rings from clipping */}
        <div className="max-h-[75vh] overflow-y-auto px-1 pt-3">
          <CreatePromptForm isDialog onSuccess={handleSuccess} />
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
