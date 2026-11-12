import { render } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import { useActivePanel } from '~/Providers';
import Nav from '../Nav';

jest.mock('~/Providers', () => ({
  useActivePanel: jest.fn(),
  resolveActivePanel: (active: string) => active,
}));

const link = (id: string): NavLink =>
  ({
    id,
    title: 'com_sidepanel_agent_builder',
    icon: () => null,
    Component: () => <div data-testid={id} />,
  }) as NavLink;

const renderNav = (active: string) => {
  jest.mocked(useActivePanel).mockReturnValue({ active } as never);
  return render(<Nav links={[link(EModelEndpoint.agents), link('prompts')]} />);
};

describe('Nav', () => {
  it('reserves the scrollbar gutter for the agent builder so its width does not jump', () => {
    const { container } = renderNav(EModelEndpoint.agents);
    expect(container.firstElementChild).toHaveClass('scrollbar-gutter-stable');
  });

  it('leaves other panels as they were', () => {
    const { container } = renderNav('prompts');
    expect(container.firstElementChild).not.toHaveClass('scrollbar-gutter-stable');
  });
});
