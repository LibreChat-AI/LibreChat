import { useRecoilValue } from 'recoil';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { getEndpointField, SettingsViews } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { TSettingsProps } from '~/common';
import { useGetEndpointsQuery } from '~/data-provider';
import { getSettings } from './Settings';
import { cn } from '~/utils';
import store from '~/store';

export default function Settings({
  conversation,
  setOption,
  isPreset = false,
  className = '',
}: TSettingsProps) {
  const modelsQuery = useGetModelsQuery();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const currentSettingsView = useRecoilValue(store.currentSettingsView);
  const endpointType = getEndpointField(endpointsConfig, conversation?.endpoint ?? '', 'type');
  const endpoint = endpointType ?? conversation?.endpoint ?? '';
  if (!endpoint || currentSettingsView !== SettingsViews.default) {
    return null;
  }

  const { settings, multiViewSettings } = getSettings();
  const { endpoint: _endpoint } = conversation as TConversation;
  const models = modelsQuery.data?.[_endpoint ?? ''] ?? [];
  const modelLabels = getEndpointField(endpointsConfig, _endpoint, 'modelLabels');
  const OptionComponent = settings[endpoint];

  if (OptionComponent) {
    return (
      <div className={cn('h-[500px] overflow-y-auto md:mb-2 md:h-[350px]', className)}>
        <OptionComponent
          conversation={conversation}
          setOption={setOption}
          models={models}
          modelLabels={modelLabels}
          isPreset={isPreset}
        />
      </div>
    );
  }

  const MultiViewComponent = multiViewSettings[endpoint];

  if (MultiViewComponent == null) {
    return null;
  }

  return (
    <div className={cn('hide-scrollbar h-[500px] overflow-y-auto md:mb-2 md:h-[350px]', className)}>
      <MultiViewComponent conversation={conversation} models={models} isPreset={isPreset} />
    </div>
  );
}
