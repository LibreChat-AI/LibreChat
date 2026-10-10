import { useState, useRef } from 'react';
import { Pencil } from 'lucide-react';
import { Trans } from 'react-i18next';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  TrashIcon,
  TooltipAnchor,
  OGDialogTrigger,
  OGDialogTemplate,
  useToastContext,
} from '@librechat/client';
import type { TUserMemory } from 'librechat-data-provider';
import { useDeleteMemoryMutation } from '~/data-provider';
import MemoryEditDialog from './MemoryEditDialog';
import { rowActionSlotClasses } from '~/utils';
import { getMemoryAddress } from './address';
import { useLocalize } from '~/hooks';

interface MemoryCardActionsProps {
  memory: TUserMemory;
}

export default function MemoryCardActions({ memory }: MemoryCardActionsProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const memoryAddress = getMemoryAddress(memory);

  const { mutate: deleteMemory, isLoading: isDeleting } = useDeleteMemoryMutation();

  const confirmDelete = () => {
    if (!memoryAddress) {
      return;
    }
    deleteMemory(
      { ...memoryAddress, agentId: memory.agentId },
      {
        onSuccess: () => {
          showToast({ message: localize('com_ui_deleted'), status: 'success' });
          setDeleteOpen(false);
        },
        onError: () => {
          showToast({ message: localize('com_ui_error'), status: 'error' });
        },
      },
    );
  };

  if (!memoryAddress) {
    return null;
  }

  return (
    <div className={rowActionSlotClasses({ open: editOpen || deleteOpen })}>
      {/* Edit Button */}
      <MemoryEditDialog
        open={editOpen}
        memory={memory}
        onOpenChange={setEditOpen}
        triggerRef={triggerRef as React.MutableRefObject<HTMLButtonElement | null>}
      >
        <OGDialogTrigger asChild>
          <TooltipAnchor
            description={localize('com_ui_edit_memory')}
            side="top"
            render={
              <Button
                ref={triggerRef}
                type="button"
                variant="row-action-reveal"
                size="icon-xs"
                data-open={editOpen || undefined}
                aria-label={localize('com_ui_edit')}
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </OGDialogTrigger>
      </MemoryEditDialog>

      {/* Delete Button */}
      <OGDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <OGDialogTrigger asChild>
          <TooltipAnchor
            description={localize('com_ui_delete_memory')}
            side="top"
            render={
              <Button
                type="button"
                variant="row-action-reveal"
                size="icon-xs"
                data-open={deleteOpen || undefined}
                aria-label={localize('com_ui_delete')}
                onClick={() => setDeleteOpen(true)}
              >
                {isDeleting ? (
                  <Spinner className="size-4" />
                ) : (
                  <TrashIcon className="size-4" aria-hidden="true" />
                )}
              </Button>
            }
          />
        </OGDialogTrigger>
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_ui_delete_memory')}
          className="w-11/12 max-w-lg"
          main={
            <Label className="block text-left text-sm font-medium">
              {/* The key is the user's: it breaks anywhere, so a long one wraps inside
                  the dialog instead of setting its width. */}
              <Trans
                i18nKey="com_ui_delete_confirm_strong"
                values={{ title: memory.key || localize('com_ui_memory') }}
                components={{ strong: <strong className="break-all" /> }}
              />
            </Label>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses:
              'bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
}
