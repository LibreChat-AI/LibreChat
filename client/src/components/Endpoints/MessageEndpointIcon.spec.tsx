import { render, screen } from '@testing-library/react';
import { EModelEndpoint, ProviderId } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import MessageEndpointIcon from './MessageEndpointIcon';

describe('MessageEndpointIcon', () => {
  it('uses the semantic foreground when an endpoint icon has no background', () => {
    const { container } = render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.custom}
        model="custom-model"
        isCreatedByUser={false}
      />,
    );

    expect(container.firstElementChild).toHaveClass('text-text-primary');
    expect(container.firstElementChild).not.toHaveClass('text-white');
  });

  it('keeps a contrasting foreground when an endpoint icon has a colored background', () => {
    const { container } = render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.openAI}
        model="gpt-4"
        isCreatedByUser={false}
      />,
    );

    expect(container.firstElementChild).toHaveStyle({
      color: 'var(--provider-foreground, #ffffff)',
    });
    expect(container.firstElementChild).not.toHaveClass('text-text-primary');
  });

  it('renders the Gemini mark for a Gemini model', () => {
    render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.google}
        model="gemini-2.5-pro"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByTitle('Gemini')).toBeInTheDocument();
  });

  it('renders the Google mark for a non-Gemini Google model', () => {
    render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.google}
        model="text-bison"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByTitle('Google')).toBeInTheDocument();
  });

  it('paints the modern OpenAI tile black', () => {
    const { container } = render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.openAI}
        model="gpt-5.6"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(container.querySelector('[title="OpenAI"]')).toHaveStyle({
      background: 'var(--provider-openai-reasoning, #000000)',
    });
  });

  it('marks the tile when the message errored', () => {
    const { container } = render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.openAI}
        model="gpt-4"
        size={30}
        error={true}
        isCreatedByUser={false}
      />,
    );

    const badge = container.querySelector('[title="OpenAI"] > .bg-status-error-strong');
    expect(badge).toHaveTextContent('!');
  });

  it('keeps a configured endpoint image instead of the generic mark', () => {
    render(
      <MessageEndpointIcon
        endpoint="My Gateway"
        iconURL="https://cdn.example.com/logo.png"
        model="some-model"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByAltText('My Gateway Icon')).toHaveAttribute(
      'src',
      'https://cdn.example.com/logo.png',
    );
  });

  it('uses the server providerId when the message has no iconURL', () => {
    const endpointsConfig = {
      'My OpenRouter': {
        type: EModelEndpoint.custom,
        providerId: ProviderId.openrouter,
        order: 0,
      },
    } as TEndpointsConfig;

    render(
      <MessageEndpointIcon
        endpoint="My OpenRouter"
        endpointsConfig={endpointsConfig}
        model="some-model"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByRole('img', { name: 'OpenRouter' })).toBeInTheDocument();
  });

  it('labels a Gemma model as Gemma', () => {
    render(
      <MessageEndpointIcon
        endpoint={EModelEndpoint.google}
        model="gemma-3-27b"
        size={30}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByTitle('Gemma')).toBeInTheDocument();
  });
});
