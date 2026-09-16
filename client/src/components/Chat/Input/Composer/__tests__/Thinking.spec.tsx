import React, { createRef } from 'react';
import { ReasoningEffort } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { SettingDefinition, TConversation, TReasoningOverride } from 'librechat-data-provider';
import type * as ReasoningModule from '../../Reasoning';
import Thinking from '../Thinking';

const mockSetValue = jest.fn();
let mockPendingOverride: TReasoningOverride | undefined;
let mockSetting = {
  key: 'reasoning_effort',
  type: 'enum',
  default: 'low',
  options: ['auto', 'low', 'high'],
} as SettingDefinition;
let mockConversation = {
  conversationId: 'convo-1',
  reasoning_effort: 'low',
} as TConversation;
const mockChatContext = React.createContext<{ conversation: TConversation | null }>({
  conversation: mockConversation,
});

jest.mock('../../Reasoning', () => ({
  ReasoningControl: jest.requireActual<typeof ReasoningModule>('../../Reasoning').ReasoningControl,
  useComposerReasoning: () => ({
    setting: mockSetting,
    value:
      mockPendingOverride ??
      ({
        key: mockSetting.key,
        value: mockConversation[mockSetting.key as keyof TConversation] ?? mockSetting.default,
      } as TReasoningOverride),
    setValue: mockSetValue,
  }),
}));

jest.mock('~/hooks/Generic/useReducedMotion', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, options?: Record<string, string | number>) => {
    if (options) {
      return `${key}:${options['0'] ?? options.count}`;
    }
    return (
      (
        {
          com_ui_auto: 'Auto',
          com_ui_off: 'Off',
          com_ui_low: 'Low',
          com_ui_medium: 'Medium',
          com_ui_high: 'High',
        } as Record<string, string>
      )[key] ?? key
    );
  },
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: { parameters: true } } }),
}));

jest.mock('~/Providers', () => ({
  useChatContext: () =>
    jest.requireActual<typeof import('react')>('react').useContext(mockChatContext),
}));

function renderInComposer({
  disabled = false,
  index = 0,
}: { disabled?: boolean; index?: number } = {}) {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const onComposerClick = jest.fn(() => textareaRef.current?.focus());
  const tree = () => (
    <mockChatContext.Provider value={{ conversation: mockConversation }}>
      <div onClick={onComposerClick}>
        <textarea ref={textareaRef} aria-label="Message input" />
        <Thinking index={index} disabled={disabled} hasAddedConversation={false} />
      </div>
    </mockChatContext.Provider>
  );
  const view = render(tree());
  return { ...view, onComposerClick, rerenderConversation: () => view.rerender(tree()) };
}

describe('Thinking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPendingOverride = undefined;
    mockSetting = {
      key: 'reasoning_effort',
      type: 'enum',
      default: 'low',
      options: ['auto', 'low', 'high'],
    } as unknown as SettingDefinition;
    mockConversation = {
      conversationId: 'convo-1',
      reasoning_effort: 'low',
    } as unknown as TConversation;
  });

  it('forwards the composer disabled state to the enum control', () => {
    renderInComposer({ disabled: true });
    const disclosure = screen.getByTestId('composer-thinking-button');

    expect(disclosure).toBeDisabled();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('stages a numeric budget selected from the secondary composer', () => {
    mockSetting = {
      key: 'thinkingBudget',
      type: 'number',
      default: 4096,
      range: { min: -1, positiveMin: 128, max: 32768, step: 128 },
    } as SettingDefinition;
    renderInComposer({ index: 1 });

    fireEvent.click(screen.getByRole('button', { name: /com_ui_reasoning_for_next_message/ }));
    const slider = screen.getByRole('slider');
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });

    expect(mockSetValue).toHaveBeenLastCalledWith({ key: 'thinkingBudget', value: 4224 });
  });

  it('shows staged one-shot effort without mutating the conversation', () => {
    mockPendingOverride = { key: 'reasoning_effort', value: ReasoningEffort.high };
    renderInComposer();

    expect(screen.getByTestId('composer-thinking-button')).toHaveAccessibleName(
      'com_ui_composer_thinking_value:High',
    );
    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    fireEvent.click(screen.getByRole('radio', { name: 'Low' }));

    expect(mockSetValue).toHaveBeenCalledWith({ key: 'reasoning_effort', value: 'low' });
    expect(mockConversation.reasoning_effort).toBe('low');
  });

  it('keeps activation inside the control and supports arrow-key navigation', () => {
    const { onComposerClick } = renderInComposer();
    const disclosure = screen.getByTestId('composer-thinking-button');

    disclosure.focus();
    fireEvent.click(disclosure);

    expect(onComposerClick).not.toHaveBeenCalled();
    expect(screen.getByRole('radiogroup')).toBeVisible();
    const low = screen.getByRole('radio', { name: 'Low' });
    low.focus();
    expect(low).toHaveFocus();

    fireEvent.keyDown(low, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'High' })).toHaveFocus();
  });

  it('keeps effort selection clicks from reaching the composer focus handler', () => {
    const { onComposerClick } = renderInComposer();

    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    onComposerClick.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'High' }));

    expect(mockSetValue).toHaveBeenCalledWith({ key: 'reasoning_effort', value: 'high' });
    expect(onComposerClick).not.toHaveBeenCalled();
  });

  it('aligns three radio hit areas with the visual stop midpoints', () => {
    mockSetting = {
      key: 'reasoning_effort',
      type: 'enum',
      default: 'low',
      options: ['auto', 'low', 'medium', 'high'],
    } as unknown as SettingDefinition;
    renderInComposer();

    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    const [low, medium, high] = screen.getAllByRole('radio');

    expect(low.style.left).toBe('0px');
    expect(low.style.right).toBe('calc(75% - 7px)');
    expect(medium.style.left).toBe('calc(25% + 7px)');
    expect(medium.style.right).toBe('calc(25% + 7px)');
    expect(high.style.left).toBe('calc(75% - 7px)');
    expect(high.style.right).toBe('0px');
  });

  it('uses the provider mapping for an unset Bedrock effort', () => {
    mockSetting = {
      key: 'reasoning_effort',
      type: 'enum',
      default: 'unset',
      options: ['unset', 'low', 'medium', 'high'],
      enumMappings: {
        unset: 'com_ui_off',
        low: 'com_ui_low',
        medium: 'com_ui_medium',
        high: 'com_ui_high',
      },
    } as unknown as SettingDefinition;
    mockConversation = {
      conversationId: 'convo-1',
      reasoning_effort: 'unset',
    } as unknown as TConversation;
    renderInComposer();

    expect(screen.getByTestId('composer-thinking-button')).toHaveAccessibleName(
      'com_ui_composer_thinking_value:Off',
    );

    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    const off = screen.getByRole('button', { name: 'Off' });
    expect(off).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(off);
    expect(mockSetValue).toHaveBeenCalledWith({ key: 'reasoning_effort', value: 'low' });
  });

  it('does not carry a remembered level across model settings', () => {
    mockConversation = {
      conversationId: 'convo-1',
      endpoint: 'openAI',
      model: 'model-a',
      reasoning_effort: 'high',
    } as unknown as TConversation;
    const { rerenderConversation } = renderInComposer();

    fireEvent.click(screen.getByTestId('composer-thinking-button'));
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('tabindex', '0');

    mockConversation = {
      ...mockConversation,
      reasoning_effort: 'auto',
    } as unknown as TConversation;
    rerenderConversation();
    expect(screen.getByRole('radio', { name: 'High' })).toHaveAttribute('tabindex', '0');

    mockConversation = { ...mockConversation, model: 'model-b' };
    rerenderConversation();
    expect(screen.getByRole('radio', { name: 'Low' })).toHaveAttribute('tabindex', '0');
  });
});
