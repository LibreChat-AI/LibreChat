import { useCallback, useEffect, useMemo } from 'react';
import { useRecoilState } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import {
  QueryKeys,
  alternateName,
  isAgentsEndpoint,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import {
  Input,
  Label,
  Button,
  OGDialog,
  OGDialogTitle,
  ControlCombobox,
  OGDialogContent,
} from '@librechat/client';
import type { TModelsConfig, TEndpointsConfig } from 'librechat-data-provider';
import { useSetIndexOptions, useLocalize, useDebouncedInput } from '~/hooks';
import PopoverButtons from '~/components/Chat/Input/PopoverButtons';
import { mapEndpoints, getConvoSwitchLogic } from '~/utils';
import { EndpointSettings } from '~/components/Endpoints';
import { useGetEndpointsQuery } from '~/data-provider';
import { useChatContext } from '~/Providers';
import store from '~/store';

const EditPresetDialog = ({
  exportPreset,
  submitPreset,
  triggerRef,
}: {
  exportPreset: () => void;
  submitPreset: () => void;
  triggerRef?: React.RefObject<HTMLDivElement>;
}) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { preset, setPreset } = useChatContext();
  const { setOption, setOptions } = useSetIndexOptions(preset);
  const [onTitleChange, title] = useDebouncedInput({
    setOption,
    optionKey: 'title',
    initialValue: preset?.title,
  });
  const [presetModalVisible, setPresetModalVisible] = useRecoilState(store.presetModalVisible);

  const { data: _endpoints = [] } = useGetEndpointsQuery({
    select: mapEndpoints,
  });

  const availableEndpoints = useMemo(() => {
    return _endpoints.filter((endpoint) => !isAgentsEndpoint(endpoint));
  }, [_endpoints]);

  const endpointItems = useMemo(
    () =>
      availableEndpoints.map((value) => ({
        value,
        label: alternateName[value] ?? value,
      })),
    [availableEndpoints],
  );

  useEffect(() => {
    if (!preset) {
      return;
    }

    if (isAgentsEndpoint(preset.endpoint)) {
      return;
    }

    const presetEndpoint = preset.endpoint ?? '';

    if (!presetEndpoint) {
      return;
    }

    const modelsConfig = queryClient.getQueryData<TModelsConfig>([QueryKeys.models]);
    if (!modelsConfig) {
      return;
    }

    const models = modelsConfig[resolveModelCatalogKey(presetEndpoint, modelsConfig)] as
      | string[]
      | undefined;
    if (!models) {
      return;
    }
    if (!models.length) {
      return;
    }

    if (preset.model === models[0]) {
      return;
    }

    if (!models.includes(preset.model ?? '')) {
      console.log('setting model', models[0]);
      setOption('model')(models[0]);
    }
  }, [preset, queryClient, setOption]);

  const switchEndpoint = useCallback(
    (newEndpoint: string) => {
      if (!setOptions) {
        return console.warn('setOptions is not defined');
      }

      const { newEndpointType } = getConvoSwitchLogic({
        newEndpoint,
        modularChat: true,
        conversation: null,
        endpointsConfig: queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]) ?? {},
      });

      setOptions({
        endpoint: newEndpoint,
        endpointType: newEndpointType,
      });
    },
    [queryClient, setOptions],
  );

  const handleOpenChange = (open: boolean) => {
    setPresetModalVisible(open);
    if (!open) {
      setPreset(null);
    }
  };

  const { endpoint: _endpoint, endpointType, model } = preset || {};
  const endpoint = _endpoint ?? '';

  if (!endpoint) {
    return null;
  }

  if (isAgentsEndpoint(endpoint)) {
    return null;
  }

  return (
    <OGDialog open={presetModalVisible} onOpenChange={handleOpenChange} triggerRef={triggerRef}>
      <OGDialogContent className="bg-surface-dialog md:rounded-theme-surface flex h-[100dvh] max-h-[100dvh] w-full max-w-full flex-col overflow-y-visible md:h-auto md:max-h-[90vh] md:max-w-[75vw] lg:max-w-[59.375rem]">
        <OGDialogTitle className="shrink-0">
          {localize('com_ui_edit_preset_title', { title: preset?.title })}
        </OGDialogTitle>

        {/* Pinned above the scroller, and the dialog itself is overflow-visible:
            ControlCombobox renders its popover in place (portal={false} for the
            dialog's focus trap), so no ancestor may clip it. The flex column
            still bounds the dialog because the settings region below owns the
            only scroll. */}
        <div className="grid w-full shrink-0 gap-3 md:grid-cols-2 md:gap-4">
          <div className="flex w-full flex-col">
            <Label htmlFor="preset-name" variant="section">
              {localize('com_endpoint_preset_name')}
            </Label>
            <Input
              id="preset-name"
              value={(title as string | undefined) ?? ''}
              onChange={onTitleChange}
              placeholder={localize('com_endpoint_set_custom_name')}
              className="rounded-theme-control border-border-medium h-9 w-full px-3 py-2"
            />
          </div>
          <div className="flex w-full flex-col">
            <Label htmlFor="endpoint" variant="section">
              {localize('com_endpoint')}
            </Label>
            <ControlCombobox
              selectedValue={endpoint || ''}
              displayValue={alternateName[endpoint ?? ''] ?? endpoint ?? ''}
              items={endpointItems}
              setValue={switchEndpoint}
              ariaLabel={localize('com_endpoint')}
              searchPlaceholder={localize('com_endpoint_search')}
              selectPlaceholder={localize('com_endpoint')}
              isCollapsed={false}
              showCarat={true}
              /** The dialog traps focus and clips a portaled popover */
              portal={false}
            />
          </div>
        </div>

        {/* Only this region scrolls, so the title, the fields above and the actions stay put */}
        <div className="flex min-h-0 w-full flex-1 flex-col gap-3 overflow-y-auto px-1 md:gap-4">
          {/* PopoverButtons section */}
          <div className="flex w-full">
            <PopoverButtons
              buttonClass="ml-0 w-full border border-border-medium p-2 h-[2.5rem] justify-center mt-0"
              iconClass="hidden lg:block w-4"
              endpoint={endpoint}
              endpointType={endpointType}
              model={model}
            />
          </div>

          {/* Separator */}
          <div className="border-border-medium w-full border-t" />

          {/* Settings section. The shared component ships a fixed-height scroll
              box; overriding it to auto lets the dialog own the single scroll
              rather than nesting one inside another. */}
          <div className="w-full">
            <EndpointSettings
              conversation={preset}
              setOption={setOption}
              isPreset={true}
              className="text-text-primary h-auto overflow-visible md:h-auto"
            />
          </div>
        </div>

        {/* Action buttons */}
        <div className="border-border-medium flex shrink-0 justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={exportPreset}>
            {localize('com_endpoint_export')}
          </Button>
          <Button variant="submit" onClick={submitPreset}>
            {localize('com_ui_save')}
          </Button>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
};

export default EditPresetDialog;
