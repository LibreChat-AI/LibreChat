import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, mergeFileConfig } from 'librechat-data-provider';
import type { TEndpointsConfig, Agent } from 'librechat-data-provider';
import AttachFileChat from '../AttachFileChat';

const mockEndpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.openAI]: { userProvide: false, order: 0 },
  [EModelEndpoint.agents]: { userProvide: false, order: 1 },
  [EModelEndpoint.assistants]: { userProvide: false, order: 2 },
  Moonshot: { type: EModelEndpoint.custom, userProvide: false, order: 9999 },
};

const defaultFileConfig = mergeFileConfig({
  endpoints: {
    Moonshot: { fileLimit: 5 },
    [EModelEndpoint.agents]: { fileLimit: 20 },
    default: { fileLimit: 10 },
  },
});

let mockFileConfig = defaultFileConfig;

let mockAgentsMap: Record<string, Partial<Agent>> = {};
let mockAgentQueryData: Partial<Agent> | undefined;
let mockFileConfigLoaded = true;

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: mockEndpointsConfig }),
  useGetFileConfig: ({ select }: { select?: (data: unknown) => unknown }) => ({
    data: select != null ? select(mockFileConfig) : mockFileConfig,
    isSuccess: mockFileConfigLoaded,
  }),
  useGetAgentByIdQuery: () => ({ data: mockAgentQueryData }),
}));

jest.mock('~/Providers', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

/* The shared upload-target hook reads the module directly rather than the barrel, so
 * the barrel mock alone leaves it with no agents map. */
jest.mock('~/Providers/AgentsMapContext', () => ({
  useAgentsMapContext: () => mockAgentsMap,
}));

/** Capture the props passed to AttachFileMenu */
let mockAttachFileMenuProps: Record<string, unknown> = {};
jest.mock('../AttachFileMenu', () => {
  return function MockAttachFileMenu(props: Record<string, unknown>) {
    mockAttachFileMenuProps = props;
    return <div data-testid="attach-file-menu" data-endpoint-type={String(props.endpointType)} />;
  };
});

jest.mock('../AttachFile', () => {
  return function MockAttachFile() {
    return <div data-testid="attach-file" />;
  };
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderComponent(conversation: Record<string, unknown> | null, disableInputs = false) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileChat
          conversation={conversation as never}
          disableInputs={disableInputs}
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('AttachFileChat', () => {
  beforeEach(() => {
    mockFileConfig = defaultFileConfig;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;
    mockAttachFileMenuProps = {};
    mockFileConfigLoaded = true;
  });

  describe('rendering decisions', () => {
    it('renders AttachFileMenu for agents endpoint', () => {
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders AttachFileMenu for custom endpoint with file support', () => {
      renderComponent({ endpoint: 'Moonshot' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders null for null conversation', () => {
      const { container } = renderComponent(null);
      expect(container.innerHTML).toBe('');
    });
  });

  describe('endpointType resolution for agents', () => {
    it('passes custom endpointType when agent provider is a custom endpoint', () => {
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('passes openAI endpointType when agent provider is openAI', () => {
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.openAI);
    });

    it('passes agents endpointType when no agent provider', () => {
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.agents);
    });

    it('passes agents endpointType when no agent_id', () => {
      renderComponent({ endpoint: EModelEndpoint.agents });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.agents);
    });

    it('uses agentData query when agent not in agentsMap', () => {
      mockAgentQueryData = { provider: 'Moonshot' } as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-2' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('falls back to agentsMap provider when fetched agent omits provider', () => {
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } as Partial<Agent>,
      };
      mockAgentQueryData = {} as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.openAI);
    });
  });

  describe('useResponsesApi resolution for agents', () => {
    it('passes useResponsesApi from fetched agent model parameters', () => {
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: { useResponsesApi: true },
      } as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.useResponsesApi).toBe(true);
    });

    it('falls back to agentsMap model parameters when fetched agent omits them', () => {
      mockAgentsMap = {
        'agent-1': {
          provider: EModelEndpoint.azureOpenAI,
          model_parameters: { useResponsesApi: true },
        } as Partial<Agent>,
      };
      mockAgentQueryData = { provider: EModelEndpoint.azureOpenAI } as Partial<Agent>;
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(mockAttachFileMenuProps.useResponsesApi).toBe(true);
    });

    it('lets the saved agent decide over the conversation', () => {
      /* Execution reads the agent's own model parameters, so the attach menu must offer
       * what the turn will actually do rather than what the conversation says. */
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: { useResponsesApi: true },
      } as Partial<Agent>;
      renderComponent({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        useResponsesApi: false,
      });
      expect(mockAttachFileMenuProps.useResponsesApi).toBe(true);
    });

    it('keeps the conversation setting when the agent states none', () => {
      mockAgentQueryData = {
        provider: EModelEndpoint.azureOpenAI,
        model_parameters: {},
      } as Partial<Agent>;
      renderComponent({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
        useResponsesApi: true,
      });
      expect(mockAttachFileMenuProps.useResponsesApi).toBe(true);
    });
  });

  describe('endpointType resolution for non-agents', () => {
    it('passes custom endpointType for a custom endpoint', () => {
      renderComponent({ endpoint: 'Moonshot' });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.custom);
    });

    it('passes openAI endpointType for openAI endpoint', () => {
      renderComponent({ endpoint: EModelEndpoint.openAI });
      expect(mockAttachFileMenuProps.endpointType).toBe(EModelEndpoint.openAI);
    });
  });

  describe('consistency: same endpoint type for direct vs agent usage', () => {
    it('resolves Moonshot the same way whether used directly or through an agent', () => {
      renderComponent({ endpoint: 'Moonshot' });
      const directType = mockAttachFileMenuProps.endpointType;

      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const agentType = mockAttachFileMenuProps.endpointType;

      expect(directType).toBe(agentType);
    });
  });

  describe('upload disabled rendering', () => {
    it('renders null for agents endpoint when fileConfig.agents.disabled is true', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          [EModelEndpoint.agents]: { disabled: true },
        },
      });
      const { container } = renderComponent({
        endpoint: EModelEndpoint.agents,
        agent_id: 'agent-1',
      });
      expect(container.innerHTML).toBe('');
    });

    it('renders null for agents endpoint when disableInputs is true', () => {
      const { container } = renderComponent(
        { endpoint: EModelEndpoint.agents, agent_id: 'agent-1' },
        true,
      );
      expect(container.innerHTML).toBe('');
    });

    it('renders AttachFile for assistants endpoint when not disabled', () => {
      renderComponent({ endpoint: EModelEndpoint.assistants });
      expect(screen.getByTestId('attach-file')).toBeInTheDocument();
    });

    it('renders AttachFileMenu when provider-specific config overrides agents disabled', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          Moonshot: { disabled: false, fileLimit: 5 },
          [EModelEndpoint.agents]: { disabled: true },
        },
      });
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      expect(screen.getByTestId('attach-file-menu')).toBeInTheDocument();
    });

    it('renders null for assistants endpoint when fileConfig.assistants.disabled is true', () => {
      mockFileConfig = mergeFileConfig({
        endpoints: {
          [EModelEndpoint.assistants]: { disabled: true },
        },
      });
      const { container } = renderComponent({
        endpoint: EModelEndpoint.assistants,
      });
      expect(container.innerHTML).toBe('');
    });
  });

  describe('endpointFileConfig resolution', () => {
    it('passes Moonshot-specific file config for agent with Moonshot provider', () => {
      mockAgentsMap = {
        'agent-1': { provider: 'Moonshot', model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(5);
    });

    it('passes agents file config when agent has no specific provider config', () => {
      mockAgentsMap = {
        'agent-1': { provider: EModelEndpoint.openAI, model_parameters: {} } as Partial<Agent>,
      };
      renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(10);
    });

    it('passes agents file config when no agent provider', () => {
      renderComponent({ endpoint: EModelEndpoint.agents });
      const config = mockAttachFileMenuProps.endpointFileConfig as { fileLimit?: number };
      expect(config?.fileLimit).toBe(20);
    });
  });
});

describe('AttachFileChat upload config gating', () => {
  beforeEach(() => {
    mockFileConfig = defaultFileConfig;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;
    mockAttachFileMenuProps = {};
  });

  it('leaves the attach menu inert until the file config resolves', () => {
    /* The menu is an action, not just a display: offering the chooser here submits an
     * explicit destination a unified deployment would have inferred, and after a failed
     * fetch it would keep offering it. */
    mockFileConfigLoaded = false;

    renderComponent({ endpoint: EModelEndpoint.agents });

    expect(mockAttachFileMenuProps.disabled).toBe(true);
  });

  it('enables it once the config lands', () => {
    mockFileConfigLoaded = true;

    renderComponent({ endpoint: EModelEndpoint.agents });

    expect(mockAttachFileMenuProps.disabled).toBe(false);
  });

  it('keeps it inert while a saved agent provider is still being fetched', () => {
    /* The config can succeed before the agent does, and until then endpointFileConfig is
     * the generic agents entry rather than the provider's. */
    mockFileConfigLoaded = true;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;

    renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent_saved01' });

    expect(mockAttachFileMenuProps.disabled).toBe(true);
  });

  it('does not wait on a provider an ephemeral agent will never have', () => {
    /* There is no record to fetch for one, so gating on its provider never lifts and the
     * attach control stays disabled for the whole conversation. */
    mockFileConfigLoaded = true;
    mockAgentsMap = {};
    mockAgentQueryData = undefined;

    renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'ephemeral-convo-1' });

    expect(mockAttachFileMenuProps.disabled).toBe(false);
  });

  it('enables it once that provider resolves', () => {
    mockFileConfigLoaded = true;
    mockAgentQueryData = { provider: 'openAI' } as Partial<Agent>;

    renderComponent({ endpoint: EModelEndpoint.agents, agent_id: 'agent_saved01' });

    expect(mockAttachFileMenuProps.disabled).toBe(false);
  });
});
