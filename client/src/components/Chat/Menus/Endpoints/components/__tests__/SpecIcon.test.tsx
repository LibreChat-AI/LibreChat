import { render, screen } from '@testing-library/react';
import { EModelEndpoint, ProviderId } from 'librechat-data-provider';
import type { TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import SpecIcon from '../SpecIcon';

jest.mock('~/components/Endpoints/URLIcon', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  return {
    URLIcon: ({ iconURL, provider }: { iconURL: string; provider?: string | null }) =>
      React.createElement('span', {
        'data-testid': 'url-icon',
        'data-icon-url': iconURL,
        'data-provider': provider ?? '',
      }),
  };
});

describe('SpecIcon', () => {
  const endpointsConfig = {} as TEndpointsConfig;

  it('renders the explicit spec icon when runtime spec data is missing preset', () => {
    const currentSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
      iconURL: EModelEndpoint.google,
    } as TModelSpec;

    render(<SpecIcon currentSpec={currentSpec} endpointsConfig={endpointsConfig} />);

    expect(screen.getByRole('img', { name: 'Google' })).toBeInTheDocument();
  });

  it('renders same-origin absolute spec icon URLs as images', () => {
    const currentSpec = {
      name: 'clickhouse-test',
      label: 'ClickHouse Test',
      iconURL: '/assets/clickhouse-logo.svg',
      preset: {
        endpoint: EModelEndpoint.anthropic,
      },
    } as TModelSpec;

    render(<SpecIcon currentSpec={currentSpec} endpointsConfig={endpointsConfig} />);

    expect(screen.getByTestId('url-icon')).toHaveAttribute(
      'data-icon-url',
      '/assets/clickhouse-logo.svg',
    );
    expect(screen.getByTestId('url-icon')).toHaveAttribute('data-provider', ProviderId.anthropic);
  });

  it('falls back to the generic icon when runtime spec data has no icon or preset', () => {
    const currentSpec = {
      name: 'gemini-test',
      label: 'Gemini Test',
    } as TModelSpec;

    render(<SpecIcon currentSpec={currentSpec} endpointsConfig={endpointsConfig} />);

    expect(screen.getByRole('img', { name: 'Custom' })).toBeInTheDocument();
  });

  it("renders the agent's avatar when the spec defines no icon of its own", () => {
    const currentSpec = {
      name: 'agent-spec',
      label: 'Agent Spec',
      preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_abc' },
    } as TModelSpec;

    render(
      <SpecIcon
        currentSpec={currentSpec}
        endpointsConfig={endpointsConfig}
        agentAvatarURL="/images/agent-avatar.png"
      />,
    );

    expect(screen.getByTestId('url-icon')).toHaveAttribute(
      'data-icon-url',
      '/images/agent-avatar.png',
    );
  });

  /**
   * Form-authored specs persist untouched icon fields as empty strings, which
   * must not suppress the avatar the way a real icon would.
   */
  it('treats empty icon fields as unset and still uses the agent avatar', () => {
    const currentSpec = {
      name: 'agent-spec',
      label: 'Agent Spec',
      iconURL: '',
      preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_abc', iconURL: '' },
    } as unknown as TModelSpec;

    render(
      <SpecIcon
        currentSpec={currentSpec}
        endpointsConfig={endpointsConfig}
        agentAvatarURL="/images/agent-avatar.png"
      />,
    );

    expect(screen.getByTestId('url-icon')).toHaveAttribute(
      'data-icon-url',
      '/images/agent-avatar.png',
    );
  });

  it('prefers an explicit spec icon over the agent avatar', () => {
    const currentSpec = {
      name: 'agent-spec',
      label: 'Agent Spec',
      iconURL: '/assets/explicit-logo.svg',
      preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_abc' },
    } as TModelSpec;

    render(
      <SpecIcon
        currentSpec={currentSpec}
        endpointsConfig={endpointsConfig}
        agentAvatarURL="/images/agent-avatar.png"
      />,
    );

    expect(screen.getByTestId('url-icon')).toHaveAttribute(
      'data-icon-url',
      '/assets/explicit-logo.svg',
    );
  });
});
