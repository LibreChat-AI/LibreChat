import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import Landing from '../Landing';

let mockConversation: Record<string, unknown> | null = null;
let mockAgentsMap: Record<string, any> | undefined;
let mockAssistantMap: Record<string, any> | undefined;

jest.mock('@react-spring/web', () => ({
  easings: {
    easeOutCubic: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: {
    azureOpenAI: 'azureOpenAI',
    openAI: 'openAI',
  },
}));

jest.mock('@librechat/client', () => ({
  BirthdayIcon: () => <span data-testid="birthday-icon" />,
  TooltipAnchor: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SplitText: ({ text }: { text: string }) => <span>{text}</span>,
}));

jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation }),
  useAgentsMapContext: () => mockAgentsMap,
  useAssistantsMapContext: () => mockAssistantMap,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: {} } }),
  useGetEndpointsQuery: () => ({ data: {} }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: undefined }),
  useGreeting: () => 'Welcome',
  useLocalize: () => (key: string) => {
    const translations: Record<string, string> = {
      com_agents_contact: 'Contact',
      com_agents_no_contact_available: 'No contact available',
      com_ui_temporary: 'Temporary Chat',
      com_ui_temporary_description:
        "This chat won't appear in your history and will be deleted automatically.",
    };
    return translations[key] || key;
  },
}));

jest.mock('~/utils', () => ({
  CONFIG_HTML_MEDIA_ATTR: {},
  CONFIG_HTML_MEDIA_TAGS: [],
  cn: (...classes: string[]) => classes.filter(Boolean).join(' '),
  createConfigHtmlSanitizer: () => (html: string) => html,
  getIconEndpoint: ({ endpoint }: { endpoint: string }) => endpoint,
  getModelSpec: () => undefined,
  getEntity: ({
    endpoint,
    agentsMap,
    assistantMap,
    agent_id,
    assistant_id,
  }: {
    endpoint: string;
    agentsMap?: Record<string, any>;
    assistantMap?: Record<string, any>;
    agent_id?: string;
    assistant_id?: string;
  }) => {
    if (endpoint === 'agents' && agent_id != null) {
      return { entity: agentsMap?.[agent_id], isAgent: true, isAssistant: false };
    }
    if (assistant_id != null) {
      return { entity: assistantMap?.[assistant_id], isAgent: false, isAssistant: true };
    }
    return { entity: undefined, isAgent: false, isAssistant: false };
  },
}));

jest.mock('~/components/Endpoints/ConvoIcon', () => () => <span data-testid="convo-icon" />);

function renderLanding({ isTemporary = false }: { isTemporary?: boolean } = {}) {
  return render(
    <RecoilRoot>
      <ChatSettingsContext.Provider value={{ ...defaultChatSettings, isTemporary }}>
        <Landing centerFormOnLanding={false} />
      </ChatSettingsContext.Provider>
    </RecoilRoot>,
  );
}

describe('Landing agent contact', () => {
  beforeEach(() => {
    mockConversation = null;
    mockAgentsMap = undefined;
    mockAssistantMap = undefined;
  });

  it('shows contact for the selected agent from agentsMap', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'agent-1',
    };
    mockAgentsMap = {
      'agent-1': {
        id: 'agent-1',
        name: 'Portal Remote Agent',
        description: 'Remote Agent Showcase',
        owner_contact: { name: 'Owner User' },
      },
    };

    renderLanding();

    expect(screen.getByText('Portal Remote Agent')).toBeInTheDocument();
    expect(screen.getByText('Remote Agent Showcase')).toBeInTheDocument();
    expect(screen.getByText('Contact:')).toBeInTheDocument();
    expect(screen.getByText('Owner User')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Owner User' })).not.toBeInTheDocument();
  });

  it('does not show contact when the selected agent is missing from agentsMap', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'missing-agent',
      greeting: 'Start chatting',
    };
    mockAgentsMap = {};

    renderLanding();

    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
    expect(screen.queryByText('No contact available')).not.toBeInTheDocument();
  });

  it('does not show contact for assistants', () => {
    mockConversation = {
      endpoint: 'assistants',
      assistant_id: 'assistant-1',
    };
    mockAssistantMap = {
      'assistant-1': {
        id: 'assistant-1',
        name: 'Assistant',
        description: 'Assistant description',
      },
    };

    renderLanding();

    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
  });
});

describe('Landing temporary chat empty state', () => {
  beforeEach(() => {
    mockConversation = null;
    mockAgentsMap = undefined;
    mockAssistantMap = undefined;
  });

  it('replaces the greeting with the temporary chat explanation', () => {
    renderLanding({ isTemporary: true });

    expect(screen.getByText('Temporary Chat')).toBeInTheDocument();
    expect(
      screen.getByText("This chat won't appear in your history and will be deleted automatically."),
    ).toBeInTheDocument();
    expect(screen.queryByText('Welcome')).not.toBeInTheDocument();
    expect(screen.queryByTestId('convo-icon')).not.toBeInTheDocument();
  });

  it('hides the agent identity and contact while temporary', () => {
    mockConversation = {
      endpoint: 'agents',
      agent_id: 'agent-1',
    };
    mockAgentsMap = {
      'agent-1': {
        id: 'agent-1',
        name: 'Portal Remote Agent',
        description: 'Remote Agent Showcase',
        owner_contact: { name: 'Owner User' },
      },
    };

    renderLanding({ isTemporary: true });

    expect(screen.getByText('Temporary Chat')).toBeInTheDocument();
    expect(screen.queryByText('Portal Remote Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Remote Agent Showcase')).not.toBeInTheDocument();
    expect(screen.queryByText('Contact:')).not.toBeInTheDocument();
  });

  it('keeps the normal greeting when temporary chat is off', () => {
    renderLanding();

    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.queryByText('Temporary Chat')).not.toBeInTheDocument();
    expect(screen.getByTestId('convo-icon')).toBeInTheDocument();
  });
});
