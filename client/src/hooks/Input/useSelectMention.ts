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
  switchesInPlace,
  logger,
} from '~/utils';
import { useDefaultConvo } from '~/hooks';
import store from '~/store';

/**
 * The endpoint a mention would switch the conversation to, as {@link useSelectMention} reads
 * it from the option; nothing for a preset or a model spec that is no longer there.
 */
export function mentionEndpoint(
  option: MentionOption,
  { presets, modelSpecs }: { presets?: TPreset[]; modelSpecs: TModelSpec[] },
): string | null | undefined {
  if (option.type === 'preset') {
    return presets?.find((preset) => preset.presetId === option.value)?.endpoint;
  }
  if (option.type === 'modelSpec') {
    return modelSpecs.find((spec) => spec.name === option.value)?.preset.endpoint;
  }
  if (option.type === 'model' || option.type === 'endpoint') {
    return option.value;
  }
  return option.type;
}

export default function useSelectMention({
  presets,
  modelSpecs,
  modularChat: given,
  assistantsMap,
  returnHandlers,
  endpointsConfig,
  getConversation,
  newConversation,
}: {
  presets?: TPreset[];
  modelSpecs: TModelSpec[];
  /**
   * The reader's Modular Chat preference, from a caller that was handed it. A caller that was
   * not leaves it out, and the app's own setting is read.
   */
  modularChat?: boolean;
  returnHandlers?: boolean;
  assistantsMap?: TAssistantsMap;
  newConversation: ConvoGenerator;
  endpointsConfig: TEndpointsConfig;
  getConversation: () => TConversation | null;
}) {
  const getDefaultConversation = useDefaultConvo();
  const stored = useRecoilValue(store.modularChat);
  const modularChat = given ?? stored;
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

      const logic = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });
      const { template, shouldSwitch, isNewModular, newEndpointType, isCurrentModular } = logic;

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
      if (switchesInPlace(logic)) {
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

      const logic = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });
      const { isNewModular, newEndpointType, template } = logic;

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
      if (switchesInPlace(logic)) {
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

      const logic = getConvoSwitchLogic({
        newEndpoint,
        modularChat,
        conversation,
        endpointsConfig,
      });
      const { template, shouldSwitch, isNewModular, newEndpointType, isCurrentModular } = logic;

      newPreset.spec = null;
      newPreset.iconURL = newPreset.iconURL ?? null;
      newPreset.modelLabel = newPreset.modelLabel ?? null;
      const isModular = isCurrentModular && isNewModular && shouldSwitch;
      const disableParams = newPreset.defaultPreset === true;
      if (switchesInPlace(logic)) {
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
