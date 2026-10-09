import React, { Profiler } from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { act, render, screen, fireEvent } from '@testing-library/react';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

import QuoteButton from '../QuoteButton';
import store from '~/store';
import { mainTextareaId } from '~/common';

const CONVO_ID = 'convo-1';
const SELECTED_TEXT = 'Selected assistant text';

const rect = ({
  top,
  bottom,
  left,
  right,
}: {
  top: number;
  bottom: number;
  left: number;
  right: number;
}): DOMRect =>
  ({
    top,
    bottom,
    left,
    right,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  }) as DOMRect;

function Quotes() {
  const quotes = useRecoilValue(store.pendingQuotesByConvoId(CONVO_ID));
  return <output data-testid="quotes">{JSON.stringify(quotes)}</output>;
}

function pointer(target: Document | HTMLElement, type: string) {
  const event = new MouseEvent(type, { bubbles: true, clientX: 50, clientY: 15 });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  fireEvent(target, event);
}

describe('QuoteButton', () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it('shows, moves, and dismisses selections without React commits, then commits a touch quote', () => {
    jest.useFakeTimers();
    let rangeRect = rect({ top: 100, bottom: 120, left: 200, right: 260 });
    const buttonRect = rect({ top: 0, bottom: 30, left: 0, right: 100 });
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    const elementRect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this instanceof HTMLButtonElement
          ? buttonRect
          : rect({ top: 0, bottom: 0, left: 0, right: 0 });
      });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rangeRect,
    });

    try {
      const onRender = jest.fn();
      render(
        <RecoilRoot>
          <div className="message-render">{SELECTED_TEXT}</div>
          <textarea id={mainTextareaId} />
          <Quotes />
          <Profiler id="quote-button" onRender={onRender}>
            <QuoteButton conversationId={CONVO_ID} />
          </Profiler>
        </RecoilRoot>,
      );

      onRender.mockClear();
      const textNode = screen.getByText(SELECTED_TEXT).firstChild;
      if (!textNode) {
        throw new Error('Selection text node was not rendered');
      }
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, SELECTED_TEXT.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);

      fireEvent.mouseUp(document);

      expect(screen.getByTestId('add-to-chat-button')).toHaveStyle({
        top: '62px',
        left: '180px',
      });
      const button = screen.getByTestId('add-to-chat-button');
      expect(button).toBeVisible();
      expect(onRender).not.toHaveBeenCalled();

      rangeRect = rect({ top: 200, bottom: 220, left: 200, right: 260 });
      fireEvent.scroll(document);
      act(() => jest.advanceTimersByTime(20));
      expect(button).toHaveStyle({ top: '162px' });
      expect(onRender).not.toHaveBeenCalled();

      window.getSelection()?.removeAllRanges();
      fireEvent(document, new Event('selectionchange'));
      expect(button).not.toBeVisible();
      expect(onRender).not.toHaveBeenCalled();

      pointer(document, 'pointerdown');
      window.getSelection()?.addRange(range);
      fireEvent(document, new Event('selectionchange'));
      act(() => jest.advanceTimersByTime(300));
      expect(button).toBeVisible();
      expect(button).toHaveAttribute('data-touch', 'true');
      expect(button).toHaveStyle({ top: '228px' });

      range.setEnd(textNode, 8);
      fireEvent(document, new Event('selectionchange'));
      expect(button).not.toBeVisible();
      act(() => jest.advanceTimersByTime(300));
      expect(button).toBeVisible();
      expect(onRender).not.toHaveBeenCalled();

      pointer(button, 'pointerdown');
      window.getSelection()?.removeAllRanges();
      fireEvent(document, new Event('selectionchange'));
      expect(button).toBeVisible();
      pointer(button, 'pointerup');
      expect(button).not.toBeVisible();
      expect(screen.getByTestId('quotes')).toHaveTextContent('["Selected"]');
      expect(screen.getByRole('textbox')).toHaveFocus();
    } finally {
      jest.useRealTimers();
      elementRect.mockRestore();
      if (originalRangeRect) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
          configurable: true,
          value: originalRangeRect,
        });
      } else {
        delete (Range.prototype as Partial<Range>).getBoundingClientRect;
      }
    }
  });

  it.each([true, false])(
    'anchors a selection crossing code and prose when code comes first: %s',
    (codeFirst) => {
      jest.useFakeTimers();
      const codeText = 'wide code '.repeat(30);
      const proseText = 'Selected prose remains visible';
      let codeLeft = 140;
      const originalRangeRect = Range.prototype.getBoundingClientRect;
      const elementRect = jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement) {
          if (this instanceof HTMLButtonElement) {
            return rect({ top: 0, bottom: 30, left: 0, right: 100 });
          }
          if (this.tagName === 'PRE') {
            return rect({ top: codeFirst ? 95 : 195, bottom: 260, left: 100, right: 400 });
          }
          return rect({ top: 80, bottom: 500, left: 90, right: 650 });
        });

      try {
        render(
          <RecoilRoot>
            <div className="message-render" style={{ overflow: 'auto' }}>
              {codeFirst ? (
                <>
                  <pre style={{ overflowX: 'auto' }}>
                    <code>{codeText}</code>
                  </pre>
                  <p>{proseText}</p>
                </>
              ) : (
                <>
                  <p>{proseText}</p>
                  <pre style={{ overflowX: 'auto' }}>
                    <code>{codeText}</code>
                  </pre>
                </>
              )}
            </div>
            <textarea id={mainTextareaId} />
            <Quotes />
            <QuoteButton conversationId={CONVO_ID} />
          </RecoilRoot>,
        );
        const code = document.querySelector('.message-render code')?.firstChild;
        const prose = screen.getByText(proseText).firstChild;
        if (!code || !prose) {
          throw new Error('Selection text nodes were not rendered');
        }
        const range = document.createRange();
        const first = codeFirst ? code : prose;
        const last = codeFirst ? prose : code;
        range.setStart(first, 0);
        range.setEnd(last, last.textContent?.length ?? 0);
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
          configurable: true,
          value: function (this: Range) {
            if (this.startContainer === code && this.endContainer === code) {
              return rect({
                top: codeFirst ? 100 : 200,
                bottom: codeFirst ? 120 : 220,
                left: codeLeft,
                right: codeLeft + 100,
              });
            }
            if (this.startContainer === prose && this.endContainer === prose) {
              return rect({
                top: codeFirst ? 200 : 100,
                bottom: codeFirst ? 220 : 120,
                left: 460,
                right: 480,
              });
            }
            return rect({ top: 100, bottom: 220, left: codeLeft, right: 480 });
          },
        });
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        const quote = window.getSelection()?.toString().trim();
        expect(quote).toContain(codeText.trim());
        expect(quote).toContain(proseText);

        fireEvent.mouseUp(document);
        const button = screen.getByTestId('add-to-chat-button');
        expect(button).toHaveStyle({ left: '260px', top: '62px' });

        codeLeft = -400;
        const scroller = code.parentElement?.closest('pre');
        if (!scroller) {
          throw new Error('Code scroller was not rendered');
        }
        fireEvent.scroll(scroller);
        act(() => jest.advanceTimersByTime(20));
        expect(button).toHaveStyle({ left: '420px', top: codeFirst ? '162px' : '62px' });
        fireEvent.click(button);
        expect(JSON.parse(screen.getByTestId('quotes').textContent ?? '[]')).toEqual([quote]);
      } finally {
        jest.useRealTimers();
        elementRect.mockRestore();
        if (originalRangeRect) {
          Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: originalRangeRect,
          });
        } else {
          delete (Range.prototype as Partial<Range>).getBoundingClientRect;
        }
      }
    },
  );

  it('anchors a long code selection to its visible portion inside nested scrollers', () => {
    jest.useFakeTimers();
    const codeLine = 'set -e; git fetch '.repeat(40);
    let rangeRect = rect({ top: 100, bottom: 120, left: 140, right: 2200 });
    const originalRangeRect = Range.prototype.getBoundingClientRect;
    const elementRect = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this instanceof HTMLButtonElement) {
          return rect({ top: 0, bottom: 30, left: 0, right: 100 });
        }
        if (this.tagName === 'PRE') {
          return rect({ top: 95, bottom: 180, left: 100, right: 400 });
        }
        return rect({ top: 80, bottom: 500, left: 90, right: 500 });
      });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rangeRect,
    });

    try {
      render(
        <RecoilRoot>
          <div className="message-render" style={{ overflow: 'auto' }}>
            <pre style={{ overflowX: 'auto' }}>
              <code>{codeLine}</code>
            </pre>
          </div>
          <textarea id={mainTextareaId} />
          <Quotes />
          <QuoteButton conversationId={CONVO_ID} />
        </RecoilRoot>,
      );
      const code = document.querySelector('.message-render code');
      if (!code) {
        throw new Error('Code selection target was not rendered');
      }
      const range = document.createRange();
      range.selectNodeContents(code);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);

      fireEvent.mouseUp(document);
      const button = screen.getByTestId('add-to-chat-button');
      expect(button).toHaveStyle({ top: '62px', left: '220px' });

      rangeRect = rect({ top: 100, bottom: 120, left: -200, right: 1860 });
      fireEvent.scroll(code.closest('pre')!);
      act(() => jest.advanceTimersByTime(20));
      expect(button).toHaveStyle({ left: '200px' });

      rangeRect = rect({ top: 100, bottom: 120, left: -2200, right: -140 });
      fireEvent.scroll(code.closest('pre')!);
      act(() => jest.advanceTimersByTime(20));
      expect(button).not.toBeVisible();

      rangeRect = rect({ top: 140, bottom: 240, left: 310, right: 2200 });
      fireEvent.mouseUp(document);
      expect(button).toHaveStyle({ top: '102px', left: '305px' });
      fireEvent.click(button);
      expect(JSON.parse(screen.getByTestId('quotes').textContent ?? '[]')).toEqual([
        codeLine.trim(),
      ]);
    } finally {
      jest.useRealTimers();
      elementRect.mockRestore();
      if (originalRangeRect) {
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
          configurable: true,
          value: originalRangeRect,
        });
      } else {
        delete (Range.prototype as Partial<Range>).getBoundingClientRect;
      }
    }
  });
});

describe('QuoteButton lifecycle', () => {
  const originalRangeRect = Range.prototype.getBoundingClientRect;

  beforeEach(() => {
    jest.useFakeTimers();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect({ top: 100, bottom: 120, left: 200, right: 260 }),
    });
  });

  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    jest.useRealTimers();
    if (originalRangeRect) {
      Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
        configurable: true,
        value: originalRangeRect,
      });
    } else {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    }
  });

  function setup() {
    const content = (conversationId: string) => (
      <RecoilRoot>
        <div className="message-render">{SELECTED_TEXT}</div>
        <textarea id={mainTextareaId} />
        <Quotes />
        <QuoteButton conversationId={conversationId} />
      </RecoilRoot>
    );
    const view = render(content(CONVO_ID));
    const range = document.createRange();
    range.selectNodeContents(screen.getByText(SELECTED_TEXT));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    return {
      ...view,
      button: screen.getByTestId('add-to-chat-button'),
      navigate: () => view.rerender(content('convo-2')),
    };
  }

  it('supports keyboard selection and activation', () => {
    const { button } = setup();
    fireEvent.keyDown(document, { key: 'Shift' });
    fireEvent.keyUp(document, { key: 'Shift' });
    expect(button).toBeVisible();
    expect(button).toHaveAttribute('data-touch', 'false');
    fireEvent.click(button, { detail: 0 });
    expect(screen.getByTestId('quotes')).toHaveTextContent(JSON.stringify([SELECTED_TEXT]));
    expect(screen.getByRole('textbox')).toHaveFocus();
    expect(button).not.toBeVisible();
  });

  it('dismisses a canceled touch press without adding a quote', () => {
    const { button } = setup();
    fireEvent.mouseUp(document);
    pointer(button, 'pointerdown');
    window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event('selectionchange'));
    pointer(button, 'pointercancel');
    expect(button).not.toBeVisible();
    expect(screen.getByTestId('quotes')).toHaveTextContent('[]');
  });

  it('clears visible and pending selections when the conversation changes', () => {
    const { button, navigate } = setup();
    fireEvent.mouseUp(document);
    expect(button).toBeVisible();
    fireEvent(document, new Event('selectionchange'));
    navigate();
    expect(button).not.toBeVisible();
    act(() => jest.advanceTimersByTime(500));
    expect(button).not.toBeVisible();
    expect(screen.getByTestId('quotes')).toHaveTextContent('[]');
  });

  it('cancels pending selection work and removes the portal on unmount', () => {
    const { unmount } = setup();
    fireEvent(document, new Event('selectionchange'));
    const readSelection = jest.spyOn(window, 'getSelection');
    unmount();
    readSelection.mockClear();
    act(() => jest.advanceTimersByTime(500));
    expect(readSelection).not.toHaveBeenCalled();
    expect(screen.queryByTestId('add-to-chat-button')).not.toBeInTheDocument();
  });
});
