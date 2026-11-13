import { lazy } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import { act, render, screen } from '@testing-library/react';
import type { NavLink } from '~/common';
import { useActivePanel } from '~/Providers';
import Nav from '../Nav';

jest.mock('~/Providers', () => ({
  useActivePanel: jest.fn(),
  resolveActivePanel: (active: string) => active,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
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
  it.each([EModelEndpoint.agents, 'prompts'])(
    'keeps the %s panel layout stable while its lazy content loads',
    async (active) => {
      let resolvePanel!: (module: { default: () => JSX.Element }) => void;
      const LazyPanel = lazy(
        () =>
          new Promise<{ default: () => JSX.Element }>((resolve) => {
            resolvePanel = resolve;
          }),
      );
      jest.mocked(useActivePanel).mockReturnValue({ active } as never);
      const { container } = render(<Nav links={[{ ...link(active), Component: LazyPanel }]} />);

      expect(screen.getByRole('status')).toHaveTextContent('com_ui_loading');
      expect(container.firstElementChild?.classList.contains('scrollbar-gutter-stable')).toBe(
        active === EModelEndpoint.agents,
      );

      await act(async () => {
        resolvePanel({ default: () => <div data-testid="loaded-panel" /> });
      });

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByTestId('loaded-panel')).toBeInTheDocument();
      expect(container.firstElementChild?.classList.contains('scrollbar-gutter-stable')).toBe(
        active === EModelEndpoint.agents,
      );
    },
  );

  it('reserves the scrollbar gutter for the agent builder so its width does not jump', () => {
    const { container } = renderNav(EModelEndpoint.agents);
    expect(container.firstElementChild).toHaveClass('scrollbar-gutter-stable');
  });

  it('leaves other panels as they were', () => {
    const { container } = renderNav('prompts');
    expect(container.firstElementChild).not.toHaveClass('scrollbar-gutter-stable');
  });
});
