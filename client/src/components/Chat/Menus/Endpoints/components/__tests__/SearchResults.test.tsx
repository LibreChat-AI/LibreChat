import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TModelSpec } from 'librechat-data-provider';
import type { Endpoint, SelectedValues } from '~/common';
import { SearchResults } from '../SearchResults';

const mockHandleSelectSpec = jest.fn();
const mockHandleSelectModel = jest.fn();
const mockHandleSelectEndpoint = jest.fn();
const mockNavigate = jest.fn();
const mockToggleFavoriteAgent = jest.fn();
const mockToggleFavoriteModel = jest.fn();
let mockSelectedValues: SelectedValues;

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    selectedValues: mockSelectedValues,
    handleSelectSpec: mockHandleSelectSpec,
    handleSelectModel: mockHandleSelectModel,
    handleSelectEndpoint: mockHandleSelectEndpoint,
    endpointsConfig: {},
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', tabIndex: 0, ...rest }, children);
    }),
  };
});

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('~/hooks', () => ({
  useFavorites: () => ({
    isFavoriteModel: () => false,
    toggleFavoriteModel: mockToggleFavoriteModel,
    isFavoriteAgent: () => false,
    toggleFavoriteAgent: mockToggleFavoriteAgent,
  }),
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

const mockVirtualizedModelList = jest.fn();
jest.mock('../VirtualizedModelList', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: (props: {
      endpoint: Endpoint;
      modelIds: string[];
      globalByName: Map<string, boolean>;
      isFavorite: (modelId: string) => boolean;
      onToggleFavorite: (modelId: string) => void;
      precedingOptionCount: number;
      listboxSetSize?: number;
    }) => {
      mockVirtualizedModelList(props);
      const { EndpointModelItem } = jest.requireActual('../EndpointModelItem');
      const modelId = props.modelIds[0];
      return React.createElement(
        'div',
        { 'data-testid': 'virtualized-list' },
        React.createElement(EndpointModelItem, {
          modelId,
          endpoint: props.endpoint,
          isGlobal: props.globalByName.get(modelId) ?? false,
          isFavorite: props.isFavorite(modelId),
          onToggleFavorite: props.onToggleFavorite,
          posInSet: props.precedingOptionCount + 1,
          setSize: props.listboxSetSize,
        }),
      );
    },
  };
});

jest.mock('../SpecIcon', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    __esModule: true,
    default: () => React.createElement('span', null, 'icon'),
  };
});

const localize = (key: string) => key;

const anthropicEndpoint: Endpoint = {
  value: 'anthropic',
  label: 'Anthropic',
  hasModels: true,
  models: [{ name: 'claude-opus-4-6' }, { name: 'claude-sonnet-4-5' }],
  icon: null,
};

const noModelsEndpoint: Endpoint = {
  value: 'custom',
  label: 'Custom',
  hasModels: false,
  icon: null,
};

const agentsMarketplaceEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  models: [{ name: 'agent-1' }],
  agentNames: { 'agent-1': 'Support Agent' },
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
  icon: null,
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('SearchResults', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks model as selected when endpoint and model match with no active spec', () => {
    mockSelectedValues = { endpoint: 'anthropic', model: 'claude-opus-4-6', modelSpec: '' };
    render(
      <SearchResults results={[anthropicEndpoint]} localize={localize} searchValue="claude" />,
    );

    const items = screen.getAllByRole('menuitem');
    const selectedItem = items.find((el) => el.getAttribute('aria-selected') === 'true');
    expect(selectedItem).toBeDefined();
    expect(selectedItem).toHaveTextContent('claude-opus-4-6');
  });
  it('keeps selection, badges, icons, and favorite controls on non-virtualized rows', () => {
    mockSelectedValues = { endpoint: 'agents', model: 'agent-1', modelSpec: '' };
    render(
      <SearchResults
        results={[
          {
            ...agentsMarketplaceEndpoint,
            showMarketplace: false,
            models: [{ name: 'agent-1', isGlobal: true }],
            modelIcons: { 'agent-1': '/agent.png' },
          },
        ]}
        localize={localize}
        searchValue="agent"
      />,
    );

    const item = screen.getByRole('menuitem', { name: /Support Agent/ });
    expect(item).toHaveAttribute('aria-selected', 'true');
    expect(item).toHaveTextContent('com_a11y_selected');
    expect(item.querySelector('.lucide-earth')).toBeInTheDocument();
    expect(within(item).getByAltText('Support Agent')).toBeInTheDocument();

    fireEvent.click(within(item).getByRole('button', { name: 'com_ui_pin' }));
    expect(mockToggleFavoriteAgent).toHaveBeenCalledWith('agent-1');
  });

  it('does not mark model as selected when a spec is active', () => {
    mockSelectedValues = {
      endpoint: 'anthropic',
      model: 'claude-opus-4-6',
      modelSpec: 'my-spec',
    };
    render(
      <SearchResults results={[anthropicEndpoint]} localize={localize} searchValue="claude" />,
    );

    const items = screen.getAllByRole('menuitem');
    for (const item of items) {
      expect(item).not.toHaveAttribute('aria-selected');
    }
  });

  it('does not mark endpoint as selected when a spec is active', () => {
    mockSelectedValues = {
      endpoint: 'custom',
      model: '',
      modelSpec: 'my-spec',
    };
    render(<SearchResults results={[noModelsEndpoint]} localize={localize} searchValue="custom" />);

    const item = screen.getByRole('menuitem');
    expect(item).not.toHaveAttribute('aria-selected');
  });

  it('marks endpoint as selected when no spec is active and endpoint matches', () => {
    mockSelectedValues = { endpoint: 'custom', model: '', modelSpec: '' };
    render(<SearchResults results={[noModelsEndpoint]} localize={localize} searchValue="custom" />);

    const item = screen.getByRole('menuitem');
    expect(item).toHaveAttribute('aria-selected', 'true');
  });

  it('renders Marketplace from agent endpoint search results and navigates to agents', () => {
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    render(
      <SearchResults
        results={[agentsMarketplaceEndpoint]}
        localize={localize}
        searchValue="marketplace"
      />,
    );

    const item = screen.getByRole('menuitem', { name: 'com_agents_marketplace' });
    expect(item).toBeInTheDocument();

    fireEvent.click(item);
    expect(mockNavigate).toHaveBeenCalledWith('/agents');
    expect(mockHandleSelectModel).not.toHaveBeenCalled();
  });

  it('assigns search option positions across specs, marketplace, and endpoint rows', () => {
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    const spec = { name: 'preset', label: 'Preset' } as TModelSpec;
    const models = Array.from({ length: 101 }, (_, index) => ({
      name: `agent-${index}`,
    }));
    const secondEndpoint: Endpoint = {
      value: 'other',
      label: 'Other',
      hasModels: true,
      models: [{ name: 'agent-other-1' }, { name: 'agent-other-2' }],
      icon: null,
    };

    render(
      <SearchResults
        results={[spec, { ...agentsMarketplaceEndpoint, models }, secondEndpoint]}
        localize={localize}
        searchValue="agent"
      />,
    );

    const firstVirtualRow = within(screen.getByTestId('virtualized-list')).getByRole('menuitem');
    expect(firstVirtualRow).toHaveAttribute('aria-posinset', '3');
    expect(firstVirtualRow).toHaveAttribute('aria-setsize', '105');
    expect(screen.getByTestId('model-selector-marketplace-item')).toHaveAttribute(
      'aria-posinset',
      '2',
    );
    expect(screen.getByTestId('model-selector-marketplace-item')).toHaveAttribute(
      'aria-setsize',
      '105',
    );
    expect(screen.getByRole('menuitem', { name: 'agent-other-1' })).toHaveAttribute(
      'aria-posinset',
      '104',
    );
  });

  it('renders every matching row directly at or below the virtualization threshold', () => {
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    const models = Array.from({ length: 100 }, (_, i) => ({
      name: `agent-${i}`,
      isGlobal: i % 2 === 0,
    }));
    render(
      <SearchResults
        results={[{ ...agentsMarketplaceEndpoint, showMarketplace: false, models }]}
        localize={localize}
        searchValue="agent"
      />,
    );

    expect(screen.queryByTestId('virtualized-list')).not.toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(100);
  });

  it('windows the rows while preserving keyboard and selected-state affordances', () => {
    mockSelectedValues = { endpoint: 'agents', model: 'agent-0', modelSpec: '' };
    const models = Array.from({ length: 101 }, (_, i) => ({
      name: `agent-${i}`,
      isGlobal: i === 0,
    }));
    render(
      <SearchResults
        results={[
          {
            ...agentsMarketplaceEndpoint,
            models,
            agentNames: { 'agent-0': 'Virtual Agent' },
          },
        ]}
        localize={localize}
        searchValue="agent"
      />,
    );

    expect(screen.getByTestId('virtualized-list')).toBeInTheDocument();
    expect(mockVirtualizedModelList).toHaveBeenCalledWith(
      expect.objectContaining({
        modelIds: models.map((m) => m.name),
        precedingOptionCount: 1,
      }),
    );
    const { globalByName } = mockVirtualizedModelList.mock.calls[0][0];
    expect(globalByName.get('agent-0')).toBe(true);
    expect(globalByName.get('agent-4')).toBe(false);

    const item = screen.getByRole('menuitem', { name: /Virtual Agent/ });
    expect(item).toHaveAttribute('aria-selected', 'true');
    expect(item).toHaveTextContent('com_a11y_selected');
    expect(item.querySelector('.lucide-earth')).toBeInTheDocument();
    item.focus();
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'ArrowDown' });
    fireEvent.click(within(item).getByRole('button', { name: 'com_ui_pin' }));
    expect(mockToggleFavoriteAgent).toHaveBeenCalledWith('agent-0');
  });

  it('does not render agents as a selectable endpoint when marketplace and agent rows are unavailable', () => {
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    render(
      <SearchResults
        results={[disabledAgentsEndpoint]}
        localize={localize}
        searchValue="my agents"
      />,
    );

    expect(screen.queryByRole('menuitem', { name: 'My Agents' })).not.toBeInTheDocument();
    expect(mockHandleSelectEndpoint).not.toHaveBeenCalled();
  });
});
