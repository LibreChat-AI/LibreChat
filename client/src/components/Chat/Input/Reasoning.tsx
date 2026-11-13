import { useEffect, useMemo, useRef } from 'react';
import { useAtom, useStore, useAtomValue } from 'jotai';
import { submissionByIndex } from '@librechat/chat/react';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from '@librechat/chat/react';
import {
  Constants,
  ReasoningParameterFormat,
  getEndpointField,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  reasoningOverrideSchema,
  isReasoningOverrideSupported,
  resolveReasoningSettingForTarget,
  getReasoningParamDefinitions,
} from 'librechat-data-provider';
import type {
  Agent,
  TMessage,
  SettingDefinition,
  TConversation,
  TReasoningOverride,
} from 'librechat-data-provider';
import { useGetAgentByIdQuery, useGetEndpointsQuery } from '~/data-provider';
import { useModelReasoning } from '~/hooks/Endpoint/useModelReasoning';
import { useAgentsMapContext } from '~/Providers';
import { resolveAgentTarget } from '~/utils';

/** The budget control renders from @librechat/chat; the composer and specs import it from here. */
export { ReasoningControl } from '@librechat/chat/components';

/** Override keys whose level also turns thinking on. */
const THINKING_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'effort',
  'thinkingLevel',
  'thinkingBudget',
]);

type ComposerReasoningOptions = {
  conversation: TConversation | null;
  index: number;
  hasAddedConversation?: boolean;
  enabled?: boolean;
  blockedReasoningKeys?: ReadonlySet<string>;
  /** The level the branch the next turn extends last ran at; shown until the user picks again. */
  branchReasoning?: TMessage['reasoningOverride'];
};

type ComposerReasoningState = {
  setting: SettingDefinition;
  value?: TReasoningOverride;
  setValue: (value: TReasoningOverride) => void;
};

export function useComposerReasoning({
  conversation,
  index,
  hasAddedConversation = false,
  enabled = true,
  blockedReasoningKeys,
  branchReasoning,
}: ComposerReasoningOptions): ComposerReasoningState | null {
  const agentsMap = useAgentsMapContext();
  const { data: fetchedAgent } = useGetAgentByIdQuery(conversation?.agent_id);
  const endpointsQuery = useGetEndpointsQuery();
  const endpointsConfig = useMemo(() => endpointsQuery.data ?? {}, [endpointsQuery.data]);
  const conversationId = conversation?.conversationId ?? Constants.NEW_CONVO;
  const reasoningStateKey = getReasoningStateKey(conversationId, index);
  const [value, setValue] = useAtom(pendingReasoningOverrideFamily(reasoningStateKey));
  const reasoningStore = useStore();
  const placeholderStateKey = getReasoningStateKey(null, index);
  const submission = useAtomValue(submissionByIndex(index));
  const submissionConversationId =
    submission?.conversation?.conversationId ?? submission?.userMessage?.conversationId;
  const submittedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    if (submission?.userMessage == null) {
      submittedConversationRef.current = null;
      return;
    }
    submittedConversationRef.current = getReasoningStateKey(submissionConversationId, index);
  }, [index, submission, submissionConversationId]);
  const previousStateKey = useRef(reasoningStateKey);

  /* A new chat holds its selection under the placeholder key until the
     `created`/`sync` event assigns a durable id. Only migrate while this pane
     still has the live submission that started under that placeholder (or a
     submission already stamped with the incoming id); navigation clears or
     replaces the pane submission, so it cannot move a new-chat choice into an
     unrelated conversation. Declared before the cleanup effect below so the
     moved value is in place before that effect judges it. */
  useEffect(() => {
    const previous = previousStateKey.current;
    previousStateKey.current = reasoningStateKey;
    const hasLiveSubmission =
      submission?.userMessage != null &&
      (submissionConversationId === conversationId ||
        submittedConversationRef.current === placeholderStateKey);
    if (previous === reasoningStateKey || previous !== placeholderStateKey || !hasLiveSubmission) {
      return;
    }
    const pending = reasoningStore.get(pendingReasoningOverrideFamily(previous));
    if (pending == null) {
      return;
    }
    reasoningStore.set(pendingReasoningOverrideFamily(previous), undefined);
    /* Never overwrite a choice already made under the durable key: a restore
       path (queued-message edit) can have written there first. */
    if (reasoningStore.get(pendingReasoningOverrideFamily(reasoningStateKey)) == null) {
      reasoningStore.set(pendingReasoningOverrideFamily(reasoningStateKey), pending);
    }
  }, [
    conversationId,
    placeholderStateKey,
    reasoningStateKey,
    reasoningStore,
    submission,
    submissionConversationId,
  ]);
  const endpoint = conversation?.endpointType ?? conversation?.endpoint ?? '';
  const agent = (fetchedAgent ?? agentsMap?.[conversation?.agent_id ?? '']) as Agent | undefined;
  const isAgent = isAgentsEndpoint(endpoint);
  const agentTarget = isAgent ? resolveAgentTarget(conversation?.agent_id, agent) : undefined;
  const provider = isAgent ? (agentTarget?.provider ?? '') : (conversation?.endpoint ?? '');
  const model = isAgent ? (agentTarget?.model ?? '') : (conversation?.model ?? '');
  const endpointType = getEndpointField(endpointsConfig, provider, 'type');
  const { modelReasoning, pending: capabilitiesPending } = useModelReasoning(
    endpointsConfig,
    provider,
    model,
  );
  const setting = useMemo(() => {
    const customParams = endpointsConfig[provider]?.customParams ?? {};
    return resolveReasoningSettingForTarget({
      endpoint: endpointType ?? provider,
      model,
      isAgent,
      defaultParamsEndpoint: customParams.defaultParamsEndpoint,
      reasoningFormat: customParams.reasoningFormat,
      paramDefinitions: getReasoningParamDefinitions(endpointsConfig[provider], model),
      blockedReasoningKeys,
      modelReasoning,
    });
  }, [
    blockedReasoningKeys,
    endpointType,
    endpointsConfig,
    isAgent,
    model,
    modelReasoning,
    provider,
  ]);
  const targetResolved =
    endpoint !== '' &&
    (!isAgent || agentTarget != null) &&
    (setting != null || endpointsQuery.data != null);
  /* The target is the endpoint or agent and the model. The efforts a catalog advertises for it
     are not part of the identity: a refresh that changes them is not the user switching targets,
     and a value the refreshed setting no longer allows is cleared as `mismatchedSetting` below. It
     is recorded even while the capabilities load, so a switch made then is not mistaken for the
     first target once they arrive. */
  const targetFingerprint = targetResolved
    ? `${isAgent ? conversation?.agent_id : provider}:${model}`
    : null;
  const previousTarget = useRef({ key: reasoningStateKey, fingerprint: targetFingerprint });
  const explicitlyUnavailable =
    enabled === false ||
    hasAddedConversation ||
    isAssistantsEndpoint(endpoint) ||
    endpointsConfig[provider]?.customParams?.reasoningFormat === ReasoningParameterFormat.disabled;
  const available =
    enabled === true &&
    !explicitlyUnavailable &&
    (!isAgent || agentTarget != null) &&
    setting != null;

  useEffect(() => {
    let targetChanged = false;
    if (targetFingerprint != null) {
      const previous = previousTarget.current;
      targetChanged =
        previous.key === reasoningStateKey &&
        previous.fingerprint != null &&
        previous.fingerprint !== targetFingerprint;
      previousTarget.current = { key: reasoningStateKey, fingerprint: targetFingerprint };
    }
    const unsupportedResolved = targetResolved && setting == null;
    /* A restored override can predate a capability change on the same target: its
       key may survive while its enum value or number no longer does. */
    const mismatchedSetting =
      setting != null && value != null && !isReasoningOverrideSupported(value, setting);
    /* While the capabilities are unknown the setting is hidden, which says nothing about the
       staged choice: keep it until the catalog confirms or refutes it. A switch of target is
       different, because the choice belonged to the old one, so it clears at once. */
    if (
      value != null &&
      (targetChanged ||
        (!capabilitiesPending &&
          (explicitlyUnavailable || unsupportedResolved || mismatchedSetting)))
    ) {
      setValue(undefined);
    }
  }, [
    capabilitiesPending,
    explicitlyUnavailable,
    reasoningStateKey,
    setValue,
    setting,
    targetFingerprint,
    targetResolved,
    value,
  ]);

  let configuredValue: unknown;
  if (setting != null) {
    configuredValue =
      isAgent && agent != null
        ? agent.model_parameters?.[setting.key]
        : conversation?.[setting.key];
  }
  const configuredScope = `${reasoningStateKey}\u0000${targetFingerprint ?? ''}`;
  const thinkingKey: string = 'thinking';
  const thinkingOff =
    (isAgent && agent != null ? agent.model_parameters?.[thinkingKey] : conversation?.thinking) ===
    false;
  /* Switching thinking off withdraws a staged level that would turn it back on; a level picked
     after the switch is off is the user turning it on for that turn, so it stays. */
  const previousThinking = useRef({ scope: configuredScope, off: thinkingOff });
  useEffect(() => {
    const previous = previousThinking.current;
    previousThinking.current = { scope: configuredScope, off: thinkingOff };
    if (
      previous.scope === configuredScope &&
      thinkingOff &&
      !previous.off &&
      value != null &&
      THINKING_LEVEL_KEYS.has(value.key)
    ) {
      setValue(undefined);
    }
  }, [configuredScope, setValue, thinkingOff, value]);
  /* The configured value changing while the conversation and target stay put is the user setting
     the level elsewhere (the Parameters panel). It replaces the branch level the way a composer
     pick does; otherwise the inherited level would silently outrank the edit. */
  const previousConfigured = useRef<{ scope: string; value: unknown } | null>(null);
  useEffect(() => {
    /* While the capabilities load the setting is hidden, which says nothing about the configured
       value: keep the last one seen, or its reappearance would read as an edit. */
    if (setting == null) {
      return;
    }
    const previous = previousConfigured.current;
    previousConfigured.current = { scope: configuredScope, value: configuredValue };
    if (
      previous == null ||
      previous.scope !== configuredScope ||
      Object.is(previous.value, configuredValue)
    ) {
      return;
    }
    /* A reset removes the value; it is the user choosing the default, not leaving the choice. */
    const editedValue = configuredValue ?? setting.default;
    if (editedValue == null) {
      return;
    }
    /* A pick turns thinking on; with the switch off, the panel's value stays a parameter. */
    if (thinkingOff && THINKING_LEVEL_KEYS.has(setting.key)) {
      return;
    }
    const edited = reasoningOverrideSchema.safeParse({ key: setting.key, value: editedValue });
    if (edited.success && isReasoningOverrideSupported(edited.data, setting)) {
      setValue(edited.data);
    }
  }, [configuredScope, configuredValue, setValue, setting, thinkingOff]);

  if (!available || setting == null) {
    return null;
  }

  /* Mirrors the server: thinking switched off wins over a level the next turn would only inherit. */
  const inherited =
    branchReasoning != null &&
    isReasoningOverrideSupported(branchReasoning, setting) &&
    !(thinkingOff && THINKING_LEVEL_KEYS.has(branchReasoning.key))
      ? branchReasoning
      : undefined;
  const displayedValue =
    value ??
    inherited ??
    reasoningOverrideSchema.safeParse({
      key: setting.key,
      value: configuredValue ?? setting.default,
    }).data;

  return { setting, value: displayedValue, setValue };
}
