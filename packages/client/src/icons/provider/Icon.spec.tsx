import '@testing-library/jest-dom';
import { ProviderId } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import { ProviderIcon } from './Icon';

describe('ProviderIcon', () => {
  it('renders component art with an accessible label', () => {
    render(<ProviderIcon provider={ProviderId.openai} />);
    expect(screen.getByRole('img', { name: 'OpenAI' })).toBeInTheDocument();
  });

  it('renders asset art as an image from the packaged module', () => {
    render(<ProviderIcon provider={ProviderId.ollama} />);
    expect(screen.getByRole('img', { name: 'Ollama' })).toHaveAttribute('src', 'assets/ollama.png');
  });

  it('gives monochrome art a theme token so it follows light and dark', () => {
    const { container } = render(<ProviderIcon provider={ProviderId.xai} />);
    expect(container.firstChild).toHaveClass('text-text-primary');
  });

  it('does not shrink Cohere art with landing-only padding', () => {
    const { container } = render(<ProviderIcon provider={ProviderId.cohere} />);
    expect(container.firstChild).not.toHaveClass('p-2');
  });

  it('applies the model refinement, so Gemini and Gemma keep distinct labels', () => {
    render(<ProviderIcon provider={ProviderId.google} model="gemini-2.5-pro" />);
    expect(screen.getByRole('img', { name: 'Gemini' })).toBeInTheDocument();
    render(<ProviderIcon provider={ProviderId.google} model="gemma-3-27b" />);
    expect(screen.getByRole('img', { name: 'Gemma' })).toBeInTheDocument();
  });

  it('falls back to the generic mark for an unknown provider', () => {
    render(<ProviderIcon provider={null} />);
    expect(screen.getByRole('img', { name: 'Custom' })).toBeInTheDocument();
  });
  it('lets the sized span, not a caller size class, govern nested component art', () => {
    const { container } = render(
      <ProviderIcon provider={ProviderId.openai} size={27} className="h-2/3 w-2/3" />,
    );

    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('h-full', 'w-full');
    expect(svg).not.toHaveClass('h-2/3', 'w-2/3');
  });

  it('still forwards a caller color onto nested component art', () => {
    const { container } = render(
      <ProviderIcon provider={ProviderId.anthropic} className="[color:inherit]" />,
    );

    expect(container.querySelector('svg')).toHaveClass('[color:inherit]');
  });
});
