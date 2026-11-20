import { useState, useEffect, useRef } from 'react';
import {
  Label,
  Input,
  Button,
  Spinner,
  OGDialog,
  OGDialogClose,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import type { FormEvent, RefObject } from 'react';
import { useUpdateConversationMutation } from '~/data-provider';
import { NotificationSeverity } from '~/common';
import { useLocalize } from '~/hooks';
import { logger } from '~/utils';

const TITLE_MAX_LENGTH = 100;
const INPUT_ID = 'chat-rename-input';

type RenameProps = {
  conversationId: string;
  title: string;
  /** Saving an unchanged title is how a user claims an automatic one, so only an owned title short-circuits. */
  titleSetByUser: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: RefObject<HTMLButtonElement>;
};

function RenameContent({
  conversationId,
  title,
  titleSetByUser,
  onClose,
}: Pick<RenameProps, 'conversationId' | 'title' | 'titleSetByUser'> & { onClose: () => void }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const updateMutation = useUpdateConversationMutation(conversationId);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim() || localize('com_ui_untitled');
    if (next === title && titleSetByUser) {
      onClose();
      return;
    }
    try {
      await updateMutation.mutateAsync({ conversationId, title: next });
      /** A rename that settles after the dialog went away has no dialog left to close or focus. */
      if (mountedRef.current) {
        onClose();
      }
    } catch (error) {
      logger.error('Error renaming conversation', error);
      showToast({
        message: localize('com_ui_rename_failed'),
        severity: NotificationSeverity.ERROR,
        showIcon: true,
      });
    }
  };

  return (
    <OGDialogContent
      id="rename-conversation-dialog"
      className="w-11/12 max-w-md"
      showCloseButton={false}
    >
      <OGDialogHeader>
        <OGDialogTitle>{localize('com_ui_rename_conversation')}</OGDialogTitle>
      </OGDialogHeader>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor={INPUT_ID}>{localize('com_ui_new_conversation_title')}</Label>
          <Input
            id={INPUT_ID}
            ref={inputRef}
            value={value}
            maxLength={TITLE_MAX_LENGTH}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-4">
          <OGDialogClose asChild>
            <Button type="button" variant="outline">
              {localize('com_ui_cancel')}
            </Button>
          </OGDialogClose>
          <Button type="submit" variant="submit" disabled={updateMutation.isLoading}>
            {updateMutation.isLoading ? <Spinner /> : localize('com_ui_save')}
          </Button>
        </div>
      </form>
    </OGDialogContent>
  );
}

/** Rename for the open chat. The sidebar renames inline in its row, which the header has no row for. */
export default function Rename({
  conversationId,
  title,
  titleSetByUser,
  open,
  onOpenChange,
  triggerRef,
}: RenameProps) {
  /** Closing from a save bypasses the dialog's own handler, which is what returns focus to the
   *  menu item that opened it, so the same return is done here. */
  const close = () => {
    setTimeout(() => triggerRef?.current?.focus(), 0);
    onOpenChange(false);
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
      <RenameContent
        conversationId={conversationId}
        title={title}
        titleSetByUser={titleSetByUser}
        onClose={close}
      />
    </OGDialog>
  );
}
