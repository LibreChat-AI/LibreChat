import '@testing-library/jest-dom';
import { ProviderId } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import { ProviderAvatar } from './Avatar';

describe('ProviderAvatar', () => {
  it('paints the brand background and switches art to white on it', () => {
    const { container } = render(<ProviderAvatar provider={ProviderId.anthropic} />);
    const tile = container.firstChild as HTMLElement;
    expect(tile).toHaveStyle({ background: 'var(--provider-anthropic, #d09a74)' });
    expect(tile).toHaveStyle({ color: 'var(--provider-foreground, #ffffff)' });
  });

  it('keeps monochrome art white on a branded tile', () => {
    const { container } = render(<ProviderAvatar provider={ProviderId.anthropic} />);
    const icon = container.querySelector('[role="img"]');
    expect(icon).toHaveClass('[color:inherit]');
    expect(icon).not.toHaveClass('text-text-primary');
  });

  it('uses a theme token when the provider has no brand background', () => {
    const { container } = render(<ProviderAvatar provider={ProviderId.google} />);
    expect(container.firstChild).toHaveClass('text-text-primary');
  });

  it('varies the OpenAI background by model generation', () => {
    const { container: four } = render(
      <ProviderAvatar provider={ProviderId.openai} model="gpt-4o" />,
    );
    const { container: five } = render(
      <ProviderAvatar provider={ProviderId.openai} model="gpt-5.6" />,
    );
    expect(four.firstChild).toHaveStyle({ background: 'var(--provider-openai-gpt4, #AB68FF)' });
    expect(five.firstChild).toHaveStyle({
      background: 'var(--provider-openai-reasoning, #000000)',
    });
  });

  it('labels the tile with the provider name', () => {
    render(<ProviderAvatar provider={ProviderId.bedrock} />);
    expect(screen.getByTitle('AWS Bedrock')).toBeInTheDocument();
  });

  it('exposes the provider name once, so the tile does not double label its art', () => {
    render(<ProviderAvatar provider={ProviderId.bedrock} />);
    expect(screen.getAllByRole('img', { name: 'AWS Bedrock' })).toHaveLength(1);
  });
});
