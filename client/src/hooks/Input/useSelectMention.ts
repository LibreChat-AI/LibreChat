import { useCallback, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useSearchParams } from 'react-router-dom';
import { EModelEndpoint, isAgentsEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';
import type {
  TPreset,
  TModelSpec,
  TConversation,
  TAssistantsMap,
  TEndpointsConfig,
} from 'librechat-data-provider';
import type { MentionOption, ConvoGenerator } from '~/common';
import {
  clearModelForNonEphemeralAgent,
  removeUnavailableTools,
  getModelSpecIconURL,
  getConvoSwitchLogic,
  logger,
} from '~/utils';
import { useDefaultConvo } from '~/hooks';
import store from '~/store';

export default function useSelectMention({
  presets,
  modelSpecs,
  assistantsMap,
  returnHandlers,
  endpointsConfig,
  getConversation,
  newConversation,
}: {
  presets?: TPreset[];
  modelSpecs: TModelSpec[];
  returnHandlers?: boolean;
  assistantsMap?: TAssistantsMap;
  newConversation: ConvoGenerator;
  endpointsConfig: TEndpointsConfig;
  getConversation: () => TConversation | null;
}) {
  const getDefaultConversation = useDefaultConvo();
  const modularChat = useRecoilValue(store.modularChat);
  const availableTools = useRecoilValue(store.availableTools);
  const [searchParams] = useSearchParams();
  /**
   * Project scope is read from React Router's search params (the same source the
   * project chip reads), not window.location — new-chat params are written to the
   * URL via raw history.pushState, so window.location can drift out of sync.
   */
  const routeChatProjectId = useMemo(() => {
    const projectId = searchParams.get('projectId');
    return projectId != null && /^[a-f\d]{24}$/i.test(projectId) ? projectId : null;
  }, [searchParams]);

  const onSelectSpec = useCallback(
    (spec?: TModelSpec) => {
      if (!spec) {
        return;
      }

      const conversation = getConversation();
      const preset = {
        ...spec.preset,
        iconURL: getModelSpecIconURL(spec),
        spec: spec.name,
      } as TPreset;
      const { endpoint } = preset;
      const newEndpoint = endpoint ?? '';
      if (!newEndpoint) {
        return;
      }

      const {
        template,
        shouldSwitch,
        isNewModular,
        newEndpointType,
        isCurrentModular,
        isExistingConversation,
      } = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });

      if (newEndpointType) {
        preset.endpointType = newEndpointType;
      }

      if (
        isAssistantsEndpoint(newEndpoint) &&
        preset.assistant_id != null &&
        !(preset.model ?? '')
      ) {
        preset.model = assistantsMap?.[newEndpoint]?.[preset.assistant_id]?.model;
      }

      const isModular = isCurrentModular && isNewModular && shouldSwitch;
      if (isExistingConversation && isModular) {
        template.endpointType = newEndpointType as EModelEndpoint | undefined;

        const currentConvo = getDefaultConversation({
          /* target endpointType is necessary to avoid endpoint mixing */
          conversation: { ...(conversation ?? {}), endpointType: template.endpointType },
          preset: template,
          cleanOutput: true,
        });

        /* We don't reset the latest message, only when changing settings mid-converstion */
        logger.info('conversation', 'Switching conversation to new spec (modular)', conversation);
        newConversation({
          template: currentConvo,
          preset,
          keepAddedConvos: true,
        });
        return;
      }

      logger.info('conversation', 'Switching conversation to new spec', conversation);
      newConversation({
        template: {
          ...(template as Partial<TConversation>),
          chatProjectId: routeChatProjectId ?? conversation?.chatProjectId ?? null,
        },
        preset,
        keepAddedConvos: isModular,
      });
    },
    [
      getConversation,
      getDefaultConversation,
      modularChat,
      newConversation,
      endpointsConfig,
      assistantsMap,
      routeChatProjectId,
    ],
  );

  type Kwargs = {
    model?: string;
    agent_id?: string;
    assistant_id?: string;
    spec?: string | null;
  };

  const onSelectEndpoint = useCallback(
    (_newEndpoint?: EModelEndpoint | string | null, kwargs: Kwargs = {}) => {
      const newEndpoint = _newEndpoint ?? '';
      if (!newEndpoint) {
        return;
      }

      const conversation = getConversation();

      const {
        shouldSwitch,
        isNewModular,
        isCurrentModular,
        isExistingConversation,
        newEndpointType,
        template,
      } = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });

      const model = kwargs.model ?? '';
      if (model) {
        template.model = model;
      }

      const assistant_id = kwargs.assistant_id ?? '';
      if (assistant_id) {
        template.assistant_id = assistant_id;
      }
      const agent_id = kwargs.agent_id ?? '';
      if (agent_id) {
        template.agent_id = agent_id;
      }
      clearModelForNonEphemeralAgent(template);

      template.spec = null;
      template.iconURL = null;
      template.modelLabel = null;
      if (isExistingConversation && isCurrentModular && isNewModular && shouldSwitch) {
        template.endpointType = newEndpointType;

        const currentConvo = getDefaultConversation({
          /* target endpointType is necessary to avoid endpoint mixing */
          conversation: {
            ...(conversation ?? {}),
            spec: null,
            iconURL: null,
            modelLabel: null,
            endpointType: template.endpointType,
          },
          preset: template,
        });

        /* We don't reset the latest message, only when changing settings mid-converstion */
        logger.info(
          'conversation',
          'Switching conversation to new endpoint/model (modular)',
          currentConvo,
        );
        newConversation({
          template: currentConvo,
          preset: currentConvo,
          keepAddedConvos: true,
        });
        return;
      }

      logger.info('conversation', 'Switching conversation to new endpoint/model', template);
      newConversation({
        template: {
          ...(template as Partial<TConversation>),
          chatProjectId: routeChatProjectId ?? conversation?.chatProjectId ?? null,
        },
        preset: { ...kwargs, spec: null, iconURL: null, modelLabel: null, endpoint: newEndpoint },
        keepAddedConvos: isNewModular,
      });
    },
    [
      getConversation,
      getDefaultConversation,
      modularChat,
      newConversation,
      endpointsConfig,
      routeChatProjectId,
    ],
  );

  const onSelectPreset = useCallback(
    (_newPreset?: TPreset) => {
      if (!_newPreset) {
        return;
      }

      const conversation = getConversation();

      const newPreset = removeUnavailableTools(_newPreset, availableTools);
      const newEndpoint = newPreset.endpoint ?? '';

      const {
        template,
        shouldSwitch,
        isNewModular,
        newEndpointType,
        isCurrentModular,
        isExistingConversation,
      } = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });

      newPreset.spec = null;
      newPreset.iconURL = newPreset.iconURL ?? null;
      newPreset.modelLabel = newPreset.modelLabel ?? null;
      const isModular = isCurrentModular && isNewModular && shouldSwitch;
      const disableParams = newPreset.defaultPreset === true;
      if (isExistingConversation && isModular) {
        template.endpointType = newEndpointType as EModelEndpoint | undefined;
        template.spec = null;
        template.iconURL = null;
        template.modelLabel = null;
        const currentConvo = getDefaultConversation({
          /* target endpointType is necessary to avoid endpoint mixing */
          conversation: { ...(conversation ?? {}), endpointType: template.endpointType },
          preset: template,
          cleanInput: true,
        });

        /* We don't reset the latest message, only when changing settings mid-converstion */
        logger.info('conversation', 'Switching conversation to new preset (modular)', currentConvo);
        newConversation({
          template: currentConvo,
          preset: newPreset,
          keepAddedConvos: true,
          disableParams,
        });
        return;
      }

      logger.info('conversation', 'Switching conversation to new preset', template);
      newConversation({
        template: { chatProjectId: routeChatProjectId ?? conversation?.chatProjectId ?? null },
        preset: newPreset,
        keepAddedConvos: isModular,
        disableParams,
      });
    },
    [
      modularChat,
      getConversation,
      availableTools,
      newConversation,
      endpointsConfig,
      getDefaultConversation,
      routeChatProjectId,
    ],
  );

  const onSelectMention = useCallback(
    (option: MentionOption) => {
      const key = option.value;
      if (option.type === 'preset') {
        const preset = presets?.find((p) => p.presetId === key);
        onSelectPreset(preset);
      } else if (option.type === 'modelSpec') {
        const modelSpec = modelSpecs.find((spec) => spec.name === key);
        onSelectSpec(modelSpec);
      } else if (option.type === 'model') {
        onSelectEndpoint(key, { model: option.label });
      } else if (option.type === 'endpoint') {
        onSelectEndpoint(key);
      } else if (isAssistantsEndpoint(option.type)) {
        onSelectEndpoint(option.type, {
          assistant_id: key,
          model: assistantsMap?.[option.type]?.[key]?.model ?? '',
        });
      } else if (isAgentsEndpoint(option.type)) {
        onSelectEndpoint(option.type, {
          agent_id: key,
        });
      }
    },
    [modelSpecs, onSelectEndpoint, onSelectPreset, onSelectSpec, presets, assistantsMap],
  );

  if (returnHandlers) {
    return {
      onSelectSpec,
      onSelectEndpoint,
    };
  }

  return {
    onSelectMention,
  };
}
