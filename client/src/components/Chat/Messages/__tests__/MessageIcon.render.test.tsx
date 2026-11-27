import React from 'react';
import { render, screen } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  getEndpointField: jest.fn(() => ''),
}));
jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
}));
jest.mock('~/utils', () => ({
  getIconEndpoint: jest.fn(() => 'agents'),
}));

const iconRenderCount = { current: 0 };

jest.mock('~/components/Endpoints/ConvoIconURL', () => {
  const ConvoIconURL = (props: Record<string, unknown>) => {
    iconRenderCount.current += 1;
    return <div data-testid="convo-icon-url" data-icon-url={props.iconURL as string} />;
  };
  ConvoIconURL.displayName = 'ConvoIconURL';
  return { __esModule: true, default: ConvoIconURL };
});
jest.mock('~/components/Endpoints/Icon', () => {
  const Icon = (props: Record<string, unknown>) => {
    iconRenderCount.current += 1;
    return <div data-testid="icon" data-icon-url={props.iconURL as string} />;
  };
  Icon.displayName = 'Icon';
  return { __esModule: true, default: Icon };
});

import MessageIcon from '../MessageIcon';

const makeAgent = (overrides?: Partial<Agent>): Agent =>
  ({
    id: 'agent_123',
    name: 'GitHub Agent',
    avatar: { filepath: '/images/agent-avatar.png' },
    ...overrides,
  }) as Agent;

const baseIconData: TMessageIcon = {
  endpoint: EModelEndpoint.agents,
  model: 'agent_123',
  iconURL: undefined,
  modelLabel: 'GitHub Agent',
  isCreatedByUser: false,
};

describe('MessageIcon render cycles', () => {
  beforeEach(() => {
    iconRenderCount.current = 0;
  });

  it('renders once on initial mount', () => {
    render(<MessageIcon iconData={baseIconData} agent={makeAgent()} />);
    expect(iconRenderCount.current).toBe(1);
  });

  it('renders same-origin absolute model spec icon URLs directly', () => {
    render(
      <MessageIcon
        iconData={{
          ...baseIconData,
          iconURL: '/assets/clickhouse-logo.svg',
        }}
      />,
    );

    expect(screen.getByTestId('convo-icon-url')).toHaveAttribute(
      'data-icon-url',
      '/assets/clickhouse-logo.svg',
    );
  });

  it('does not re-render when parent re-renders with same field values but new object references', () => {
    const agent = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent} />);
    iconRenderCount.current = 0;

    rerender(<MessageIcon iconData={{ ...baseIconData }} agent={makeAgent()} />);

    expect(iconRenderCount.current).toBe(0);
  });

  it('does not re-render when agent object reference changes but name and avatar are the same', () => {
    const agent1 = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent1} />);
    iconRenderCount.current = 0;

    const agent2 = makeAgent({ id: 'agent_456' });
    rerender(<MessageIcon iconData={baseIconData} agent={agent2} />);

    expect(iconRenderCount.current).toBe(0);
  });

  it('re-renders when agent avatar filepath changes', () => {
    const agent1 = makeAgent();
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={agent1} />);
    iconRenderCount.current = 0;

    const agent2 = makeAgent({ avatar: { filepath: '/images/new-avatar.png', source: 'local' } });
    rerender(<MessageIcon iconData={baseIconData} agent={agent2} />);

    expect(iconRenderCount.current).toBe(1);
  });

  it('re-renders when agent goes from undefined to defined (name changes from undefined to string)', () => {
    const { rerender } = render(<MessageIcon iconData={baseIconData} agent={undefined} />);
    iconRenderCount.current = 0;

    rerender(<MessageIcon iconData={baseIconData} agent={makeAgent()} />);

    expect(iconRenderCount.current).toBe(1);
  });

  describe('simulates message lifecycle', () => {
    it('renders exactly twice during new message + streaming start: initial render + modelLabel update', () => {
      const initialIconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: '',
        isCreatedByUser: false,
      };
      const agent = makeAgent();

      const { rerender } = render(<MessageIcon iconData={initialIconData} agent={agent} />);

      const streamingIconData: TMessageIcon = {
        ...initialIconData,
        modelLabel: 'GitHub Agent',
      };

      rerender(<MessageIcon iconData={streamingIconData} agent={agent} />);

      expect(iconRenderCount.current).toBe(2);
    });

    it('does NOT re-render on subsequent streaming chunks (content changes, isSubmitting stays true)', () => {
      const iconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: 'GitHub Agent',
        isCreatedByUser: false,
      };
      const agent = makeAgent();

      const { rerender } = render(<MessageIcon iconData={iconData} agent={agent} />);
      iconRenderCount.current = 0;

      for (let i = 0; i < 5; i++) {
        rerender(<MessageIcon iconData={{ ...iconData }} agent={makeAgent()} />);
      }

      expect(iconRenderCount.current).toBe(0);
    });

    it('does NOT re-render when agentsMap context updates with same agent data', () => {
      const iconData: TMessageIcon = {
        endpoint: EModelEndpoint.agents,
        model: 'agent_123',
        iconURL: undefined,
        modelLabel: 'GitHub Agent',
        isCreatedByUser: false,
      };

      const agent1 = makeAgent();
      const { rerender } = render(<MessageIcon iconData={iconData} agent={agent1} />);
      iconRenderCount.current = 0;

      const agent2 = makeAgent();
      expect(agent1).not.toBe(agent2);
      rerender(<MessageIcon iconData={iconData} agent={agent2} />);

      expect(iconRenderCount.current).toBe(0);
    });
  });
});
