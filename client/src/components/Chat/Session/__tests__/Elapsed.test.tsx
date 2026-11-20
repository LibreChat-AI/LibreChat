import React, { Profiler } from 'react';
import { act, render, screen } from '@testing-library/react';
import Elapsed from '../Elapsed';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) =>
    `${key}:${Object.values(values ?? {}).join(',')}`,
}));

describe('Elapsed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('counts the seconds as they pass, redrawing only itself', () => {
    const start = Date.now() - 5_000;
    let siblingRenders = 0;
    const Sibling = () => {
      siblingRenders += 1;
      return <p data-testid="sibling" />;
    };
    let commits = 0;
    render(
      <Profiler id="row" onRender={() => (commits += 1)}>
        <Sibling />
        <Elapsed startedAt={start} />
        <Elapsed startedAt={start - 60_000} />
      </Profiler>,
    );
    const texts = () => screen.getAllByLabelText(/./).map((node) => node.textContent);
    expect(texts()).toEqual(['com_ui_duration_seconds:5', 'com_ui_duration_minutes:1,5']);
    const settled = commits;

    for (let second = 0; second < 3; second += 1) {
      act(() => {
        jest.advanceTimersByTime(1_000);
      });
    }
    expect(texts()).toEqual(['com_ui_duration_seconds:8', 'com_ui_duration_minutes:1,8']);
    /** One commit a second for every reader together, and nothing beside them renders. */
    expect(commits - settled).toBe(3);
    expect(siblingRenders).toBe(1);
  });

  it('keeps one timer for every reader and none once the last is gone', () => {
    const first = render(<Elapsed startedAt={Date.now()} />);
    const second = render(<Elapsed startedAt={Date.now()} />);
    expect(jest.getTimerCount()).toBe(1);
    first.unmount();
    expect(jest.getTimerCount()).toBe(1);
    second.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts a later reader from the present, not from when the clock last ran', () => {
    render(<Elapsed startedAt={Date.now()} />).unmount();
    act(() => {
      jest.advanceTimersByTime(90_000);
    });
    render(<Elapsed startedAt={Date.now() - 2_000} />);
    expect(screen.getByLabelText(/./)).toHaveTextContent('com_ui_duration_seconds:2');
  });
});
