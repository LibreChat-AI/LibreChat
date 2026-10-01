import { useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import * as Ariakit from '@ariakit/react';
import { Close } from '@radix-ui/react-popover';
import { Flipper, Flipped } from 'react-flip-toolkit';
import { BookCopy, FileUp, FileX2, Ellipsis } from 'lucide-react';
import {
  Button,
  PinIcon,
  EditIcon,
  TrashIcon,
  DropdownPopup,
  TooltipAnchor,
  useToastContext,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@librechat/client';
import type { MenuItemProps } from '@librechat/client';
import type { TPreset } from 'librechat-data-provider';
import type { ChangeEvent, FC } from 'react';
import { ResolvedProviderIcon } from '~/components/Endpoints/ResolvedProviderIcon';
import { resolveProviderIcon } from '~/hooks/Endpoint';
import { useGetEndpointsQuery } from '~/data-provider';
import { getPresetTitle } from '~/utils';
import { MenuSeparator } from '../UI';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

/** Shared by the trigger and the clear dialog's focus fallback. */
const PRESET_MENU_ID = 'preset-options-button';

const PresetItems: FC<{
  presets?: Array<TPreset | undefined>;
  onSetDefaultPreset: (preset: TPreset, remove?: boolean) => void;
  onSelectPreset: (preset: TPreset) => void;
  onChangePreset: (preset: TPreset) => void;
  onDeletePreset: (preset: TPreset) => void;
  clearAllPresets: () => void;
  onFileSelected: (jsonData: Record<string, unknown>) => void;
  onSaveAsPreset?: () => void;
}> = ({
  presets,
  onSetDefaultPreset,
  onSelectPreset,
  onChangePreset,
  onDeletePreset,
  clearAllPresets,
  onFileSelected,
  onSaveAsPreset,
}) => {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const defaultPreset = useRecoilValue(store.defaultPreset);
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const hasPresets = (presets?.length ?? 0) > 0;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  /** Radix restores focus to whatever held it when the dialog mounted, which by
   *  then is the menu's own focus trap rather than the item that opened it. */
  const clearInvokerRef = useRef<HTMLElement | null>(null);

  const handleImportChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    /** Cleared so re-picking the same file still fires a change event */
    event.target.value = '';
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        onFileSelected(JSON.parse(e.target?.result as string));
      } catch {
        showToast({ message: localize('com_endpoint_preset_import_error'), status: 'error' });
      }
    };
    reader.readAsText(file);
  };

  const menuItems: MenuItemProps[] = [
    {
      label: localize('com_ui_import'),
      onClick: () => importInputRef.current?.click(),
      icon: <FileUp className="icon-sm text-text-primary" aria-hidden="true" />,
    },
    {
      label: localize('com_ui_clear_all'),
      onClick: () => {
        clearInvokerRef.current =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setIsClearDialogOpen(true);
      },
      icon: <FileX2 className="icon-sm" aria-hidden="true" />,
      className: 'text-text-destructive',
      show: hasPresets,
      ariaHasPopup: 'dialog' as const,
      hideOnClick: false,
    },
  ];

  return (
    <>
      <div className="border-border-light bg-surface-secondary flex min-w-[300px] items-center gap-3 border-b px-3 py-2 md:min-w-[400px]">
        <div className="min-w-0 flex-1">
          <p className="text-text-primary text-sm font-medium">
            {localize('com_endpoint_examples')}
          </p>
          {hasPresets && (
            <p className="text-text-secondary truncate text-xs">
              {defaultPreset
                ? `${localize('com_endpoint_preset_default_item')} ${defaultPreset.title}`
                : localize('com_endpoint_preset_default_none')}
            </p>
          )}
        </div>
        <DropdownPopup
          portal={true}
          menuId="preset-options-menu"
          focusLoop={true}
          className="z-[125]"
          unmountOnHide={true}
          isOpen={isMenuOpen}
          setIsOpen={setIsMenuOpen}
          trigger={
            <Ariakit.MenuButton
              id={PRESET_MENU_ID}
              aria-label={localize('com_ui_more_options')}
              aria-expanded={isMenuOpen}
              className={cn(
                'rounded-theme-control hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary inline-flex size-8 shrink-0 items-center justify-center transition-colors focus-visible:ring-2 focus-visible:outline-hidden',
                isMenuOpen ? 'bg-surface-hover text-text-primary' : 'text-text-secondary',
              )}
            >
              <Ellipsis className="icon-md" aria-hidden="true" />
            </Ariakit.MenuButton>
          }
          items={menuItems}
        />
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".json"
        className="hidden"
        tabIndex={-1}
        onChange={handleImportChange}
      />

      <AlertDialog open={isClearDialogOpen} onOpenChange={setIsClearDialogOpen}>
        <AlertDialogContent
          /** The menu stays open behind the dialog (`hideOnClick: false`), so
           *  the item is still there to take focus back. */
          onCloseAutoFocus={(event) => {
            const saved = clearInvokerRef.current;
            clearInvokerRef.current = null;
            /** Confirming removes the item itself, since it only shows while
             *  presets exist, so fall back to the trigger that opened the menu. */
            const invoker =
              saved?.isConnected === true ? saved : document.getElementById(PRESET_MENU_ID);
            if (invoker == null) {
              return;
            }
            event.preventDefault();
            invoker.focus();
          }}
          className="rounded-theme-surface sm:rounded-theme-surface w-11/12 max-w-md"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{localize('com_ui_clear_presets')}</AlertDialogTitle>
            <AlertDialogDescription>
              {localize('com_endpoint_presets_clear_warning')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{localize('com_ui_cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearAllPresets}
              className="bg-surface-destructive text-text-on-status hover:bg-surface-destructive-hover"
            >
              {localize('com_ui_clear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {presets && presets.length === 0 && (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <div className="bg-surface-secondary text-text-secondary rounded-full p-2.5">
            <BookCopy className="size-5" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="text-text-primary text-sm font-medium">
              {localize('com_endpoint_no_presets')}
            </p>
            <p className="text-text-secondary max-w-sm text-xs leading-5">
              {localize('com_endpoint_no_presets_description')}
            </p>
          </div>
          {onSaveAsPreset && (
            <Button variant="default" size="sm" type="button" onClick={onSaveAsPreset}>
              {localize('com_endpoint_save_as_preset')}
            </Button>
          )}
        </div>
      )}
      <Flipper
        flipKey={presets
          ?.map((preset) => preset?.presetId)
          .filter((p) => p)
          .join('.')}
      >
        {presets &&
          presets.length > 0 &&
          presets.map((preset, i) => {
            const presetId = preset?.presetId ?? '';
            if (!preset || !presetId) {
              return null;
            }

            const { provider, imageURL } = resolveProviderIcon({
              endpoint: preset.endpoint,
              endpointsConfig,
            });
            const presetTitle = getPresetTitle(preset);

            return (
              <Close asChild key={`preset-${presetId}`}>
                <div key={`preset-${presetId}`}>
                  <Flipped flipId={presetId}>
                    <div className="group rounded-theme-control hover:bg-surface-hover m-1.5 flex items-center gap-2 px-3 py-1.5 text-sm">
                      <Button
                        variant="ghost"
                        type="button"
                        className="rounded-theme-control h-auto min-w-0 flex-1 justify-start gap-1 bg-transparent p-2 text-left text-xs font-normal hover:bg-transparent focus-visible:ring-offset-0"
                        onClick={() => onSelectPreset(preset)}
                        aria-label={presetTitle}
                        data-testid={`preset-item-${presetId}`}
                      >
                        <ResolvedProviderIcon
                          provider={provider}
                          imageURL={imageURL}
                          size={20}
                          className="icon-md shrink-0"
                        />
                        <span className="truncate">{presetTitle}</span>
                      </Button>
                      <div className="flex items-center justify-end gap-1">
                        <TooltipAnchor
                          description={
                            defaultPreset?.presetId === presetId
                              ? localize('com_ui_unpin')
                              : localize('com_ui_pin')
                          }
                          aria-label={
                            defaultPreset?.presetId === presetId
                              ? localize('com_ui_unpin')
                              : localize('com_ui_pin')
                          }
                          render={
                            <Button
                              variant="ghost"
                              className={cn(
                                'rounded-theme-control-round text-text-tertiary hover:text-text-primary focus:text-text-primary m-0 h-full bg-transparent p-2',
                                defaultPreset?.presetId === presetId
                                  ? ''
                                  : // opacity keeps buttons in the tab order; pointer-events-none
                                    // while transparent so touch/pointer cannot hit invisible controls
                                    'sm:pointer-events-none sm:opacity-0 sm:transition-opacity sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:focus:pointer-events-auto sm:focus:opacity-100',
                              )}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onSetDefaultPreset(preset, defaultPreset?.presetId === presetId);
                              }}
                            >
                              <PinIcon unpin={defaultPreset?.presetId === presetId} />
                            </Button>
                          }
                        />
                        <TooltipAnchor
                          description={localize('com_ui_edit')}
                          aria-label={localize('com_ui_edit')}
                          render={
                            <Button
                              variant="ghost"
                              className="rounded-theme-control-round text-text-tertiary hover:text-text-primary focus:text-text-primary m-0 h-full p-2 sm:pointer-events-none sm:opacity-0 sm:transition-opacity sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:focus:pointer-events-auto sm:focus:opacity-100"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onChangePreset(preset);
                              }}
                            >
                              <EditIcon />
                            </Button>
                          }
                        />
                        <TooltipAnchor
                          description={localize('com_ui_delete')}
                          aria-label={localize('com_ui_delete')}
                          render={
                            <Button
                              variant="ghost"
                              className="rounded-theme-control-round text-text-tertiary hover:text-text-primary focus:text-text-primary m-0 h-full p-2 sm:pointer-events-none sm:opacity-0 sm:transition-opacity sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:focus:pointer-events-auto sm:focus:opacity-100"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onDeletePreset(preset);
                              }}
                            >
                              <TrashIcon />
                            </Button>
                          }
                        />
                      </div>
                    </div>
                  </Flipped>
                  {i !== presets.length - 1 && <MenuSeparator />}
                </div>
              </Close>
            );
          })}
      </Flipper>
    </>
  );
};

export default PresetItems;
