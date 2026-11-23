import { ProviderId } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { Endpoint, SelectedValues } from '~/common';
import { EndpointModelItem } from '../EndpointModelItem';

const mockHandleSelectModel = jest.fn();
let mockSelectedValues: SelectedValues;
const mockEndpointsConfig = {
  OpenRouter: { order: 1, providerId: ProviderId.openrouter },
} as unknown as TEndpointsConfig;

jest.mock('~/components/Chat/Menus/Endpoints/ModelSelectorContext', () => ({
  useModelSelectorContext: () => ({
    handleSelectModel: mockHandleSelectModel,
    selectedValues: mockSelectedValues,
    endpointsConfig: mockEndpointsConfig,
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

  describe('model icon', () => {
    const openRouter: Endpoint = {
      value: 'OpenRouter',
      label: 'OpenRouter',
      hasModels: true,
      icon: null,
    };

    beforeEach(() => {
      mockSelectedValues = { endpoint: '', model: '', modelSpec: '' };
    });

    it.each([
      ['google/gemini-2.5-pro', 'Gemini'],
      ['anthropic/claude-sonnet-4.5', 'Anthropic'],
      ['openrouter/auto', 'OpenRouter'],
    ])('shows the maker of %s on a gateway row', (modelId, label) => {
      renderItem({ endpoint: openRouter, modelId });
      expect(screen.getByRole('img', { name: label, hidden: true })).toBeInTheDocument();
    });

    it('shows the provider mark on a first-party row', () => {
      renderItem();
      expect(screen.getByRole('img', { name: 'Anthropic', hidden: true })).toBeInTheDocument();
    });

    it('keeps the mark out of the row accessible name', () => {
      renderItem();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('prefers a configured model avatar over the maker mark', () => {
      renderItem({
        endpoint: { ...openRouter, modelIcons: { 'openai/gpt-5': '/avatars/gpt.png' } },
        modelId: 'openai/gpt-5',
      });
      expect(screen.getByRole('img', { name: 'openai/gpt-5' })).toHaveAttribute(
        'src',
        '/avatars/gpt.png',
      );
      expect(screen.queryByRole('img', { name: 'OpenAI', hidden: true })).not.toBeInTheDocument();
    });
  });
});
