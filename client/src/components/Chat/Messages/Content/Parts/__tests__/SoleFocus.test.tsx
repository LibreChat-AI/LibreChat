import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, render, screen } from '@testing-library/react';
import { SoleToolContext } from '../../disclosure';
import BashCall from '../BashCall';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useProgress: (initialProgress: number) => initialProgress,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  default: ({ onClick, finishedText }: { onClick?: () => void; finishedText: string }) => (
    <button type="button" data-testid="progress-text" onClick={onClick}>
      {finishedText}
    </button>
  ),
}));

const tree = (settled: boolean, announcer = false) => (
  <RecoilRoot>
    <input data-testid="outside" />
    <div data-fold-root="">
      {announcer && <span role="status" data-testid="announcer" />}
      <div className="flex">
        <button type="button" data-testid="group-header">
          {'Group'}
        </button>
      </div>
      <SoleToolContext.Provider value>
        <BashCall
          initialProgress={settled ? 1 : 0.5}
          isSubmitting={!settled}
          args={{ command: 'echo hi' }}
          output={settled ? 'hi' : ''}
          runStepStatus={settled ? 'completed' : undefined}
        />
      </SoleToolContext.Provider>
    </div>
  </RecoilRoot>
);

describe('a sole call that drops its row on completion', () => {
  it('hands keyboard focus to the group header when the focused row goes away', () => {
    const { rerender } = render(tree(false));
    act(() => screen.getByTestId('progress-text').focus());
    expect(screen.getByTestId('progress-text')).toHaveFocus();

    rerender(tree(true));

    expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
    expect(screen.getByTestId('group-header')).toHaveFocus();
  });

  it('finds the header when the fold root leads with a screen-reader announcer', () => {
    const { rerender } = render(tree(false, true));
    act(() => screen.getByTestId('progress-text').focus());

    rerender(tree(true, true));

    expect(screen.getByTestId('group-header')).toHaveFocus();
  });

  it('leaves focus alone when it was somewhere else', () => {
    const { rerender } = render(tree(false));
    act(() => screen.getByTestId('outside').focus());

    rerender(tree(true));

    expect(screen.getByTestId('outside')).toHaveFocus();
  });

  it('leaves focus alone when the row was never focused', () => {
    const { rerender } = render(tree(false));

    rerender(tree(true));

    expect(screen.getByTestId('group-header')).not.toHaveFocus();
  });

  it('announces the settled outcome through a live region that outlives the row', () => {
    const { container, rerender } = render(tree(false));
    const region = () => container.querySelector('[aria-live="polite"]');
    expect(region()).toBeInTheDocument();
    expect(region()).toHaveTextContent('');

    rerender(tree(true));

    expect(region()).toHaveTextContent('com_ui_command_finished');
  });
});
