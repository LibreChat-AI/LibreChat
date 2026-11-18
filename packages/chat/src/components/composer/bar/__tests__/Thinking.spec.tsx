/**
 * @jest-environment jsdom
 */
import React, { createRef } from 'react';
import { ComponentTypes, ReasoningEffort } from 'librechat-data-provider';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SettingDefinition, TConversation, TReasoningOverride } from 'librechat-data-provider';
import { initEnglish } from '../../../../__fixtures__/i18n';
import ThinkingControl from '../Thinking';

/**
 * The thinking-level button: it names the level the next turn runs at, rolls the label up or
 * down when that level changes, and hands a pick from its popup back to the host without the
 * click reaching the composer behind it.
 */

const effort: SettingDefinition = {
  key: 'reasoning_effort',
  type: 'enum',
  component: ComponentTypes.Slider,
  default: 'low',
  options: ['', 'low', 'high'],
};

const conversation: TConversation = {
  conversationId: 'convo-1',
  endpoint: null,
  title: null,
  createdAt: '',
  updatedAt: '',
  reasoning_effort: ReasoningEffort.low,
};

type Props = {
  setting?: SettingDefinition;
  value?: TReasoningOverride;
  disabled?: boolean;
  stored?: TConversation | null;
};

function renderControl({
  setting = effort,
  value,
  disabled = false,
  stored = conversation,
}: Props = {}) {
  const onChange = jest.fn();
  const onComposerClick = jest.fn();
  const textareaRef = createRef<HTMLTextAreaElement>();
  const tree = (next: Props) => (
    <div onClick={onComposerClick}>
      <textarea ref={textareaRef} aria-label="Message input" />
      <ThinkingControl
        index={0}
        setting={next.setting ?? setting}
        conversation={next.stored === undefined ? stored : next.stored}
        value={next.value}
        disabled={next.disabled ?? disabled}
        onChange={onChange}
      />
    </div>
  );
  const view = render(tree({ value }));
  return {
    ...view,
    onChange,
    onComposerClick,
    rerenderWith: (next: Props) => view.rerender(tree(next)),
  };
}

beforeAll(async () => {
  await initEnglish();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    }),
  });
});

describe('ThinkingControl', () => {
  it('names the stored level and disables the trigger with the composer', () => {
    renderControl({ disabled: true });
    const trigger = screen.getByTestId('composer-thinking-button');

    expect(trigger).toHaveAccessibleName('Thinking: Low');
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('names a staged value over the stored one and reads Auto when nothing is set', () => {
    const { rerenderWith } = renderControl({
      value: { key: 'reasoning_effort', value: ReasoningEffort.high },
    });
    const trigger = screen.getByTestId('composer-thinking-button');
    expect(trigger).toHaveAccessibleName('Thinking: High');

    rerenderWith({ stored: null, setting: { ...effort, default: undefined } });
    expect(trigger).toHaveAccessibleName('Thinking: Auto');
  });

  it('rolls the label up for a higher level and down for a lower one', () => {
    const { rerenderWith } = renderControl();
    const trigger = screen.getByTestId('composer-thinking-button');
    expect(trigger.querySelector('[class*="composer-label-"]')).toBeNull();

    rerenderWith({ value: { key: 'reasoning_effort', value: ReasoningEffort.high } });
    expect(trigger.querySelector('.composer-label-in-up')).toHaveTextContent('High');
    expect(trigger.querySelector('.composer-label-out-up')).toHaveTextContent('Low');

    rerenderWith({ value: { key: 'reasoning_effort', value: ReasoningEffort.unset } });
    expect(trigger.querySelector('.composer-label-in-down')).toHaveTextContent('Auto');
    expect(trigger.querySelector('.composer-label-out-down')).toHaveTextContent('High');
  });

  it('drops the outgoing word even when no stylesheet animates it', () => {
    jest.useFakeTimers();
    try {
      const { rerenderWith } = renderControl();
      const trigger = screen.getByTestId('composer-thinking-button');

      rerenderWith({ value: { key: 'reasoning_effort', value: ReasoningEffort.high } });
      expect(trigger.querySelector('.composer-label-out-up')).toHaveTextContent('Low');

      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(trigger.querySelector('.composer-label-out-up')).toBeNull();
      expect(trigger.querySelector('.composer-label-in-up')).toHaveTextContent('High');
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands a pick to the host without the click reaching the composer', async () => {
    const { onChange, onComposerClick } = renderControl();

    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    expect(onComposerClick).not.toHaveBeenCalled();
    const low = screen.getByRole('radio', { name: 'Low' });
    await waitFor(() => expect(low).toHaveFocus());

    fireEvent.click(screen.getByRole('radio', { name: 'High' }));
    expect(onChange).toHaveBeenCalledWith({ key: 'reasoning_effort', value: ReasoningEffort.high });
    expect(onComposerClick).not.toHaveBeenCalled();
  });

  it('closes from a second click on its own trigger', async () => {
    renderControl();
    const trigger = screen.getByTestId('composer-thinking-button');

    fireEvent.click(trigger);
    expect(screen.getByRole('radiogroup')).toBeVisible();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument());
  });

  it('labels a mapped value with its provider mapping', () => {
    renderControl({
      setting: {
        key: 'reasoning_effort',
        type: 'enum',
        component: ComponentTypes.Slider,
        default: 'unset',
        options: ['unset', 'low', 'high'],
        enumMappings: { unset: 'com_ui_off', low: 'com_ui_low', high: 'com_ui_high' },
      },
      stored: null,
    });

    expect(screen.getByTestId('composer-thinking-button')).toHaveAccessibleName('Thinking: Off');
  });
});
