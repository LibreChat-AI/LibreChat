/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import useLazyCollapseBody from '../useLazyCollapseBody';

const TOGGLE_LABEL = 'toggle';

function Disclosure({
  initialExpanded,
  retainBody = false,
}: {
  initialExpanded: boolean;
  retainBody?: boolean;
}) {
  const [isExpanded, setIsExpanded] = React.useState(initialExpanded);
  const { shouldRenderBody, mountBody, handleTransitionEnd } = useLazyCollapseBody(
    isExpanded,
    retainBody,
  );
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          mountBody();
          setIsExpanded((prev) => !prev);
        }}
      >
        {TOGGLE_LABEL}
      </button>
      <div data-testid="panel" onTransitionEnd={handleTransitionEnd}>
        {shouldRenderBody && <div data-testid="body" />}
      </div>
    </div>
  );
}

describe('useLazyCollapseBody', () => {
  it('leaves a collapsed-by-default body unmounted', () => {
    render(<Disclosure initialExpanded={false} />);
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('mounts an expanded-by-default body immediately', () => {
    render(<Disclosure initialExpanded={true} />);
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('mounts in the same commit as a user expand', () => {
    render(<Disclosure initialExpanded={false} />);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('keeps the body through the collapse transition, then releases it', () => {
    render(<Disclosure initialExpanded={false} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByTestId('body')).toBeInTheDocument();

    fireEvent.transitionEnd(screen.getByTestId('panel'));
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  describe('when no transition ends', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    /** Opened and closed inside one frame: the panel never left its collapsed size, so
     *  nothing transitions and the event the release waits on never comes. */
    it('releases the body of a panel closed before its opening began', () => {
      render(<Disclosure initialExpanded={false} />);
      const toggle = screen.getByRole('button');
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(screen.getByTestId('body')).toBeInTheDocument();

      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.queryByTestId('body')).not.toBeInTheDocument();
    });

    it('sets no timer for a panel that was never opened', () => {
      const timers = jest.spyOn(globalThis, 'setTimeout');
      render(<Disclosure initialExpanded={false} />);
      expect(timers).not.toHaveBeenCalled();
      timers.mockRestore();
    });

    it('keeps the body of a panel opened again before the wait is over', () => {
      render(<Disclosure initialExpanded={false} />);
      const toggle = screen.getByRole('button');
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      act(() => {
        jest.advanceTimersByTime(200);
      });
      fireEvent.click(toggle);

      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByTestId('body')).toBeInTheDocument();
    });

    it('holds a retained body until retention clears', () => {
      const view = render(<Disclosure initialExpanded={false} retainBody />);
      const toggle = screen.getByRole('button');
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(screen.getByTestId('body')).toBeInTheDocument();

      view.rerender(<Disclosure initialExpanded={false} retainBody={false} />);
      expect(screen.queryByTestId('body')).not.toBeInTheDocument();
    });
  });

  it('ignores transition events bubbling from descendants', () => {
    render(<Disclosure initialExpanded={false} />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    fireEvent.transitionEnd(screen.getByTestId('body'));
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('does not release the body when a transition ends while expanded', () => {
    render(<Disclosure initialExpanded={true} />);
    fireEvent.transitionEnd(screen.getByTestId('panel'));
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });

  it('retains the body across a collapse while retainBody is set', () => {
    const view = render(<Disclosure initialExpanded={false} retainBody />);
    const toggle = screen.getByRole('button');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.transitionEnd(screen.getByTestId('panel'));
    expect(screen.getByTestId('body')).toBeInTheDocument();

    view.rerender(<Disclosure initialExpanded={false} retainBody={false} />);
    expect(screen.queryByTestId('body')).not.toBeInTheDocument();
  });

  it('keeps an expanded body mounted when retention clears', () => {
    const view = render(<Disclosure initialExpanded={false} retainBody />);
    fireEvent.click(screen.getByRole('button'));
    view.rerender(<Disclosure initialExpanded={false} retainBody={false} />);
    expect(screen.getByTestId('body')).toBeInTheDocument();
  });
});
