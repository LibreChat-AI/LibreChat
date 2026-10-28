import { render, screen, fireEvent } from '@testing-library/react';
import type { Agent, TEndpointsConfig, TModelSpec } from 'librechat-data-provider';
import type { FavoriteModel } from '~/store/favorites';
import FavoriteItem from '../FavoriteItem';

const mockRemoveFavoriteAgent = jest.fn();
const mockRemoveFavoriteModel = jest.fn();
const mockRemoveFavoriteSpec = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({
    removeFavoriteAgent: mockRemoveFavoriteAgent,
    removeFavoriteModel: mockRemoveFavoriteModel,
    removeFavoriteSpec: mockRemoveFavoriteSpec,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/components/SpecIcon', () => ({
  __esModule: true,
  default: ({ agentAvatarURL }: { agentAvatarURL?: string }) => (
    <span data-testid="spec-icon" data-agent-avatar-url={agentAvatarURL ?? ''} />
  ),
}));

jest.mock('~/components/Endpoints/MinimalIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="minimal-icon" />,
}));

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  renderAgentAvatar: () => <span data-testid="agent-avatar" />,
}));

const baseAgent: Agent = {
  id: 'agent-123',
  name: 'Research Agent',
  avatar: null,
  provider: 'openai',
  model: 'gpt-5',
  instructions: '',
  description: '',
  tools: [],
  created_at: 0,
  updated_at: 0,
  author: 'u1',
} as unknown as Agent;

const baseModel: FavoriteModel = { model: 'gpt-5', endpoint: 'openai' };
const endpointsConfig: TEndpointsConfig = {
  openai: { order: 0, modelLabels: { 'gpt-5': 'GPT-5' } },
};

const baseSpec: TModelSpec = {
  name: 'my-spec',
  label: 'My Model Spec',
  preset: { endpoint: 'openai', model: 'gpt-5' },
};

describe('FavoriteItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('type="agent"', () => {
    it('renders the agent name and avatar', () => {
      const onSelectEndpoint = jest.fn();
      render(<FavoriteItem type="agent" item={baseAgent} onSelectEndpoint={onSelectEndpoint} />);
      expect(screen.getByText('Research Agent')).toBeInTheDocument();
      expect(screen.getByTestId('agent-avatar')).toBeInTheDocument();
    });

    it('has aria-label formatted as "<name> (com_ui_agent)"', () => {
      render(<FavoriteItem type="agent" item={baseAgent} />);
      expect(
        screen.getByRole('button', { name: 'Research Agent (com_ui_agent)' }),
      ).toBeInTheDocument();
    });

    it('calls onSelectEndpoint with agents endpoint + agent_id on click', () => {
      const onSelectEndpoint = jest.fn();
      render(<FavoriteItem type="agent" item={baseAgent} onSelectEndpoint={onSelectEndpoint} />);
      fireEvent.click(screen.getByTestId('favorite-item'));
      expect(onSelectEndpoint).toHaveBeenCalledWith('agents', { agent_id: 'agent-123' });
    });
  });

  describe('type="model"', () => {
    it('renders model name and minimal icon', () => {
      render(<FavoriteItem type="model" item={baseModel} />);
      expect(screen.getByText('gpt-5')).toBeInTheDocument();
      expect(screen.getByTestId('minimal-icon')).toBeInTheDocument();
    });

    it('renders the configured model label while retaining the model id for selection', () => {
      const onSelectEndpoint = jest.fn();
      render(
        <FavoriteItem
          type="model"
          item={baseModel}
          endpointsConfig={endpointsConfig}
          onSelectEndpoint={onSelectEndpoint}
        />,
      );

      expect(screen.getByText('GPT-5')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('favorite-item'));
      expect(onSelectEndpoint).toHaveBeenCalledWith('openai', { model: 'gpt-5' });
    });

    it('has aria-label formatted as "<model> (com_ui_model)"', () => {
      render(<FavoriteItem type="model" item={baseModel} />);
      expect(screen.getByRole('button', { name: 'gpt-5 (com_ui_model)' })).toBeInTheDocument();
    });

    it('calls onSelectEndpoint with endpoint + model on click', () => {
      const onSelectEndpoint = jest.fn();
      render(<FavoriteItem type="model" item={baseModel} onSelectEndpoint={onSelectEndpoint} />);
      fireEvent.click(screen.getByTestId('favorite-item'));
      expect(onSelectEndpoint).toHaveBeenCalledWith('openai', { model: 'gpt-5' });
    });
  });

  describe('type="spec"', () => {
    it('renders the spec label and SpecIcon', () => {
      render(<FavoriteItem type="spec" item={baseSpec} />);
      expect(screen.getByText('My Model Spec')).toBeInTheDocument();
      expect(screen.getByTestId('spec-icon')).toBeInTheDocument();
    });

    /** The pinned row must show the same agent avatar as the selector row. */
    it('threads the agent avatar through to SpecIcon', () => {
      render(
        <FavoriteItem type="spec" item={baseSpec} agentAvatarURL="/images/agent-avatar.png" />,
      );
      expect(screen.getByTestId('spec-icon')).toHaveAttribute(
        'data-agent-avatar-url',
        '/images/agent-avatar.png',
      );
    });

    it('has aria-label formatted as "<label> (com_ui_model_spec)"', () => {
      render(<FavoriteItem type="spec" item={baseSpec} />);
      expect(
        screen.getByRole('button', { name: 'My Model Spec (com_ui_model_spec)' }),
      ).toBeInTheDocument();
    });

    it('calls onSelectSpec with the full spec on click', () => {
      const onSelectSpec = jest.fn();
      render(<FavoriteItem type="spec" item={baseSpec} onSelectSpec={onSelectSpec} />);
      fireEvent.click(screen.getByTestId('favorite-item'));
      expect(onSelectSpec).toHaveBeenCalledWith(baseSpec);
    });

    it('activates on Enter key', () => {
      const onSelectSpec = jest.fn();
      render(<FavoriteItem type="spec" item={baseSpec} onSelectSpec={onSelectSpec} />);
      fireEvent.keyDown(screen.getByTestId('favorite-item'), { key: 'Enter' });
      expect(onSelectSpec).toHaveBeenCalledWith(baseSpec);
    });

    it('activates on Space key', () => {
      const onSelectSpec = jest.fn();
      render(<FavoriteItem type="spec" item={baseSpec} onSelectSpec={onSelectSpec} />);
      fireEvent.keyDown(screen.getByTestId('favorite-item'), { key: ' ' });
      expect(onSelectSpec).toHaveBeenCalledWith(baseSpec);
    });
  });

  describe('unpin button', () => {
    it('unpins directly without opening a menu', () => {
      render(<FavoriteItem type="agent" item={baseAgent} />);
      const unpin = screen.getByTestId('favorite-unpin-button');
      expect(unpin).toHaveAttribute('aria-label', 'com_ui_unpin');
      fireEvent.click(unpin);
      expect(mockRemoveFavoriteAgent).toHaveBeenCalledWith('agent-123');
    });

    it('unpins a model without selecting the row', () => {
      const onSelectEndpoint = jest.fn();
      render(<FavoriteItem type="model" item={baseModel} onSelectEndpoint={onSelectEndpoint} />);
      fireEvent.click(screen.getByTestId('favorite-unpin-button'));
      expect(mockRemoveFavoriteModel).toHaveBeenCalledWith('gpt-5', 'openai');
      expect(onSelectEndpoint).not.toHaveBeenCalled();
    });

    it('unpins a spec', () => {
      render(<FavoriteItem type="spec" item={baseSpec} />);
      fireEvent.click(screen.getByTestId('favorite-unpin-button'));
      expect(mockRemoveFavoriteSpec).toHaveBeenCalledWith('my-spec');
    });
  });
});
