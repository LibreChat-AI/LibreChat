import { useRecoilValue } from 'recoil';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import {
  getEndpointField,
  SettingsViews,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { TSettingsProps } from '~/common';
import { useGetEndpointsQuery } from '~/data-provider';
import { getSettings } from './Settings';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

export default function Settings({
  conversation,
  setOption,
  isPreset = false,
  className = '',
}: TSettingsProps) {
  const modelsQuery = useGetModelsQuery();
  const localize = useLocalize();
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
  const unavailable =
    modelsQuery.isFetched &&
    modelsQuery.isSuccess &&
    modelsQuery.data != null &&
    conversation?.model &&
    !isAgentsEndpoint(_endpoint) &&
    !isAssistantsEndpoint(_endpoint) &&
    !models.includes(conversation.model);
  const unavailableChoice = unavailable ? (
    <p role="status" className="text-text-secondary">
      {localize('com_ui_model_unavailable', { 0: conversation.model })}
    </p>
  ) : null;
  const OptionComponent = settings[endpoint];

  if (OptionComponent) {
    return (
      <div
        className={cn(
          'h-[min(31.25rem,70vh)] overflow-y-auto md:mb-2 md:h-[min(21.875rem,70vh)]',
          className,
        )}
      >
        {unavailableChoice}
        <OptionComponent
          conversation={conversation}
          setOption={setOption}
          models={models}
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
    <div
      className={cn(
        'hide-scrollbar h-[min(31.25rem,70vh)] overflow-y-auto md:mb-2 md:h-[min(21.875rem,70vh)]',
        className,
      )}
    >
      {unavailableChoice}
      <MultiViewComponent conversation={conversation} models={models} isPreset={isPreset} />
    </div>
  );
}
