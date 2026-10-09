import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint, ProviderId } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import MinimalIcon from '../MinimalIcon';

describe('MinimalIcon', () => {
  it('renders the provider mark for a first-class endpoint', () => {
    render(<MinimalIcon endpoint={EModelEndpoint.openAI} isCreatedByUser={false} />);

    expect(screen.getByRole('img', { name: 'OpenAI', hidden: true })).toBeInTheDocument();
    expect(screen.getByTestId('convo-icon')).toHaveAttribute('title', 'OpenAI');
  });
  it('resolves a custom endpoint by name', () => {
    render(<MinimalIcon endpoint="Ollama" isCreatedByUser={false} />);

    const src = screen.getByRole('img', { name: 'Ollama', hidden: true }).getAttribute('src');
    expect(src).toBeTruthy();
    expect(src).not.toBe('');
  });

  it('keeps the agent art out of the provider registry', () => {
    render(<MinimalIcon endpoint={EModelEndpoint.agents} isCreatedByUser={false} />);

    expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('convo-icon')).toHaveAttribute('title', 'My Agents');
  });

  it('keeps the assistant art out of the provider registry', () => {
    render(<MinimalIcon endpoint={EModelEndpoint.assistants} isCreatedByUser={false} />);

    expect(screen.queryByRole('img', { hidden: true })).not.toBeInTheDocument();
    expect(screen.getByTestId('convo-icon')).toHaveAttribute('title', 'Assistant');
  });

  it('renders a configured image iconURL instead of provider art', () => {
    render(
      <MinimalIcon
        endpoint="Internal Gateway"
        iconURL="https://cdn.example.com/logo.png"
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByRole('img', { hidden: true })).toHaveAttribute(
      'src',
      'https://cdn.example.com/logo.png',
    );
  });

  it('uses the server providerId when no iconURL is configured', () => {
    const endpointsConfig = {
      'My OpenRouter': {
        type: EModelEndpoint.custom,
        providerId: ProviderId.openrouter,
        order: 0,
      },
    } as TEndpointsConfig;

    render(
      <MinimalIcon
        endpoint="My OpenRouter"
        endpointsConfig={endpointsConfig}
        isCreatedByUser={false}
      />,
    );

    expect(screen.getByRole('img', { name: 'OpenRouter', hidden: true })).toBeInTheDocument();
  });

  it('hides the decorative wrapper from assistive technology and flags errors', () => {
    render(<MinimalIcon endpoint={EModelEndpoint.openAI} isCreatedByUser={false} error={true} />);

    const wrapper = screen.getByTestId('convo-icon');
    expect(wrapper).toHaveAttribute('aria-hidden', 'true');
    expect(wrapper).toHaveTextContent('!');
  });
});
