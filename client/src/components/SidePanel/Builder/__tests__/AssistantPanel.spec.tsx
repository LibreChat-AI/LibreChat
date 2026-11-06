import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AssistantPanel from '../AssistantPanel';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSelectAssistant: () => ({ onSelect: jest.fn() }),
  useLocalStorage: () => [{ azureAssistants: 'saved' }],
}));
jest.mock('~/Providers', () => ({ useAssistantsMapContext: () => ({}) }));
jest.mock('~/data-provider', () => ({
  useCreateAssistantMutation: () => ({ mutate: jest.fn() }),
  useUpdateAssistantMutation: () => ({ mutate: jest.fn() }),
  useAvailableAgentToolsQuery: () => ({ data: [] }),
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => null,
  useToastContext: () => ({ showToast: jest.fn() }),
  Dropdown: ({
    value,
    disabled,
    options,
  }: {
    value: string;
    disabled: boolean;
    options: string[];
  }) => (
    <button disabled={disabled} data-testid="models" data-options={options.join(',')}>
      {value}
    </button>
  ),
}));
jest.mock('../AssistantSelect', () => () => null);
jest.mock('../AssistantAvatar', () => () => null);
jest.mock('../AppendDateCheckbox', () => () => null);
jest.mock('../AssistantConversationStarters', () => () => null);
jest.mock('../CapabilitiesForm', () => () => null);
jest.mock('../ContextButton', () => () => null);
jest.mock('../AssistantTool', () => () => null);
jest.mock('../Knowledge', () => () => null);
jest.mock('../Action', () => () => null);
jest.mock('~/components/Tools/AssistantToolsDialog', () => () => null);

it('ignores the starter list on failure and keeps fetched Azure models after a failed refresh', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <AssistantPanel
        endpoint={EModelEndpoint.azureAssistants}
        version={2}
        documentsMap={null}
        setAction={jest.fn()}
        setActivePanel={jest.fn()}
        setCurrentAssistantId={jest.fn()}
      />
    </QueryClientProvider>,
  );
  const failFetch = async () => {
    await act(async () => {
      await expect(
        client.fetchQuery({
          queryKey: [QueryKeys.models],
          staleTime: 0,
          queryFn: async () => {
            throw new Error('offline');
          },
        }),
      ).rejects.toThrow('offline');
    });
  };
  try {
    expect(screen.getByTestId('models')).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await failFetch();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => {
      client.setQueryData([QueryKeys.models], { azureAssistants: ['saved'] });
    });
    expect(screen.getByTestId('models')).toHaveTextContent('saved');
    expect(screen.getByTestId('models')).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await failFetch();
    expect(screen.getByTestId('models')).toHaveTextContent('saved');
    expect(screen.getByTestId('models')).toHaveAttribute('data-options', 'saved');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => {
      client.setQueryData([QueryKeys.models], { azureAssistants: [] });
    });
    expect(await screen.findByRole('status')).toHaveTextContent('com_ui_no_models_available');
  } finally {
    unmount();
    client.clear();
  }
});
