import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import { Root, Anchor } from '@radix-ui/react-popover';
import { isParamEndpoint, getEndpointField, tConvoUpdateSchema } from 'librechat-data-provider';
import type { TPreset, TInterfaceConfig } from 'librechat-data-provider';
import { EndpointSettings, SaveAsPresetDialog, AlternativeSettings } from '~/components/Endpoints';
import { useSetIndexOptions, useLocalize } from '~/hooks';
import { useGetEndpointsQuery } from '~/data-provider';
import OptionsPopover from './OptionsPopover';
import PopoverButtons from './PopoverButtons';
import { useChatContext } from '~/Providers';

export default function HeaderOptions({
  interfaceConfig,
}: {
  interfaceConfig?: Partial<TInterfaceConfig>;
}) {
  const { data: endpointsConfig } = useGetEndpointsQuery();

  const [saveAsDialogShow, setSaveAsDialogShow] = useState<boolean>(false);
  const localize = useLocalize();

  const { showPopover, conversation, setShowPopover } = useChatContext();
  const { setOption } = useSetIndexOptions();
  const { endpoint } = conversation ?? {};

  const saveAsPreset = () => {
    setSaveAsDialogShow(true);
  };

  if (!endpoint) {
    return null;
  }

  const triggerAdvancedMode = () => setShowPopover((prev) => !prev);

  const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
  const paramEndpoint = isParamEndpoint(endpoint, endpointType);

  return (
    <Root open={showPopover} onOpenChange={setShowPopover}>
      <Anchor>
        <div className="my-auto lg:max-w-2xl xl:max-w-3xl">
          <span className="flex w-full flex-col items-center justify-center gap-0 md:order-none md:m-auto md:gap-2">
            <div className="z-[61] flex w-full items-center justify-center gap-2">
              {interfaceConfig?.parameters === true && paramEndpoint === false && (
                <TooltipAnchor
                  id="parameters-button"
                  aria-label={localize('com_ui_model_parameters')}
                  description={localize('com_ui_model_parameters')}
                  tabIndex={0}
                  role="button"
                  onClick={triggerAdvancedMode}
                  data-testid="parameters-button"
                  className="border-border-light text-text-primary hover:bg-surface-tertiary inline-flex size-10 items-center justify-center rounded-lg border bg-transparent transition-all ease-in-out disabled:pointer-events-none disabled:opacity-50"
                >
                  <Settings2 size={16} aria-hidden="true" />
                </TooltipAnchor>
              )}
            </div>
            {interfaceConfig?.parameters === true && paramEndpoint === false && (
              <OptionsPopover
                visible={showPopover}
                saveAsPreset={saveAsPreset}
                presetsDisabled={!(interfaceConfig.presets ?? false)}
                PopoverButtons={<PopoverButtons />}
                closePopover={() => setShowPopover(false)}
              >
                <div className="px-4 py-4">
                  <EndpointSettings
                    className="[&::-webkit-scrollbar]:w-2"
                    conversation={conversation}
                    setOption={setOption}
                  />
                  <AlternativeSettings conversation={conversation} setOption={setOption} />
                </div>
              </OptionsPopover>
            )}
            {interfaceConfig?.presets === true && (
              <SaveAsPresetDialog
                open={saveAsDialogShow}
                onOpenChange={setSaveAsDialogShow}
                preset={
                  tConvoUpdateSchema.parse({
                    ...conversation,
                  }) as TPreset
                }
              />
            )}
          </span>
        </div>
      </Anchor>
    </Root>
  );
}
