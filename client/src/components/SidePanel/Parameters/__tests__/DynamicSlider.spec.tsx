import React from 'react';
import { ReasoningEffort } from 'librechat-data-provider';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import type { TSetOption, SettingRange } from 'librechat-data-provider';
import DynamicSlider from '../DynamicSlider';
import { ChatContext } from '~/Providers';

type ChatContextValue = React.ContextType<typeof ChatContext>;

const chatContextValue = { preset: null } as unknown as ChatContextValue;

const range: SettingRange = { min: 0, max: 2, step: 0.01 };

function setup(conversationValue: number) {
  const commit = jest.fn();
  const setOption = jest.fn(() => commit) as unknown as TSetOption;
  render(
    <ChatContext.Provider value={chatContextValue}>
      <DynamicSlider
        settingKey="temperature"
        label="Temperature"
        type="number"
        range={range}
        defaultValue={1}
        setOption={setOption}
        conversation={{ temperature: conversationValue }}
      />
    </ChatContext.Provider>,
  );
  return { slider: screen.getByRole('slider'), commit };
}

const sentinelRange: SettingRange = { min: -1, max: 32768, step: 1, positiveMin: 128 };

function setupSentinel(conversationValue: number) {
  const commit = jest.fn();
  const setOption = jest.fn(() => commit) as unknown as TSetOption;
  render(
    <ChatContext.Provider value={chatContextValue}>
      <DynamicSlider
        settingKey="thinkingBudget"
        label="Thinking budget"
        type="number"
        range={sentinelRange}
        defaultValue={-1}
        setOption={setOption}
        conversation={{ thinkingBudget: conversationValue }}
      />
    </ChatContext.Provider>,
  );
  return { slider: screen.getByRole('slider'), commit };
}

describe('DynamicSlider', () => {
  it('keeps a valid keyboard thumb when a saved enum value is no longer offered', async () => {
    const commit = jest.fn();
    const setOption = jest.fn(() => commit);
    render(
      <ChatContext.Provider value={chatContextValue}>
        <DynamicSlider
          settingKey="reasoning_effort"
          label="Reasoning Effort"
          defaultValue=""
          options={['', 'none', 'low', 'medium', 'high', 'xhigh', 'max']}
          conversation={{ reasoning_effort: ReasoningEffort.minimal }}
          setOption={setOption}
        />
      </ChatContext.Provider>,
    );
    const slider = screen.getByRole('slider', { name: 'Reasoning Effort' });
    expect(slider).toHaveAttribute('aria-valuenow', '0');
    fireEvent.keyDown(slider, { key: 'End' });
    await waitFor(() => expect(commit).toHaveBeenLastCalledWith('max'));
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * The browser dispatches `dblclick` after the second pointer release, so the
   * commit has already flushed by the time the reset is queued. An action
   * clicked in the debounce window would otherwise read the pre-reset value.
   */
  it('commits a double-click reset without waiting for the debounce', () => {
    const { slider, commit } = setup(0.2);

    fireEvent.doubleClick(slider);

    expect(commit).toHaveBeenCalledWith(1);
  });

  it('still lands the reset exactly once after the debounce elapses', () => {
    const { slider, commit } = setup(0.2);

    fireEvent.doubleClick(slider);
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith(1);
  });

  /**
   * A configured sentinel range leaves a gap the track steps straight through,
   * and `generateDynamicSchema` rejects exactly those values, so the UI must not
   * be able to persist one.
   */
  it('lifts a committed value out of the sentinel gap', () => {
    const { slider, commit } = setupSentinel(-1);

    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    expect(commit).toHaveBeenLastCalledWith(128);
  });

  it('leaves a committed value outside the gap alone', () => {
    const { slider, commit } = setupSentinel(2048);

    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    expect(commit).toHaveBeenLastCalledWith(2049);
  });

  /** The adjacent number input reaches the same gap the track does. */
  it('lifts a typed value out of the sentinel gap on blur', () => {
    const { commit } = setupSentinel(-1);
    const input = screen.getByRole('spinbutton');

    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);

    expect(commit).toHaveBeenLastCalledWith(128);
  });

  it('leaves a typed value outside the gap alone on blur', () => {
    const { commit } = setupSentinel(-1);
    const input = screen.getByRole('spinbutton');

    fireEvent.change(input, { target: { value: '2048' } });
    fireEvent.blur(input);

    expect(commit).toHaveBeenLastCalledWith(2048);
  });
});
