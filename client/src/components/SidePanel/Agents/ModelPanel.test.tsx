/**
 * @jest-environment jsdom
 */
import React from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { Providers, EModelEndpoint, agentParamSettings } from 'librechat-data-provider';
import type { TStartupConfig } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import ModelPanel from './ModelPanel';

const mockStartupConfig = jest.fn<Partial<TStartupConfig>, []>(() => ({}));

jest.mock('@librechat/client', () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div role="alert">{children}</div>,
  Button: ({ children, onClick, type }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick}>
      {children}
    </button>
  ),
  ControlCombobox: ({
    ariaLabel,
    disabled,
    items,
    selectId,
    selectedValue,
    selectPlaceholder,
    setValue,
  }: {
    ariaLabel: string;
    disabled?: boolean;
    items: Array<{ label: string; value: string }>;
    selectId?: string;
    selectedValue: string;
    selectPlaceholder?: string;
    setValue: (value: string) => void;
  }) => (
    <div>
      <button id={selectId} type="button" disabled={disabled} aria-label={ariaLabel}>
        {selectedValue || selectPlaceholder}
      </button>
      <span data-testid={`${ariaLabel}-selected`}>{selectedValue}</span>
      <span data-testid={`${ariaLabel}-placeholder`}>{selectPlaceholder}</span>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          disabled={disabled}
          data-testid={`${ariaLabel}-${item.value}`}
          onClick={() => setValue(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

jest.mock('~/components/SidePanel/Parameters/components', () => ({
  componentMapping: {},
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | undefined>) => classes.filter(Boolean).join(' '),
}));

function TestForm({
  defaultModel = '',
  defaultModelParameters = {},
  defaultProvider = '',
  formRef,
  models,
  modelsError = false,
  modelsReady,
  providers = [{ label: 'Custom', value: 'custom' }],
}: {
  defaultModel?: string;
  defaultModelParameters?: Partial<AgentForm['model_parameters']>;
  defaultProvider?: string;
  formRef?: React.MutableRefObject<UseFormReturn<AgentForm> | null>;
  models: Record<string, string[]>;
  modelsError?: boolean;
  modelsReady: boolean;
  providers?: Array<{ label: string; value: string }>;
}) {
  const methods = useForm<AgentForm>({
    defaultValues: {
      provider: defaultProvider,
      model: defaultModel,
      model_parameters: defaultModelParameters as AgentForm['model_parameters'],
    },
  });

  if (formRef) {
    formRef.current = methods;
  }

  return (
    <FormProvider {...methods}>
      <ModelPanel
        providers={providers}
        models={models}
        modelsError={modelsError}
        modelsReady={modelsReady}
        setActivePanel={jest.fn()}
      />
    </FormProvider>
  );
}

describe('ModelPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    mockStartupConfig.mockReturnValue({});
  });

  it('disables model selection until the model catalogue is ready', () => {
    const { getByTestId } = render(
      <TestForm
        defaultProvider="custom"
        models={{ custom: ['custom-model'] }}
        modelsReady={false}
      />,
    );

    expect(getByTestId('com_ui_provider-custom')).toBeDisabled();
    expect(getByTestId('com_ui_model-custom-model')).toBeDisabled();
  });

  it('selects and saves the first model when the provider changes', () => {
    const providers = [
      { label: 'Original', value: 'original' },
      { label: 'Alternate', value: 'alternate' },
    ];
    const { getByTestId } = render(
      <TestForm
        defaultProvider="original"
        defaultModel="original-model"
        models={{ original: ['original-model'], alternate: ['alternate-model'] }}
        modelsReady={true}
        providers={providers}
      />,
    );

    fireEvent.click(getByTestId('com_ui_provider-alternate'));

    expect(getByTestId('com_ui_model-selected')).toHaveTextContent('alternate-model');
    expect(localStorage.getItem('lastAgentProvider')).toBe('alternate');
    expect(localStorage.getItem('lastAgentModel')).toBe('alternate-model');
  });

  it('selects the Google catalog for a Vertex AI provider', () => {
    const providers = [
      { label: 'Original', value: 'original' },
      { label: 'Vertex AI', value: Providers.VERTEXAI },
    ];
    const { getByTestId } = render(
      <TestForm
        defaultProvider="original"
        defaultModel="original-model"
        models={{ original: ['original-model'], google: ['gemini-3.7-flash'] }}
        modelsReady={true}
        providers={providers}
      />,
    );

    fireEvent.click(getByTestId(`com_ui_provider-${Providers.VERTEXAI}`));

    expect(getByTestId('com_ui_model-selected')).toHaveTextContent('gemini-3.7-flash');
    expect(localStorage.getItem('lastAgentProvider')).toBe(Providers.VERTEXAI);
    expect(localStorage.getItem('lastAgentModel')).toBe('gemini-3.7-flash');
  });

  it('selects an exact Vertex AI catalog when configured', () => {
    const providers = [
      { label: 'Original', value: 'original' },
      { label: 'Vertex AI', value: Providers.VERTEXAI },
    ];
    const { getByTestId } = render(
      <TestForm
        defaultProvider="original"
        defaultModel="original-model"
        models={{
          original: ['original-model'],
          google: ['gemini-3.7-flash'],
          [Providers.VERTEXAI]: ['custom-vertex-model'],
        }}
        modelsReady={true}
        providers={providers}
      />,
    );

    fireEvent.click(getByTestId(`com_ui_provider-${Providers.VERTEXAI}`));

    expect(getByTestId('com_ui_model-selected')).toHaveTextContent('custom-vertex-model');
    expect(localStorage.getItem('lastAgentProvider')).toBe(Providers.VERTEXAI);
    expect(localStorage.getItem('lastAgentModel')).toBe('custom-vertex-model');
  });

  it('preserves the model when the current provider is selected again', () => {
    const { getByTestId } = render(
      <TestForm
        defaultProvider="custom"
        defaultModel="second-model"
        models={{ custom: ['first-model', 'second-model'] }}
        modelsReady={true}
      />,
    );

    fireEvent.click(getByTestId('com_ui_provider-custom'));

    expect(getByTestId('com_ui_model-selected')).toHaveTextContent('second-model');
  });

  it('saves an explicitly selected model', () => {
    const { getByTestId } = render(
      <TestForm
        defaultProvider="custom"
        defaultModel="first-model"
        models={{ custom: ['first-model', 'second-model'] }}
        modelsReady={true}
      />,
    );

    fireEvent.click(getByTestId('com_ui_model-second-model'));

    expect(localStorage.getItem('lastAgentProvider')).toBe('custom');
    expect(localStorage.getItem('lastAgentModel')).toBe('second-model');
  });

  it('announces the pending catalogue instead of inviting a selection', () => {
    const { getByTestId } = render(
      <TestForm defaultProvider="custom" models={{}} modelsReady={false} />,
    );

    expect(getByTestId('com_ui_model-placeholder')).toHaveTextContent('com_ui_loading');
  });

  it('offers no models and explains the failure when the catalogue cannot be loaded', () => {
    const { getByRole, getByTestId, queryByTestId } = render(
      <TestForm defaultProvider="custom" models={{}} modelsError={true} modelsReady={true} />,
    );

    expect(getByRole('alert')).toHaveTextContent('com_error_models_not_loaded');
    expect(queryByTestId('com_ui_model-placeholder')).toHaveTextContent('com_ui_select_model');
    expect(getByTestId('com_ui_provider-custom')).toBeDisabled();
  });

  it('labels the provider and model controls', () => {
    const { container } = render(
      <TestForm
        defaultProvider="custom"
        models={{ custom: ['custom-model'] }}
        modelsReady={true}
      />,
    );

    expect(container.querySelector('label[for="provider"]')).not.toBeNull();
    expect(container.querySelector('label[for="model"]')).not.toBeNull();
    expect(container.querySelector('#provider')).not.toBeNull();
    expect(container.querySelector('#model')).not.toBeNull();
  });

  it.each([
    [EModelEndpoint.anthropic, 'claude-opus-5'],
    [EModelEndpoint.bedrock, 'global.anthropic.claude-opus-5'],
  ])(
    'preserves saved %s settings through model switches and a restored form',
    (provider, previousModel) => {
      const saved = {
        thinking: false,
        thinkingBudget: 4096,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
      };
      const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
      const renderForm = (model: string, parameters = saved) => (
        <TestForm
          defaultProvider={provider}
          defaultModel={model}
          defaultModelParameters={parameters}
          formRef={formRef}
          models={{ [provider]: [previousModel, `${previousModel}-5`] }}
          modelsReady={true}
        />
      );
      const { getByTestId, unmount } = render(renderForm(previousModel));
      fireEvent.click(getByTestId(`com_ui_model-${previousModel}-5`));
      expect(formRef.current?.getValues('model_parameters')).toEqual(saved);
      fireEvent.click(getByTestId(`com_ui_model-${previousModel}`));
      expect(formRef.current?.getValues('model_parameters')).toEqual(saved);
      fireEvent.click(getByTestId(`com_ui_model-${previousModel}-5`));
      const restored = JSON.parse(JSON.stringify(formRef.current?.getValues('model_parameters')));
      unmount();
      render(renderForm(`${previousModel}-5`, restored));
      expect(formRef.current?.getValues('model_parameters')).toEqual(saved);
    },
  );

  it('prunes a saved model_parameters value once its endpoint drops the matching param', async () => {
    mockStartupConfig.mockReturnValue({
      endpointsDropParamsMap: { [EModelEndpoint.openAI]: ['topP'] },
    });

    const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
    render(
      <TestForm
        defaultProvider={EModelEndpoint.openAI}
        defaultModel="gpt-4o"
        defaultModelParameters={{ model: 'deployment-override', temperature: 0.5, top_p: 0.9 }}
        formRef={formRef}
        models={{ [EModelEndpoint.openAI]: ['gpt-4o'] }}
        modelsReady={true}
      />,
    );

    await waitFor(() => {
      expect(formRef.current?.getValues('model_parameters')).toEqual({
        model: 'deployment-override',
        temperature: 0.5,
      });
    });
  });

  it('keeps a saved model_parameters value while its control is still visible', () => {
    const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
    render(
      <TestForm
        defaultProvider={EModelEndpoint.openAI}
        defaultModel="gpt-4o"
        defaultModelParameters={{ temperature: 0.5, top_p: 0.9 }}
        formRef={formRef}
        models={{ [EModelEndpoint.openAI]: ['gpt-4o'] }}
        modelsReady={true}
      />,
    );

    expect(formRef.current?.getValues('model_parameters')).toEqual({
      temperature: 0.5,
      top_p: 0.9,
    });
  });

  it('keeps saved model_parameters when the provider has no known parameter settings', () => {
    const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
    render(
      <TestForm
        defaultProvider="removed-provider"
        defaultModel="removed-model"
        defaultModelParameters={{ temperature: 0.5, top_p: 0.9 }}
        formRef={formRef}
        models={{ 'removed-provider': ['removed-model'] }}
        modelsReady={true}
      />,
    );

    expect(formRef.current?.getValues('model_parameters')).toEqual({
      temperature: 0.5,
      top_p: 0.9,
    });
  });

  it('prunes saved model_parameters when every known setting is dropped', async () => {
    mockStartupConfig.mockReturnValue({
      endpointsDropParamsMap: {
        [EModelEndpoint.openAI]: (agentParamSettings[EModelEndpoint.openAI] ?? []).map(
          ({ key }) => key,
        ),
      },
    });

    const formRef: React.MutableRefObject<UseFormReturn<AgentForm> | null> = { current: null };
    render(
      <TestForm
        defaultProvider={EModelEndpoint.openAI}
        defaultModel="gpt-4o"
        defaultModelParameters={{ temperature: 0.5, top_p: 0.9 }}
        formRef={formRef}
        models={{ [EModelEndpoint.openAI]: ['gpt-4o'] }}
        modelsReady={true}
      />,
    );

    await waitFor(() => {
      expect(formRef.current?.getValues('model_parameters')).toEqual({});
    });
  });
});
