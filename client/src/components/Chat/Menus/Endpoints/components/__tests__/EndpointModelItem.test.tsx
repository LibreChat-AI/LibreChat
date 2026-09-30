import { render, screen } from '@testing-library/react';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointModelItem } from '../EndpointModelItem';

const mockHandleSelectModel = jest.fn();
let mockSelectedValues: SelectedValues;
let mockModelSelectMenuMode: 'flat' | 'auto' | 'nested' | undefined;
let mockMappedEndpoints: Endpoint[];

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    handleSelectModel: mockHandleSelectModel,
    selectedValues: mockSelectedValues,
    modelSelectMenuMode: mockModelSelectMenuMode,
    mappedEndpoints: mockMappedEndpoints,
  }),
}));

jest.mock('~/components/Chat/Menus/Endpoints/CustomMenu', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    CustomMenuItem: React.forwardRef(function MockMenuItem(
      { children, ...rest }: { children?: React.ReactNode },
      ref: React.Ref<HTMLDivElement>,
    ) {
      return React.createElement('div', { ref, role: 'menuitem', ...rest }, children);
    }),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/components/Chat/Menus/Endpoints/useActiveItem', () => ({
  __esModule: true,
  default: () => ({ ref: { current: null }, isActive: false }),
}));

const renderItem = (props: Partial<React.ComponentProps<typeof EndpointModelItem>> = {}) =>
  render(
    <EndpointModelItem
      modelId="claude-opus-4-6"
      endpoint={baseEndpoint}
      isFavorite={false}
      onToggleFavorite={jest.fn()}
      {...props}
    />,
  );

const baseEndpoint: Endpoint = {
  value: 'anthropic',
  label: 'Anthropic',
  hasModels: true,
  models: [{ name: 'claude-opus-4-6' }],
  icon: null,
};

describe('EndpointModelItem', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockModelSelectMenuMode = undefined;
    mockMappedEndpoints = [];
  });

  it('renders checkmark when model and endpoint match with no active spec', () => {
    mockSelectedValues = { endpoint: 'anthropic', model: 'claude-opus-4-6', modelSpec: '' };
    renderItem();

    const menuItem = screen.getByRole('menuitem');
    expect(menuItem).toHaveAttribute('aria-selected', 'true');
  });

  it('does NOT render checkmark when a model spec is active even if endpoint and model match', () => {
    mockSelectedValues = {
      endpoint: 'anthropic',
      model: 'claude-opus-4-6',
      modelSpec: 'my-anthropic-spec',
    };
    renderItem();

    const menuItem = screen.getByRole('menuitem');
    expect(menuItem).not.toHaveAttribute('aria-selected');
  });

  it('does NOT render checkmark when model matches but endpoint differs', () => {
    mockSelectedValues = { endpoint: 'openai', model: 'claude-opus-4-6', modelSpec: '' };
    renderItem();

    const menuItem = screen.getByRole('menuitem');
    expect(menuItem).not.toHaveAttribute('aria-selected');
  });

  it('does NOT render checkmark when endpoint matches but model differs', () => {
    mockSelectedValues = { endpoint: 'anthropic', model: 'claude-sonnet-4-5', modelSpec: '' };
    renderItem();

    const menuItem = screen.getByRole('menuitem');
    expect(menuItem).not.toHaveAttribute('aria-selected');
  });

  it('only prefixes the endpoint label when explicitly enabled', () => {
    mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    mockModelSelectMenuMode = 'flat';
    mockMappedEndpoints = [baseEndpoint];

    const { rerender } = render(
      <EndpointModelItem modelId="claude-opus-4-6" endpoint={baseEndpoint} />,
    );

    expect(screen.getByText('claude-opus-4-6')).toBeInTheDocument();
    expect(screen.queryByText('Anthropic/claude-opus-4-6')).not.toBeInTheDocument();

    rerender(
      <EndpointModelItem
        modelId="claude-opus-4-6"
        endpoint={{
          ...baseEndpoint,
          customParams: { showEndpointInModelName: true },
        }}
      />,
    );

    expect(screen.getByText('Anthropic/claude-opus-4-6')).toBeInTheDocument();
  });
});
