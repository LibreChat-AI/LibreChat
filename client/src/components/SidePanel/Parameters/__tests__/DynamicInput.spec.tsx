import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { TSetOption, SettingRange } from 'librechat-data-provider';
import DynamicInput from '../DynamicInput';
import { ChatContext } from '~/Providers';

type ChatContextValue = React.ContextType<typeof ChatContext>;

const chatContextValue = { preset: null } as unknown as ChatContextValue;

function setup({
  type,
  range,
  settingKey,
  conversation = {},
}: {
  type: 'number' | 'string';
  range?: SettingRange;
  settingKey: string;
  conversation?: Record<string, unknown>;
}) {
  const commit = jest.fn();
  const setOption = jest.fn(() => commit) as unknown as TSetOption;
  render(
    <ChatContext.Provider value={chatContextValue}>
      <DynamicInput
        settingKey={settingKey}
        type={type}
        range={range}
        setOption={setOption}
        conversation={conversation}
      />
    </ChatContext.Provider>,
  );
  return { input: screen.getByRole('textbox'), commit };
}

function setupNavigable(range: SettingRange, conversation: Record<string, unknown>) {
  const commit = jest.fn();
  const setOption = jest.fn(() => commit) as unknown as TSetOption;
  const tree = (next: Record<string, unknown>) => (
    <ChatContext.Provider value={chatContextValue}>
      <DynamicInput
        settingKey="thinkingBudget"
        type="number"
        range={range}
        setOption={setOption}
        conversation={next}
      />
    </ChatContext.Provider>
  );
  const { rerender } = render(tree(conversation));
  return {
    commit,
    input: () => screen.getByRole('textbox'),
    navigate: (next: Record<string, unknown>) => rerender(tree(next)),
  };
}

describe('DynamicInput', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('strips typed non-numeric text for number settings', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { input, commit } = setup({ type: 'number', settingKey: 'max_tokens' });

    await user.type(input, 'System');

    expect(input).toHaveValue('');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith('');
  });

  it('strips pasted or autofilled non-numeric text for number settings', () => {
    const { input, commit } = setup({ type: 'number', settingKey: 'max_tokens' });

    fireEvent.change(input, { target: { value: 'System' } });

    expect(input).toHaveValue('');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith('');
  });

  it('commits numeric input as a number for number settings', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { input, commit } = setup({ type: 'number', settingKey: 'max_tokens' });

    await user.type(input, '4096');

    expect(input).toHaveValue('4096');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(4096);
  });

  it('strips thousands separators from pasted values', () => {
    const { input, commit } = setup({ type: 'number', settingKey: 'maxContextTokens' });

    fireEvent.change(input, { target: { value: '120,000' } });

    expect(input).toHaveValue('120000');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(120000);
  });

  it('allows typing negative numbers when the range permits (e.g. thinkingBudget -1)', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 24576, step: 1 },
      settingKey: 'thinkingBudget',
    });

    await user.type(input, '-1');

    expect(input).toHaveValue('-1');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(-1);
  });

  it('keeps thinkingBudget -1 on blur when a model-specific positive floor is set', () => {
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 32768, step: 1, positiveMin: 128 },
      settingKey: 'thinkingBudget',
    });

    fireEvent.change(input, { target: { value: '-1' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('-1');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(-1);
  });

  /**
   * A preset saved while the shared range was in force can hold a budget the
   * selected model rejects. Waiting for a model switch or a blur would leave it
   * displayed, savable and sendable.
   */
  it('normalizes a stored value the selected model no longer allows on mount', () => {
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 24576, step: 1, positiveMin: 0, modelSpecific: true },
      settingKey: 'thinkingBudget',
      conversation: { thinkingBudget: 32000 },
    });

    expect(input).toHaveValue('24576');
    expect(commit).toHaveBeenLastCalledWith(24576);
  });

  it('leaves a stored value inside the model range untouched on mount', () => {
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 24576, step: 1, positiveMin: 0, modelSpecific: true },
      settingKey: 'thinkingBudget',
      conversation: { thinkingBudget: 2048 },
    });

    expect(input).toHaveValue('2048');
    expect(commit).not.toHaveBeenCalled();
  });

  /** The shared fallback stays in place for models that ignore the parameter,
   *  so clamping to it would discard a value set for another model. */
  it('does not normalize on mount against a range the model did not narrow', () => {
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 24576, step: 1 },
      settingKey: 'thinkingBudget',
      conversation: { thinkingBudget: 32000 },
    });

    expect(input).toHaveValue('32000');
    expect(commit).not.toHaveBeenCalled();
  });

  /**
   * The panel stays mounted across conversations, so a legacy value can arrive
   * under a range that never changed. Keying only on the range left it above
   * the model ceiling, savable and sendable.
   */
  it('normalizes when a navigation brings in a value the same range rejects', () => {
    const range: SettingRange = {
      min: -1,
      max: 24576,
      step: 1,
      positiveMin: 0,
      modelSpecific: true,
    };
    const { navigate, input, commit } = setupNavigable(range, {
      conversationId: 'convo-a',
      thinkingBudget: 2048,
    });
    expect(commit).not.toHaveBeenCalled();

    navigate({ conversationId: 'convo-b', thinkingBudget: 32000 });

    expect(input()).toHaveValue('24576');
    expect(commit).toHaveBeenLastCalledWith(24576);
  });

  it('leaves a navigation alone when the incoming value fits the range', () => {
    const range: SettingRange = {
      min: -1,
      max: 24576,
      step: 1,
      positiveMin: 0,
      modelSpecific: true,
    };
    const { navigate, commit } = setupNavigable(range, {
      conversationId: 'convo-a',
      thinkingBudget: 2048,
    });

    navigate({ conversationId: 'convo-b', thinkingBudget: 4096 });

    expect(commit).not.toHaveBeenCalled();
  });

  /**
   * Applying a preset over the open conversation keeps the conversation id and
   * the model, so neither key moves; the value simply arrives.
   */
  it('normalizes a stored value replaced under an unchanged conversation', () => {
    const range: SettingRange = {
      min: -1,
      max: 24576,
      step: 1,
      positiveMin: 0,
      modelSpecific: true,
    };
    const { navigate, input, commit } = setupNavigable(range, {
      conversationId: 'convo-a',
      thinkingBudget: 2048,
    });

    navigate({ conversationId: 'convo-a', thinkingBudget: 32000 });

    expect(input()).toHaveValue('24576');
    expect(commit).toHaveBeenLastCalledWith(24576);
  });

  /**
   * A typed value reaches the conversation through this same field, so the two
   * agree by the time it lands. Correcting it there would fight the user
   * mid-edit, which is why clamping belongs on blur.
   */
  it('leaves the value the user typed to the blur clamp when it lands', () => {
    const range: SettingRange = {
      min: -1,
      max: 32768,
      step: 1,
      positiveMin: 128,
      modelSpecific: true,
    };
    const { navigate, input, commit } = setupNavigable(range, {
      conversationId: 'convo-a',
      thinkingBudget: 2048,
    });

    fireEvent.change(input(), { target: { value: '50' } });
    /** The debounced write reaching the conversation, which is what the
     *  normalization would otherwise read as an external replacement. */
    navigate({ conversationId: 'convo-a', thinkingBudget: 50 });

    expect(input()).toHaveValue('50');
    expect(commit).not.toHaveBeenCalledWith(128);
  });

  it('clamps a positive thinkingBudget below the model floor on blur', () => {
    const { input, commit } = setup({
      type: 'number',
      range: { min: -1, max: 32768, step: 1, positiveMin: 128 },
      settingKey: 'thinkingBudget',
    });

    fireEvent.change(input, { target: { value: '50' } });
    fireEvent.blur(input);

    expect(input).toHaveValue('128');
    expect(commit).toHaveBeenLastCalledWith(128);
  });

  it('drops the minus sign when the range does not permit negatives', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { input, commit } = setup({ type: 'number', settingKey: 'max_tokens' });

    await user.type(input, '-1');

    expect(input).toHaveValue('1');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(1);
  });

  it('commits digit-only input as a string for string settings', async () => {
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    const { input, commit } = setup({ type: 'string', settingKey: 'modelLabel' });

    await user.type(input, '123');

    expect(input).toHaveValue('123');
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith('123');
  });

  it('preserves the numeric sniffing fallback when no type is provided', () => {
    const commit = jest.fn();
    const setOption = jest.fn(() => commit) as unknown as TSetOption;
    render(
      <ChatContext.Provider value={chatContextValue}>
        <DynamicInput settingKey="custom" setOption={setOption} conversation={{}} />
      </ChatContext.Provider>,
    );
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: '42' } });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(commit).toHaveBeenLastCalledWith(42);
  });
});
