/**
 * @jest-environment jsdom
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComposerFrameProps } from '../Frame';
import ComposerFrame, { COMPOSER_FOCUS_OWNER_ATTRIBUTE } from '../Frame';

/**
 * The composer layout: the slots land in reading order around the surface, the surface lifts
 * while the draft has focus and carries the temporary accent, and a click on the surface focuses
 * the draft unless a control, a popup or a caller-marked element owns it.
 */

const renderFrame = (props: Partial<ComposerFrameProps> = {}) => {
  const onFocusDraft = jest.fn();
  const onSubmit = jest.fn((event: React.FormEvent) => event.preventDefault());
  const utils = render(
    <ComposerFrame
      onSubmit={onSubmit}
      direction="auto"
      maximizeChatSpace={false}
      focused={false}
      isTemporary={false}
      onFocusDraft={onFocusDraft}
      quote={<span>quote</span>}
      queue={<span>queue</span>}
      contextRail={<span>rail</span>}
      popovers={<span>popovers</span>}
      hints={<span>hints</span>}
      {...props}
    >
      <span>draft</span>
      <button type="button">Send</button>
      <button type="button" aria-haspopup="menu">
        Tools
      </button>
      <span {...{ [COMPOSER_FOCUS_OWNER_ATTRIBUTE]: '' }}>Owned</span>
    </ComposerFrame>,
  );
  return { onFocusDraft, onSubmit, ...utils };
};

describe('ComposerFrame', () => {
  it('lays the slots out in reading order around the surface', () => {
    const { container } = renderFrame();
    const text = container.textContent ?? '';
    const order = ['quote', 'queue', 'rail', 'popovers', 'draft', 'hints'].map((word) =>
      text.indexOf(word),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(screen.getByTestId('composer-surface')).toHaveTextContent('draft');
    expect(screen.getByTestId('composer-context-rail')).toHaveTextContent('rail');
  });

  it.each([undefined, null, false, true])('renders no rail for a %p slot', (contextRail) => {
    renderFrame({ contextRail });
    expect(screen.queryByTestId('composer-context-rail')).toBeNull();
  });

  it('submits through the form and mirrors a forced direction only', () => {
    const { onSubmit, container, rerender } = renderFrame({ direction: 'rtl' });
    const form = container.querySelector('form') as HTMLFormElement;
    expect(form).toHaveAttribute('dir', 'rtl');
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(
      <ComposerFrame
        onSubmit={onSubmit}
        direction="auto"
        maximizeChatSpace
        focused
        isTemporary
        onFocusDraft={jest.fn()}
      >
        <span>draft</span>
      </ComposerFrame>,
    );
    expect(form).not.toHaveAttribute('dir');
    expect(form).toHaveClass('max-w-full');
  });

  it('lifts while focused and carries the temporary accent', () => {
    const { rerender } = renderFrame();
    const surface = screen.getByTestId('composer-surface');
    expect(surface).toHaveClass('shadow-md');
    expect(surface).not.toHaveClass('border-series-6/50');

    rerender(
      <ComposerFrame
        onSubmit={jest.fn()}
        direction="auto"
        maximizeChatSpace={false}
        focused
        isTemporary
        onFocusDraft={jest.fn()}
      >
        <span>draft</span>
      </ComposerFrame>,
    );
    expect(surface).toHaveClass('shadow-lg');
    expect(surface).toHaveClass('border-series-6/50');
  });

  it('focuses the draft on a surface or button click, not on popup triggers or marked elements', () => {
    const { onFocusDraft } = renderFrame();

    fireEvent.click(screen.getByText('draft'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onFocusDraft).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Tools' }));
    fireEvent.click(screen.getByText('Owned'));
    expect(onFocusDraft).toHaveBeenCalledTimes(2);
  });
});
