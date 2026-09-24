import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { useAtom, useStore } from 'jotai';
import * as Popover from '@radix-ui/react-popover';
import { Button, Input, Slider } from '@librechat/client';
import { BrainCircuit, ChevronDown, X } from 'lucide-react';
import {
  Constants,
  ReasoningParameterFormat,
  clampSettingRange,
  getEndpointField,
  isAgentsEndpoint,
  isAssistantsEndpoint,
  reasoningOverrideSchema,
  resolveReasoningSettingForTarget,
} from 'librechat-data-provider';
import type {
  Agent,
  SettingDefinition,
  TConversation,
  TReasoningOverride,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from './Composer/state';
import { useGetAgentByIdQuery, useGetEndpointsQuery } from '~/data-provider';
import { formatTokens, resolveAgentTarget } from '~/utils';
import { useAgentsMapContext } from '~/Providers';
import { useLocalize } from '~/hooks';
import store from '~/store';

type ReasoningControlProps = {
  index: number;
  setting: SettingDefinition;
  value?: TReasoningOverride;
  disabled?: boolean;
  onChange: (value: TReasoningOverride) => void;
};

const translated = (
  value: string | number | boolean | undefined,
  localize: ReturnType<typeof useLocalize>,
) =>
  typeof value === 'string' && value.startsWith('com_')
    ? localize(value as TranslationKeys)
    : String(value ?? '');

export function ReasoningControl({
  index,
  setting,
  value,
  disabled = false,
  onChange,
}: ReasoningControlProps) {
  const localize = useLocalize();
  const labelId = useId();
  const options = setting.options ?? [];
  const isEnum = setting.type === 'enum' && options.length > 0;
  const label = translated(setting.label ?? setting.key, localize);
  const selectedValue = value?.key === setting.key ? value.value : setting.default;
  const selectedIndex = isEnum ? Math.max(0, options.indexOf(String(selectedValue ?? ''))) : 0;
  let displayValue = String(selectedValue ?? localize('com_ui_auto'));
  if (isEnum) {
    displayValue = translated(
      setting.enumMappings?.[options[selectedIndex]] ?? options[selectedIndex],
      localize,
    );
  } else if (selectedValue === -1) {
    displayValue = localize('com_ui_auto');
  } else if (typeof selectedValue === 'number') {
    displayValue = `${formatTokens(selectedValue)} ${localize('com_ui_tokens')}`;
  }
  const [numericValue, setNumericValue] = useState(String(selectedValue ?? -1));

  useEffect(() => {
    if (!isEnum) {
      setNumericValue(String(selectedValue ?? -1));
    }
  }, [isEnum, selectedValue]);

  const emit = (nextValue: string | number) => {
    const parsed = reasoningOverrideSchema.safeParse({ key: setting.key, value: nextValue });
    if (parsed.success) {
      onChange(parsed.data);
    }
  };

  const range = useMemo(() => setting.range ?? { min: -1, max: 200000, step: 1 }, [setting.range]);
  const numericMin = range.positiveMin ?? Math.max(0, range.min);
  const parsedNumericValue = Number(numericValue);
  const numericScaleValue = Number.isFinite(parsedNumericValue)
    ? Math.min(range.max, Math.max(numericMin, parsedNumericValue))
    : numericMin;
  const isAuto = range.min === -1 && numericValue === '-1';

  const emitNumericValue = (nextValue: number) => {
    setNumericValue(String(nextValue));
    emit(nextValue);
  };

  const commitNumericValue = () => {
    const parsed = numericValue.trim() === '' ? range.min : Number(numericValue);
    const nextValue = clampSettingRange(
      Number.isFinite(parsed) ? Math.round(parsed) : range.min,
      range,
    );
    setNumericValue(String(nextValue));
    if (nextValue !== (selectedValue ?? range.min)) {
      emit(nextValue);
    }
  };

  return (
    <Popover.Root modal>
      <Popover.Trigger asChild>
        {/* Styled as the composer control it sits beside (the Thinking pill in
            `Composer/Thinking.tsx`) rather than as a restyled `Button`: the
            open state keeps it lit while its popover is up, which no `Button`
            variant expresses. */}
        <button
          type="button"
          disabled={disabled}
          aria-label={`${localize('com_ui_reasoning_for_next_message')} ${displayValue}`}
          className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary data-[state=open]:bg-surface-hover data-[state=open]:text-text-primary inline-flex h-8 items-center justify-center gap-1.5 rounded-xl px-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        >
          <BrainCircuit className="size-4" aria-hidden="true" />
          <ChevronDown className="size-3" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-chat-pane-portal={index}
          role="dialog"
          aria-label={label}
          align="end"
          sideOffset={6}
          className="border-border-light bg-surface-secondary text-text-primary data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 z-50 w-72 max-w-[calc(100vw-2rem)] origin-[--radix-popover-content-transform-origin] overflow-hidden rounded-2xl border shadow-xl motion-reduce:animate-none"
        >
          <div className="flex items-center gap-2 px-4 py-3">
            <BrainCircuit className="text-text-secondary size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div id={labelId} className="truncate text-sm font-medium">
                {label}
              </div>
              <div className="text-text-secondary truncate text-xs">
                {localize('com_ui_reasoning_for_next_message')}
              </div>
            </div>
            <Popover.Close asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={localize('com_ui_close')}
                className="group -mr-1 shrink-0"
              >
                <X
                  className="text-text-secondary group-hover:text-text-primary size-4"
                  aria-hidden="true"
                />
              </Button>
            </Popover.Close>
          </div>
          <div className="border-border-light border-t px-4 pt-3 pb-4">
            {isEnum ? (
              <>
                <div className="text-text-primary mb-4 text-sm font-medium">{displayValue}</div>
                <div className="py-1">
                  <Slider
                    aria-labelledby={labelId}
                    aria-valuetext={displayValue}
                    value={[selectedIndex]}
                    min={0}
                    max={options.length - 1}
                    step={1}
                    onValueChange={([nextIndex]) => emit(options[nextIndex])}
                  />
                </div>
                <div className="text-text-secondary mt-2.5 flex justify-between gap-4 text-xs">
                  <span className="truncate">
                    {translated(setting.enumMappings?.[options[0]] ?? options[0], localize)}
                  </span>
                  <span className="truncate text-right">
                    {translated(
                      setting.enumMappings?.[options[options.length - 1]] ??
                        options[options.length - 1],
                      localize,
                    )}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <div className="bg-surface-primary h-8 w-24 shrink-0 rounded-lg font-medium shadow-xs">
                      <Input
                        type="number"
                        aria-label={label}
                        value={numericValue === '-1' ? '' : numericValue}
                        placeholder={formatTokens(numericMin)}
                        min={numericMin}
                        max={range.max}
                        step={range.step ?? 1}
                        onChange={(event) => setNumericValue(event.target.value)}
                        onBlur={commitNumericValue}
                        className="h-8 w-24 text-right"
                      />
                    </div>
                    <span className="text-text-secondary truncate text-xs">
                      {localize('com_ui_tokens')}
                    </span>
                  </div>
                  {range.min === -1 && (
                    <Button
                      type="button"
                      variant={isAuto ? 'default' : 'ghost'}
                      size="sm"
                      aria-pressed={isAuto}
                      onClick={() => emitNumericValue(-1)}
                      className="h-8 shrink-0"
                    >
                      <span className="text-xs">{localize('com_ui_auto')}</span>
                    </Button>
                  )}
                </div>
                <div className="py-1">
                  <Slider
                    aria-labelledby={labelId}
                    aria-valuetext={
                      isAuto
                        ? localize('com_ui_auto')
                        : `${formatTokens(numericScaleValue)} ${localize('com_ui_tokens')}`
                    }
                    value={[numericScaleValue]}
                    min={numericMin}
                    max={range.max}
                    step={range.step ?? 1}
                    onValueChange={([nextValue]) => emitNumericValue(nextValue)}
                  />
                </div>
                <div className="text-text-secondary mt-2.5 flex justify-between gap-4 text-xs">
                  <span>{formatTokens(numericMin)}</span>
                  <span>{formatTokens(range.max)}</span>
                </div>
              </>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type ComposerReasoningOptions = {
  conversation: TConversation | null;
  index: number;
  hasAddedConversation?: boolean;
  enabled?: boolean;
  blockedReasoningKeys?: ReadonlySet<string>;
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
  const submission = useRecoilValue(store.submissionByIndex(index));
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
  const setting = useMemo(() => {
    const customParams = endpointsConfig[provider]?.customParams ?? {};
    return resolveReasoningSettingForTarget({
      endpoint: endpointType ?? provider,
      model,
      isAgent,
      defaultParamsEndpoint: customParams.defaultParamsEndpoint,
      reasoningFormat: customParams.reasoningFormat,
      paramDefinitions: customParams.paramDefinitions,
      blockedReasoningKeys,
    });
  }, [blockedReasoningKeys, endpointType, endpointsConfig, isAgent, model, provider]);
  const settingFingerprint =
    setting == null
      ? ''
      : `${setting.key}:${setting.type}:${setting.options?.join(',') ?? ''}:${setting.range?.min ?? ''}:${setting.range?.positiveMin ?? ''}:${setting.range?.max ?? ''}:${setting.range?.step ?? ''}`;
  const targetResolved =
    endpoint !== '' &&
    (!isAgent || agentTarget != null) &&
    (setting != null || endpointsQuery.data != null);
  const targetFingerprint = targetResolved
    ? `${isAgent ? conversation?.agent_id : provider}:${model}:${settingFingerprint}`
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
    const mismatchedSetting = setting != null && value?.key !== setting.key;
    if (
      (explicitlyUnavailable || unsupportedResolved || targetChanged || mismatchedSetting) &&
      value != null
    ) {
      setValue(undefined);
    }
  }, [
    explicitlyUnavailable,
    reasoningStateKey,
    setValue,
    setting,
    targetFingerprint,
    targetResolved,
    value,
  ]);

  if (!available || setting == null) {
    return null;
  }

  const configuredValue =
    isAgent && agent != null ? agent.model_parameters?.[setting.key] : conversation?.[setting.key];
  const displayedValue =
    value ??
    reasoningOverrideSchema.safeParse({
      key: setting.key,
      value: configuredValue ?? setting.default,
    }).data;

  return { setting, value: displayedValue, setValue };
}
