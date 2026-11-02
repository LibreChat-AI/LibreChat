/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComposerFieldProps } from '../Field';
import ComposerField from '../Field';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

/** jsdom lays nothing out: give the draft five 20px rows so it counts as scrollable. */
let scrollHeight: jest.SpyInstance;
let computedStyle: jest.SpyInstance;

beforeEach(() => {
  scrollHeight = jest
    .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
    .mockReturnValue(100);
  const real = window.getComputedStyle.bind(window);
  computedStyle = jest.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = real(element);
    if (!(element instanceof HTMLTextAreaElement)) {
      return style;
    }
    return new Proxy(style, {
      get: (target, key) => {
        if (key === 'lineHeight') {
          return '20px';
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
});

afterEach(() => {
  scrollHeight.mockRestore();
  computedStyle.mockRestore();
});

const renderField = (props: Partial<ComposerFieldProps> = {}) => {
  const textAreaRef = { current: null as HTMLTextAreaElement | null };
  const inputRef = jest.fn();
  const onFocus = jest.fn();
  const utils = render(
    <ComposerField
      textAreaRef={textAreaRef}
      inputRef={inputRef}
      ariaLabel="Message input"
      textareaProps={{ id: 'composer', onFocus, defaultValue: 'a\nb\nc\nd\ne' }}
      value={'a\nb\nc\nd\ne'}
      listening={false}
      dictationActive={false}
      locked={false}
      {...props}
    />,
  );
  return { textAreaRef, inputRef, onFocus, ...utils };
};

describe('ComposerField', () => {
  it('names the textarea and hands it to both refs', () => {
    const { textAreaRef, inputRef } = renderField();
    const textarea = screen.getByRole('textbox', { name: 'Message input' });

    expect(textarea).toHaveAttribute('id', 'composer');
    expect(textAreaRef.current).toBe(textarea);
    expect(inputRef).toHaveBeenCalledWith(textarea);
  });

  it('collapses a long draft and expands it again on focus, keeping the same textarea', () => {
    const { onFocus } = renderField();
    const textarea = screen.getByRole('textbox', { name: 'Message input' });

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_collapse_chat' }));
    expect(textarea).toHaveClass('max-h-13');
    expect(screen.getByRole('button', { name: 'com_ui_expand_chat' })).toBeInTheDocument();

    fireEvent.focus(textarea);
    expect(onFocus).toHaveBeenCalled();
    expect(textarea).not.toHaveClass('max-h-13');
    expect(screen.getByRole('textbox', { name: 'Message input' })).toBe(textarea);
  });

  it('offers no collapse while the draft is short or locked behind a question', () => {
    scrollHeight.mockReturnValue(40);
    const { rerender } = renderField({ value: 'short' });
    expect(screen.queryByRole('button', { name: 'com_ui_collapse_chat' })).toBeNull();

    scrollHeight.mockReturnValue(100);
    rerender(
      <ComposerField
        textAreaRef={{ current: null }}
        ariaLabel="Message input"
        textareaProps={{}}
        value={'a\nb\nc\nd\ne'}
        listening={false}
        dictationActive={false}
        locked
      />,
    );
    expect(screen.queryByRole('button', { name: 'com_ui_collapse_chat' })).toBeNull();
    expect(screen.getByRole('textbox')).toHaveAttribute('data-locked', 'true');
  });

  it('marks the textarea while dictation listens', () => {
    window.matchMedia = jest.fn(() => ({
      matches: true,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })) as unknown as typeof window.matchMedia;
    renderField({ listening: true, value: '' });
    expect(screen.getByRole('textbox')).toHaveAttribute('data-listening', 'true');
  });
});
