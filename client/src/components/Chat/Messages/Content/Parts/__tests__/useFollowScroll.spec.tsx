import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import useFollowScroll from '../useFollowScroll';

function Probe({
  content,
  active,
  expanded,
}: {
  content: string | readonly React.ReactNode[];
  active: boolean;
  expanded: boolean;
}) {
  const { ref, onScroll } = useFollowScroll<HTMLDivElement>(content, active, expanded);
  return (
    <div data-testid="pane" ref={ref} onScroll={onScroll}>
      {content}
    </div>
  );
}

/**
 * jsdom has no layout, so scroll geometry is stubbed: `scrollHeight` reads
 * from mutable state (grown by the test as content streams) and every
 * `scrollTop` write the hook makes is recorded. Direct mutations of the
 * returned state bypass the element setter, so `writes` only ever contains
 * scrolls the hook itself performed.
 */
const mockScrollMetrics = (el: HTMLElement, clientHeight: number) => {
  const state = { scrollHeight: 0, scrollTop: 0, writes: [] as number[] };
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => state.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
      state.writes.push(value);
    },
  });
  return state;
};

describe('useFollowScroll', () => {
  const setup = ({
    active = true,
    expanded = true,
  }: { active?: boolean; expanded?: boolean } = {}) => {
    const utils = render(<Probe content="a" active={active} expanded={expanded} />);
    const pane = utils.getByTestId('pane');
    const state = mockScrollMetrics(pane, 300);
    state.scrollHeight = 900;
    return { ...utils, pane, state };
  };

  it('pins to the bottom when content changes while active and expanded', () => {
    const { rerender, state } = setup();
    rerender(<Probe content="ab" active expanded />);
    expect(state.scrollTop).toBe(900);
  });

  it('re-pins on every delta as the content keeps growing', () => {
    const { rerender, state } = setup();
    rerender(<Probe content="ab" active expanded />);
    state.scrollHeight = 1200;
    rerender(<Probe content="abc" active expanded />);
    expect(state.scrollTop).toBe(1200);
  });

  it('re-pins when the rendered node identity changes for the same source text', () => {
    const utils = render(<Probe content={['abc']} active expanded />);
    const pane = utils.getByTestId('pane');
    const state = mockScrollMetrics(pane, 300);
    state.scrollHeight = 900;
    utils.rerender(<Probe content={['abc']} active expanded />);
    expect(state.writes).toEqual([900]);
  });

  it('never scrolls while inactive', () => {
    const { rerender, state } = setup({ active: false });
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toHaveLength(0);
  });

  it('never scrolls a collapsed pane, even while content streams', () => {
    const { rerender, state } = setup({ expanded: false });
    rerender(<Probe content="ab" active expanded={false} />);
    expect(state.writes).toHaveLength(0);
  });

  it('pins immediately when the pane is expanded mid-stream', () => {
    const { rerender, state } = setup({ expanded: false });
    rerender(<Probe content="ab" active expanded={false} />);
    expect(state.writes).toHaveLength(0);
    rerender(<Probe content="ab" active expanded />);
    expect(state.writes).toEqual([900]);
  });

  it('leaves a finished pane at the top when it is expanded for the first time', () => {
    const { rerender, state } = setup({ expanded: false });
    rerender(<Probe content="ab" active expanded={false} />);
    rerender(<Probe content="ab" active={false} expanded={false} />);
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toHaveLength(0);
  });

  it('stops pinning once the stream ends', () => {
    const { rerender, state } = setup();
    rerender(<Probe content="ab" active expanded />);
    expect(state.writes).toEqual([900]);
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toEqual([900]);
  });

  /** A failing PTC call settles by appending its error line in the same
   *  commit that clears the last running row, so the growth and the end of
   *  the stream arrive together. */
  it('pins one last time when the change that ends the stream also adds content', () => {
    const { rerender, state } = setup();
    state.scrollHeight = 1200;
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toEqual([1200]);
  });

  it('does not pin the settling change for a reader who scrolled up', () => {
    const { rerender, pane, state } = setup();
    state.scrollTop = 100;
    fireEvent.scroll(pane);
    state.scrollHeight = 1200;
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toHaveLength(0);
  });

  it('pins only the settling change, not the ones after it', () => {
    const { rerender, state } = setup();
    rerender(<Probe content="ab" active={false} expanded />);
    expect(state.writes).toEqual([900]);
    state.scrollHeight = 1200;
    rerender(<Probe content="abc" active={false} expanded />);
    expect(state.writes).toEqual([900]);
  });

  it('detaches when the user scrolls up beyond the follow threshold', () => {
    const { rerender, pane, state } = setup();
    state.scrollTop = 100;
    fireEvent.scroll(pane);
    rerender(<Probe content="ab" active expanded />);
    expect(state.writes).toHaveLength(0);
  });

  it('stays attached at exactly the threshold distance', () => {
    const { rerender, pane, state } = setup();
    state.scrollTop = 560;
    fireEvent.scroll(pane);
    rerender(<Probe content="ab" active expanded />);
    expect(state.scrollTop).toBe(900);
  });

  it('re-attaches when the user returns to the bottom', () => {
    const { rerender, pane, state } = setup();
    state.scrollTop = 100;
    fireEvent.scroll(pane);
    rerender(<Probe content="ab" active expanded />);
    expect(state.writes).toHaveLength(0);
    state.scrollTop = 590;
    fireEvent.scroll(pane);
    rerender(<Probe content="abc" active expanded />);
    expect(state.writes).toEqual([900]);
  });
});
