import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { Constants, ReasoningEffort } from 'librechat-data-provider';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type {
  SettingDefinition,
  TConversation,
  TReasoningOverride,
  TSubmission,
  TReasoningCapabilityMap,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { getReasoningStateKey, pendingReasoningOverrideFamily } from '../Composer/state';
import { ReasoningControl, useComposerReasoning } from '../Reasoning';
import store from '~/store';

type MockEndpointConfig = {
  type?: string;
  customParams?: {
    defaultParamsEndpoint?: string;
    paramDefinitions?: SettingDefinition[];
  };
};
let mockEndpointsConfig: Record<string, MockEndpointConfig> | undefined = {};
let mockCapabilities: TReasoningCapabilityMap | undefined;
let mockCapabilitiesLoading = false;

jest.mock('~/data-provider', () => ({
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useReasoningCapabilitiesQuery: (_endpoint: string, config?: { enabled?: boolean }) => ({
    data:
      config?.enabled === false || mockCapabilities == null
        ? undefined
        : { capabilities: mockCapabilities, expiresInMs: 3_600_000 },
    isInitialLoading: config?.enabled !== false && mockCapabilitiesLoading,
  }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

beforeEach(() => {
  mockEndpointsConfig = {};
  mockCapabilities = undefined;
  mockCapabilitiesLoading = false;
});

const enumSetting: SettingDefinition = {
  key: 'reasoning_effort',
  label: 'com_endpoint_reasoning_effort',
  labelCode: true,
  description: 'com_endpoint_openai_reasoning_effort',
  descriptionCode: true,
  type: 'enum',
  component: 'slider',
  default: ReasoningEffort.unset,
  options: [
    ReasoningEffort.unset,
    ReasoningEffort.minimal,
    ReasoningEffort.low,
    ReasoningEffort.medium,
    ReasoningEffort.high,
  ],
  enumMappings: {
    [ReasoningEffort.unset]: 'com_ui_auto',
    [ReasoningEffort.minimal]: 'com_ui_minimal',
    [ReasoningEffort.low]: 'com_ui_low',
    [ReasoningEffort.medium]: 'com_ui_medium',
    [ReasoningEffort.high]: 'com_ui_high',
  },
};

const budgetSetting: SettingDefinition = {
  key: 'thinkingBudget',
  label: 'com_endpoint_thinking_budget',
  labelCode: true,
  description: 'com_endpoint_google_thinking_budget',
  descriptionCode: true,
  type: 'number',
  component: 'input',
  range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
};

describe('ReasoningControl', () => {
  it('renders a compact, localized disclosure for the next message', async () => {
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: 'medium' } as TReasoningOverride}
        onChange={jest.fn()}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'com_ui_reasoning_for_next_message com_ui_medium',
    });

    fireEvent.click(trigger);
    expect(
      await screen.findByRole('dialog', { name: 'com_endpoint_reasoning_effort' }),
    ).toBeVisible();
    expect(screen.queryByText('com_endpoint_openai_reasoning_effort')).not.toBeInTheDocument();
  });

  it('stages the next vendor-native enum value from an accessible effort scale', async () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: 'medium' } as TReasoningOverride}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const slider = screen.getByRole('slider', { name: 'com_endpoint_reasoning_effort' });
    expect(slider).toHaveAttribute('aria-valuenow', '3');
    expect(slider).toHaveAttribute('aria-valuetext', 'com_ui_medium');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({ key: 'reasoning_effort', value: 'high' }),
    );
  });

  it('renders a modal dialog with an explicit close control', () => {
    render(
      <ReasoningControl
        index={0}
        setting={enumSetting}
        value={{ key: 'reasoning_effort', value: 'medium' } as TReasoningOverride}
        onChange={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const dialog = screen.getByRole('dialog', { name: 'com_endpoint_reasoning_effort' });

    expect(dialog).toBeVisible();
    expect(screen.getByRole('button', { name: 'com_ui_close' })).toBeVisible();
  });

  it('normalizes numeric thinking budgets onto the same scale with exact input and auto', () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={{ key: 'thinkingBudget', value: 4096 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const slider = screen.getByRole('slider', { name: 'com_endpoint_thinking_budget' });
    expect(slider).toHaveAttribute('aria-valuemin', '128');
    expect(slider).toHaveAttribute('aria-valuemax', '32768');
    expect(slider).toHaveAttribute('aria-valuenow', '4096');

    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 4224 });

    const input = screen.getByRole('spinbutton', { name: 'com_endpoint_thinking_budget' });
    fireEvent.change(input, { target: { value: '8192' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 8192 });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_auto' }));
    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: -1 });
  });

  it('clamps an invalid positive budget to the model-specific floor', () => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={{ key: 'thinkingBudget', value: -1 }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const input = screen.getByRole('spinbutton', { name: 'com_endpoint_thinking_budget' });
    fireEvent.change(input, { target: { value: '16' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 128 });
  });

  it.each([undefined, -1, 4096])('does not stage an unchanged numeric budget (%s)', (value) => {
    const onChange = jest.fn();
    render(
      <ReasoningControl
        index={0}
        setting={budgetSetting}
        value={value == null ? undefined : { key: 'thinkingBudget', value }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const input = screen.getByRole('spinbutton', { name: 'com_endpoint_thinking_budget' });
    fireEvent.focus(input);
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([-1, 0])(
    'restores the supported minimum (%s) when the numeric field is cleared',
    (min) => {
      const onChange = jest.fn();
      render(
        <ReasoningControl
          index={0}
          setting={{ ...budgetSetting, range: { ...budgetSetting.range!, min } }}
          value={{ key: 'thinkingBudget', value: 4096 }}
          onChange={onChange}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
      const input = screen.getByRole('spinbutton', { name: 'com_endpoint_thinking_budget' });
      fireEvent.change(input, { target: { value: '' } });
      fireEvent.blur(input);

      expect(onChange).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: min });
    },
  );
});

describe('useComposerReasoning', () => {
  it('owns one-shot state in Jotai and clears it when the model changes', async () => {
    const reasoningStore = createStore();
    const conversation = {
      conversationId: 'reasoning-conversation',
      endpoint: 'openAI',
      model: 'gpt-5',
      reasoning_effort: ReasoningEffort.medium,
    } as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      ({
        activeConversation,
        enabled,
        hasAddedConversation,
      }: {
        activeConversation: TConversation;
        enabled: boolean;
        hasAddedConversation: boolean;
      }) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 0,
          hasAddedConversation,
          enabled,
        }),
      {
        initialProps: {
          activeConversation: conversation,
          enabled: true,
          hasAddedConversation: false,
        },
        wrapper,
      },
    );

    expect(rendered.result.current?.setting.key).toBe('reasoning_effort');
    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });
    expect(reasoningStore.get(pendingReasoningOverrideFamily('reasoning-conversation'))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
    expect(conversation.reasoning_effort).toBe(ReasoningEffort.medium);

    rendered.rerender({
      activeConversation: { ...conversation, model: 'gpt-5-mini' },
      enabled: true,
      hasAddedConversation: false,
    });
    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('reasoning-conversation')),
      ).toBeUndefined(),
    );

    rendered.rerender({
      activeConversation: conversation,
      enabled: true,
      hasAddedConversation: false,
    });
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });
    expect(reasoningStore.get(pendingReasoningOverrideFamily('reasoning-conversation'))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
    rendered.rerender({
      activeConversation: conversation,
      enabled: false,
      hasAddedConversation: false,
    });
    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('reasoning-conversation')),
      ).toBeUndefined(),
    );

    rendered.rerender({
      activeConversation: conversation,
      enabled: true,
      hasAddedConversation: false,
    });
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });
    rendered.rerender({
      activeConversation: conversation,
      enabled: true,
      hasAddedConversation: true,
    });
    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('reasoning-conversation')),
      ).toBeUndefined(),
    );
  });
  it('keeps a staged selection when the user returns from a conversation on another model', async () => {
    const reasoningStore = createStore();
    const staged = { key: 'reasoning_effort' as const, value: ReasoningEffort.high };
    const first = {
      conversationId: 'staged-conversation',
      endpoint: 'openAI',
      model: 'gpt-5',
    } as TConversation;
    const second = {
      conversationId: 'other-conversation',
      endpoint: 'openAI',
      model: 'gpt-5-mini',
    } as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      ({ activeConversation }: { activeConversation: TConversation }) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { initialProps: { activeConversation: first }, wrapper },
    );

    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    act(() => {
      rendered.result.current?.setValue(staged);
    });

    rendered.rerender({ activeConversation: second });
    await waitFor(() => expect(rendered.result.current?.setting.key).toBe('reasoning_effort'));
    rendered.rerender({ activeConversation: first });
    await waitFor(() => expect(rendered.result.current).not.toBeNull());
    expect(reasoningStore.get(pendingReasoningOverrideFamily('staged-conversation'))).toEqual(
      staged,
    );
  });

  it('resolves the control for an ephemeral agent from its encoded target', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={createStore()}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      ({ agentId }: { agentId: string }) =>
        useComposerReasoning({
          conversation: {
            conversationId: 'ephemeral-agent-conversation',
            endpoint: 'agents',
            agent_id: agentId,
          } as TConversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { initialProps: { agentId: 'openAI__gpt-5___GPT-5' }, wrapper },
    );

    await waitFor(() => expect(rendered.result.current?.setting.key).toBe('reasoning_effort'));

    rendered.rerender({ agentId: 'agent_not_loaded_yet' });
    await waitFor(() => expect(rendered.result.current).toBeNull());
  });

  it('keeps secondary-pane reasoning selection isolated and clears it on target changes', async () => {
    const reasoningStore = createStore();
    const conversation = {
      conversationId: Constants.NEW_CONVO,
      endpoint: 'openAI',
      model: 'gpt-5',
      reasoning_effort: ReasoningEffort.medium,
    } as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    type ReasoningProps = { activeConversation: TConversation };
    const primary = renderHook(
      ({ activeConversation }: ReasoningProps) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      {
        initialProps: { activeConversation: conversation },
        wrapper,
      },
    );
    const secondary = renderHook(
      ({ activeConversation }: ReasoningProps) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 1,
          hasAddedConversation: false,
          enabled: true,
        }),
      {
        initialProps: { activeConversation: conversation },
        wrapper,
      },
    );
    const primaryKey = getReasoningStateKey(Constants.NEW_CONVO, 0);
    const secondaryKey = getReasoningStateKey(Constants.NEW_CONVO, 1);

    expect(primary.result.current).not.toBeNull();
    expect(secondary.result.current).not.toBeNull();
    act(() => {
      primary.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
      secondary.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.low,
      });
    });
    expect(reasoningStore.get(pendingReasoningOverrideFamily(primaryKey))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
    expect(reasoningStore.get(pendingReasoningOverrideFamily(secondaryKey))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.low,
    });

    secondary.rerender({
      activeConversation: { ...conversation, model: 'gpt-5-mini' },
    });
    await waitFor(() =>
      expect(reasoningStore.get(pendingReasoningOverrideFamily(secondaryKey))).toBeUndefined(),
    );
    expect(reasoningStore.get(pendingReasoningOverrideFamily(primaryKey))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
  });

  /* The window between the first submit and the `created`/`sync` event: the
     selection for the next turn is written under the placeholder key, and the
     durable id arrives afterwards. */
  it('carries a selection made before the id resolves onto the saved conversation', async () => {
    const reasoningStore = createStore();
    const conversation = {
      conversationId: Constants.NEW_CONVO,
      endpoint: 'openAI',
      model: 'gpt-5',
      reasoning_effort: ReasoningEffort.medium,
    } as TConversation;
    const submission = {
      conversation: { conversationId: Constants.NEW_CONVO },
      userMessage: { conversationId: Constants.NEW_CONVO },
    } as TSubmission;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot
        initializeState={(snapshot) => snapshot.set(store.submissionByIndex(0), submission)}
      >
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      ({ activeConversation }: { activeConversation: TConversation }) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { initialProps: { activeConversation: conversation }, wrapper },
    );
    const placeholderKey = getReasoningStateKey(Constants.NEW_CONVO, 0);

    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });
    expect(reasoningStore.get(pendingReasoningOverrideFamily(placeholderKey))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });

    rendered.rerender({
      activeConversation: { ...conversation, conversationId: 'settled-conversation' },
    });

    await waitFor(() =>
      expect(reasoningStore.get(pendingReasoningOverrideFamily('settled-conversation'))).toEqual({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      }),
    );
    expect(rendered.result.current?.value).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
    /* Left behind, the placeholder value would leak into the next new chat in
       this pane. */
    expect(reasoningStore.get(pendingReasoningOverrideFamily(placeholderKey))).toBeUndefined();
  });

  it('does not carry a new-chat selection into an unrelated conversation', async () => {
    const reasoningStore = createStore();
    const conversation = {
      conversationId: Constants.NEW_CONVO,
      endpoint: 'openAI',
      model: 'gpt-5',
      reasoning_effort: ReasoningEffort.medium,
    } as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      ({ activeConversation }: { activeConversation: TConversation }) =>
        useComposerReasoning({
          conversation: activeConversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { initialProps: { activeConversation: conversation }, wrapper },
    );
    const placeholderKey = getReasoningStateKey(Constants.NEW_CONVO, 0);

    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });

    rendered.rerender({
      activeConversation: { ...conversation, conversationId: 'unrelated-conversation' },
    });

    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('unrelated-conversation')),
      ).toBeUndefined(),
    );
    expect(reasoningStore.get(pendingReasoningOverrideFamily(placeholderKey))).toEqual({
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
  });

  it('merges custom definitions and clears values removed by a capability change', async () => {
    mockEndpointsConfig = {
      custom: {
        type: 'openAI',
        customParams: {
          defaultParamsEndpoint: 'openAI',
          paramDefinitions: [
            { key: 'reasoning_effort', default: ReasoningEffort.high } as SettingDefinition,
          ],
        },
      },
    };
    const reasoningStore = createStore();
    const conversation = {
      conversationId: 'custom-reasoning-conversation',
      endpoint: 'custom',
      model: 'gpt-5',
    } as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      () =>
        useComposerReasoning({
          conversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { wrapper },
    );

    expect(rendered.result.current?.setting.default).toBe(ReasoningEffort.high);
    expect(rendered.result.current?.setting.options).toContain(ReasoningEffort.low);
    act(() => {
      rendered.result.current?.setValue({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      });
    });

    mockEndpointsConfig = {
      custom: {
        type: 'openAI',
        customParams: {
          defaultParamsEndpoint: 'openAI',
          paramDefinitions: [
            {
              key: 'reasoning_effort',
              options: [ReasoningEffort.low],
            } as SettingDefinition,
          ],
        },
      },
    };
    rendered.rerender();

    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('custom-reasoning-conversation')),
      ).toBeUndefined(),
    );
  });

  it('exposes the declared effort control for the mock custom endpoint', () => {
    mockEndpointsConfig = {
      'Mock Provider A': {
        type: 'custom',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
          paramDefinitions: [{ key: 'effort' } as SettingDefinition],
        },
      },
    };
    const reasoningStore = createStore();
    /* A named custom endpoint: the label is not an `EModelEndpoint` member, which
       is exactly the shape this case is about. */
    const conversation = {
      conversationId: 'mock-provider-conversation',
      endpoint: 'Mock Provider A',
      endpointType: 'custom',
      model: 'mock-model-a',
    } as unknown as TConversation;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );

    const rendered = renderHook(
      () =>
        useComposerReasoning({
          conversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { wrapper },
    );

    expect(rendered.result.current?.setting).toMatchObject({
      key: 'effort',
      options: expect.arrayContaining(['low', 'high']),
    });
  });

  it('preserves restored reasoning while custom endpoint capabilities are loading', async () => {
    mockEndpointsConfig = undefined;
    const reasoningStore = createStore();
    const conversation = {
      conversationId: 'loading-reasoning-conversation',
      endpoint: 'custom',
      model: 'gpt-5',
    } as TConversation;
    reasoningStore.set(pendingReasoningOverrideFamily('loading-reasoning-conversation'), {
      key: 'reasoning_effort',
      value: ReasoningEffort.high,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      () =>
        useComposerReasoning({
          conversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { wrapper },
    );

    expect(rendered.result.current).toBeNull();
    expect(
      reasoningStore.get(pendingReasoningOverrideFamily('loading-reasoning-conversation')),
    ).toEqual({ key: 'reasoning_effort', value: ReasoningEffort.high });

    mockEndpointsConfig = {
      custom: {
        type: 'openAI',
        customParams: { defaultParamsEndpoint: 'openAI' },
      },
    };
    rendered.rerender();

    await waitFor(() =>
      expect(rendered.result.current?.value).toEqual({
        key: 'reasoning_effort',
        value: ReasoningEffort.high,
      }),
    );
    expect(
      reasoningStore.get(pendingReasoningOverrideFamily('loading-reasoning-conversation')),
    ).toEqual({ key: 'reasoning_effort', value: ReasoningEffort.high });
  });

  it('clears a restored override whose value the current setting no longer offers', async () => {
    mockEndpointsConfig = {
      custom: {
        type: 'openAI',
        customParams: { defaultParamsEndpoint: 'openAI' },
      },
    };
    const reasoningStore = createStore();
    const conversation = {
      conversationId: 'stale-reasoning-conversation',
      endpoint: 'custom',
      model: 'gpt-5',
    } as TConversation;
    reasoningStore.set(pendingReasoningOverrideFamily('stale-reasoning-conversation'), {
      key: 'reasoning_effort',
      value: 'retired-effort' as ReasoningEffort,
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={reasoningStore}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      () =>
        useComposerReasoning({
          conversation,
          index: 0,
          hasAddedConversation: false,
          enabled: true,
        }),
      { wrapper },
    );

    await waitFor(() =>
      expect(
        reasoningStore.get(pendingReasoningOverrideFamily('stale-reasoning-conversation')),
      ).toBeUndefined(),
    );
    expect(rendered.result.current?.setting.key).toBe('reasoning_effort');
  });
});

describe('useComposerReasoning: OpenRouter per-model efforts', () => {
  const model = 'openai/gpt-6.1-sol';
  const conversation = {
    title: null,
    conversationId: 'openrouter-conversation',
    endpoint: 'OpenRouter',
    endpointType: 'custom',
    model,
    createdAt: '',
    updatedAt: '',
  } as unknown as TConversation;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot>
      <JotaiProvider store={createStore()}>{children}</JotaiProvider>
    </RecoilRoot>
  );
  const render = () =>
    renderHook(() => useComposerReasoning({ conversation, index: 0, enabled: true }), { wrapper });

  beforeEach(() => {
    mockEndpointsConfig = {
      OpenRouter: {
        type: 'custom',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          reasoningFormat: 'reasoning_effort',
        },
      } as MockEndpointConfig,
    };
  });

  it('offers no control while the capabilities are still loading', () => {
    mockCapabilitiesLoading = true;

    expect(render().result.current).toBeNull();
  });

  it('keeps an administrator-defined effort control while the capabilities load', () => {
    mockCapabilitiesLoading = true;
    mockEndpointsConfig = {
      OpenRouter: {
        type: 'custom',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          paramDefinitions: [enumSetting],
        },
      },
    };

    expect(render().result.current?.setting.key).toBe('reasoning_effort');
  });

  it('offers no control when the capabilities could not be read', () => {
    mockCapabilities = undefined;
    mockCapabilitiesLoading = false;

    expect(render().result.current).toBeNull();
  });

  it('offers only the efforts the selected model supports', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };

    expect(render().result.current?.setting.options).toEqual([
      ReasoningEffort.unset,
      ReasoningEffort.low,
      ReasoningEffort.high,
    ]);
  });

  it('hides the control for a model the provider lists without reasoning', () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: [] } } };

    expect(render().result.current).toBeNull();
  });

  it('keeps the generic efforts for a model the catalog does not list', () => {
    mockCapabilities = { OpenRouter: { 'meta/other': { efforts: ['low'] } } };

    expect(render().result.current?.setting.options).toContain(ReasoningEffort.max);
  });
});

describe('useComposerReasoning: restored override while OpenRouter capabilities load', () => {
  const model = 'openai/gpt-6.1-sol';
  const conversation = {
    title: null,
    conversationId: 'restored-conversation',
    endpoint: 'OpenRouter',
    endpointType: 'custom',
    model,
    createdAt: '',
    updatedAt: '',
  } as unknown as TConversation;
  const staged = { key: 'reasoning_effort', value: ReasoningEffort.low } as TReasoningOverride;
  const stagedValue = (store: ReturnType<typeof createStore>) =>
    store.get(pendingReasoningOverrideFamily('restored-conversation'));
  const setup = () => {
    const store = createStore();
    store.set(pendingReasoningOverrideFamily('restored-conversation'), staged);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={store}>{children}</JotaiProvider>
      </RecoilRoot>
    );
    const rendered = renderHook(
      () => useComposerReasoning({ conversation, index: 0, enabled: true }),
      { wrapper },
    );
    return { store, rendered };
  };

  beforeEach(() => {
    mockEndpointsConfig = {
      OpenRouter: {
        type: 'custom',
        customParams: {
          defaultParamsEndpoint: 'openrouter',
          reasoningFormat: 'reasoning_effort',
        },
      } as MockEndpointConfig,
    };
  });

  it('keeps a staged override while the capabilities are loading', async () => {
    mockCapabilitiesLoading = true;

    const { store } = setup();
    await act(async () => {});

    expect(stagedValue(store)).toEqual(staged);
  });

  it('keeps a staged override while the capabilities request has failed', async () => {
    mockCapabilities = undefined;
    mockCapabilitiesLoading = false;

    const { store } = setup();
    await act(async () => {});

    expect(stagedValue(store)).toEqual(staged);
  });

  it('keeps it once the loaded capabilities confirm it', async () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };

    const { store } = setup();
    await act(async () => {});

    expect(stagedValue(store)).toEqual(staged);
  });

  it('keeps a supported override across the loading to loaded transition', async () => {
    mockCapabilitiesLoading = true;
    const { store, rendered } = setup();
    await act(async () => {});
    expect(stagedValue(store)).toEqual(staged);

    mockCapabilitiesLoading = false;
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };
    rendered.rerender();
    await act(async () => {});

    expect(rendered.result.current?.setting.options).toEqual(['', 'low', 'high']);
    expect(stagedValue(store)).toEqual(staged);
  });

  it('keeps a supported override when a refresh changes the other advertised efforts', async () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'high'] } } };
    const { store, rendered } = setup();
    await act(async () => {});
    expect(stagedValue(store)).toEqual(staged);

    mockCapabilities = { OpenRouter: { [model]: { efforts: ['low', 'medium', 'high'] } } };
    rendered.rerender();
    await act(async () => {});

    expect(rendered.result.current?.setting.options).toEqual(['', 'low', 'medium', 'high']);
    expect(stagedValue(store)).toEqual(staged);
  });

  it('clears it only after the loaded capabilities prove it unsupported', async () => {
    mockCapabilities = { OpenRouter: { [model]: { efforts: ['high'] } } };

    const { store } = setup();

    await waitFor(() => expect(stagedValue(store)).toBeUndefined());
  });
});
