import React from 'react';
import { render, screen } from '@testing-library/react';
import { useForm, FormProvider } from 'react-hook-form';
import { EModelEndpoint, mergeFileConfig } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import FileSearch from '../FileSearch';

const mockEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.agents]: { userProvide: false, order: 1 },
  Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
};

let mockFileConfig = mergeFileConfig({ endpoints: { default: { fileLimit: 10 } } });

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetFileConfig: ({ select }: { select?: (d: unknown) => unknown }) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
  }),
  useGetStartupConfig: () => ({ data: { sharePointFilePickerEnabled: false } }),
}));

jest.mock('~/hooks', () => ({
  useAgentFileConfig: jest.requireActual('~/hooks/Agents/useAgentFileConfig').default,
  useLocalize: () => (key: string) => key,
  useLazyEffect: () => {},
}));

const mockUseFileHandlingNoChatContext = jest.fn().mockReturnValue({
  handleFileChange: jest.fn(),
});

jest.mock('~/hooks/Files/useFileHandling', () => ({
  useFileHandlingNoChatContext: (...args: unknown[]) => mockUseFileHandlingNoChatContext(...args),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  useSharePointFileHandlingNoChatContext: () => ({
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
    downloadProgress: 0,
  }),
}));

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: () => null,
}));

jest.mock('~/components/Chat/Input/Files/FileRow', () => () => null);

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children, ...props }: { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@librechat/client', () => ({
  SharePointIcon: () => <span />,
  DropdownPopup: () => null,
  CircleHelpIcon: () => <span />,
  HoverCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function Wrapper({ provider, children }: { provider?: string; children: React.ReactNode }) {
  const methods = useForm<AgentForm>({
    defaultValues: { provider: provider as AgentForm['provider'] },
  });
  return <FormProvider {...methods}>{children}</FormProvider>;
}

describe('FileSearch', () => {
  it('renders upload UI when file uploads are not disabled', () => {
    mockFileConfig = mergeFileConfig({ endpoints: { default: { fileLimit: 10 } } });
    render(
      <Wrapper provider="Moonshot">
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    expect(screen.getByText('com_assistants_file_search')).toBeInTheDocument();
  });

  it('returns null when file config is disabled for provider', () => {
    mockFileConfig = mergeFileConfig({
      endpoints: { Moonshot: { disabled: true }, default: { fileLimit: 10 } },
    });
    const { container } = render(
      <Wrapper provider="Moonshot">
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('returns null when agents endpoint config is disabled and no provider config', () => {
    mockFileConfig = mergeFileConfig({
      endpoints: { [EModelEndpoint.agents]: { disabled: true }, default: { fileLimit: 10 } },
    });
    const { container } = render(
      <Wrapper>
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('passes provider as endpointOverride and resolved type as endpointTypeOverride', () => {
    mockFileConfig = mergeFileConfig({ endpoints: { default: { fileLimit: 10 } } });
    mockUseFileHandlingNoChatContext.mockClear();
    render(
      <Wrapper provider="Moonshot">
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    const params = mockUseFileHandlingNoChatContext.mock.calls[0][0];
    expect(params.endpointOverride).toBe('Moonshot');
    expect(params.endpointTypeOverride).toBe(EModelEndpoint.custom);
  });

  it('falls back to agents for endpointOverride when no provider', () => {
    mockFileConfig = mergeFileConfig({ endpoints: { default: { fileLimit: 10 } } });
    mockUseFileHandlingNoChatContext.mockClear();
    render(
      <Wrapper>
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    const params = mockUseFileHandlingNoChatContext.mock.calls[0][0];
    expect(params.endpointOverride).toBe(EModelEndpoint.agents);
    expect(params.endpointTypeOverride).toBe(EModelEndpoint.agents);
  });

  it('renders when provider has no specific config and agents config is enabled', () => {
    mockFileConfig = mergeFileConfig({
      endpoints: {
        [EModelEndpoint.agents]: { fileLimit: 20 },
        default: { fileLimit: 10 },
      },
    });
    render(
      <Wrapper provider="Moonshot">
        <FileSearch agent_id="agent-1" />
      </Wrapper>,
    );
    expect(screen.getByText('com_assistants_file_search')).toBeInTheDocument();
  });
});
