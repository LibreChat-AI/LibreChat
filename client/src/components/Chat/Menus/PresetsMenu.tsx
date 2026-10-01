import { useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useRecoilValue } from 'recoil';
import { BookCopy } from 'lucide-react';
import { tConvoUpdateSchema } from 'librechat-data-provider';
import { Content, Portal, Root, Trigger } from '@radix-ui/react-popover';
import {
  Button,
  OGDialog,
  TooltipAnchor,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
} from '@librechat/client';
import type { TPreset } from 'librechat-data-provider';
import type { FC } from 'react';
import { SaveAsPresetDialog } from '~/components/Endpoints';
import { EditPresetDialog, PresetItems } from './Presets';
import { useLocalize, usePresets } from '~/hooks';
import { useChatContext } from '~/Providers';
import store from '~/store';

const PresetsMenu: FC = () => {
  const localize = useLocalize();
  const presetsMenuTriggerRef = useRef<HTMLDivElement>(null);
  const [saveAsDialogOpen, setSaveAsDialogOpen] = useState(false);
  const [presetToSave, setPresetToSave] = useState<TPreset | null>(null);
  const { conversation } = useChatContext();
  const {
    presetsQuery,
    onSetDefaultPreset,
    onFileSelected,
    onSelectPreset,
    onChangePreset,
    clearAllPresets,
    onDeletePreset,
    submitPreset,
    exportPreset,
    showDeleteDialog,
    setShowDeleteDialog,
    presetToDelete,
    confirmDeletePreset,
  } = usePresets();
  const presetToEdit = useRecoilValue(store.presetByIndex(0));

  const openSaveAsDialog = () => {
    if (!conversation) {
      return;
    }
    setPresetToSave(tConvoUpdateSchema.parse({ ...conversation }) as TPreset);
    setSaveAsDialogOpen(true);
  };

  const handleDeleteDialogChange = (open: boolean) => {
    setShowDeleteDialog(open);
    if (!open && presetsMenuTriggerRef.current) {
      setTimeout(() => {
        presetsMenuTriggerRef.current?.focus();
      }, 0);
    }
  };

  return (
    <Root>
      {/* The open state belongs to the trigger, which stamps `data-state` on the
       *  button it renders through, so its fill is set here rather than on the button. */}
      <Trigger asChild className="data-[state=open]:bg-surface-active-alt">
        <TooltipAnchor
          ref={presetsMenuTriggerRef}
          description={localize('com_endpoint_examples')}
          render={
            <Button
              size="icon"
              variant="outline"
              tabIndex={0}
              id="presets-button"
              data-testid="presets-button"
              aria-label={localize('com_endpoint_examples')}
              className="rounded-theme-control bg-presentation hover:bg-surface-hover h-9 w-9 shrink-0 duration-0"
            >
              <BookCopy className="icon-md" aria-hidden="true" />
            </Button>
          }
        ></TooltipAnchor>
      </Trigger>
      <Portal>
        <Content
          side="bottom"
          align="center"
          sideOffset={8}
          collisionPadding={16}
          aria-label={localize('com_endpoint_examples')}
          className="rounded-theme-surface border-border-light bg-presentation text-text-primary z-50 max-h-[495px] overflow-x-hidden border shadow-lg md:min-w-[400px]"
        >
          <PresetItems
            presets={presetsQuery.data}
            onSetDefaultPreset={onSetDefaultPreset}
            onSelectPreset={onSelectPreset}
            onChangePreset={onChangePreset}
            onDeletePreset={onDeletePreset}
            clearAllPresets={clearAllPresets}
            onFileSelected={onFileSelected}
            onSaveAsPreset={conversation ? openSaveAsDialog : undefined}
          />
        </Content>
      </Portal>
      {presetToSave && (
        <SaveAsPresetDialog
          open={saveAsDialogOpen}
          onOpenChange={setSaveAsDialogOpen}
          preset={presetToSave}
        />
      )}
      {presetToEdit && (
        <EditPresetDialog
          submitPreset={submitPreset}
          exportPreset={exportPreset}
          triggerRef={presetsMenuTriggerRef}
        />
      )}
      {presetToDelete && (
        <OGDialog open={showDeleteDialog} onOpenChange={handleDeleteDialogChange}>
          <OGDialogContent
            title={localize('com_endpoint_preset_delete_confirm')}
            className="w-11/12 max-w-md"
            showCloseButton={false}
          >
            <OGDialogHeader>
              <OGDialogTitle>{localize('com_ui_delete_preset')}</OGDialogTitle>
            </OGDialogHeader>
            <div className="w-full truncate">
              <Trans
                i18nKey="com_ui_delete_confirm_strong"
                values={{ title: presetToDelete.title }}
                components={{ strong: <strong /> }}
              />
            </div>
            <div className="flex justify-end gap-4 pt-4">
              <Button
                aria-label="cancel"
                variant="outline"
                onClick={() => handleDeleteDialogChange(false)}
              >
                {localize('com_ui_cancel')}
              </Button>
              <Button variant="destructive" onClick={confirmDeletePreset}>
                {localize('com_ui_delete')}
              </Button>
            </div>
          </OGDialogContent>
        </OGDialog>
      )}
    </Root>
  );
};

export default PresetsMenu;
