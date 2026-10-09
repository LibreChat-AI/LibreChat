import { render, screen } from '@testing-library/react';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { FavoriteModel } from '~/store/favorites';
import FavoriteItem from '../FavoriteItem';

/** Renders the real MinimalIcon so the provider resolution is exercised, unlike
 *  FavoriteItem.spec.tsx which stubs it to assert layout. */
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useFavorites: () => ({
    removeFavoriteAgent: jest.fn(),
    removeFavoriteModel: jest.fn(),
    removeFavoriteSpec: jest.fn(),
  }),
}));

const endpointsConfig: TEndpointsConfig = {
  AnthropicClaude: { iconURL: 'anthropic', order: 0 },
  MetaLlama: { iconURL: '/assets/meta-llama.png', order: 1 },
};

const claudeModel: FavoriteModel = {
  model: 'claude-sonnet-4-5',
  endpoint: 'AnthropicClaude',
};

const llamaModel: FavoriteModel = {
  model: 'llama3-3-70b-instruct',
  endpoint: 'MetaLlama',
};

describe('FavoriteItem type="model" provider art', () => {
  it('renders the art named by the endpoint iconURL', () => {
    render(<FavoriteItem type="model" item={claudeModel} endpointsConfig={endpointsConfig} />);
    expect(screen.getByRole('img', { name: 'Anthropic', hidden: true })).toBeInTheDocument();
  });

  it('renders an image iconURL as the art', () => {
    render(<FavoriteItem type="model" item={llamaModel} endpointsConfig={endpointsConfig} />);
    expect(screen.getByAltText('MetaLlama Icon')).toHaveAttribute('src', '/assets/meta-llama.png');
  });

  it('falls back to the custom art when the endpoint resolves to no provider', () => {
    render(<FavoriteItem type="model" item={claudeModel} />);
    expect(screen.getByRole('img', { name: 'Custom', hidden: true })).toBeInTheDocument();
  });
});
