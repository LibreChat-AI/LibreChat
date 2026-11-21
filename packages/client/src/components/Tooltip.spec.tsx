import React from 'react';
import '@testing-library/jest-dom';
import DOMPurify from 'dompurify';
import * as Ariakit from '@ariakit/react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { TooltipAnchor } from './Tooltip';

/** Counts the sanitizers built: the default export is both an instance and their factory. */
jest.mock('dompurify', () => {
  const actual = jest.requireActual('dompurify');
  const factory = jest.fn((...args: unknown[]) => actual(...args));
  return { __esModule: true, default: Object.assign(factory, actual) };
});

describe('TooltipAnchor', () => {
  /**
   * Message rows mount hundreds of anchors in one commit, and a long thread keeps thousands
   * mounted. An anchor nobody has touched is its element and nothing else: no tooltip store,
   * no timer, no listener on the document.
   */
  describe('an anchor that has not been used', () => {
    /** Counts the anchor element's renders through the element it is told to render. */
    const renders = { count: 0 };
    const Probe = React.forwardRef<HTMLButtonElement, React.ComponentProps<'button'>>(
      function Probe(props, ref) {
        renders.count += 1;
        return <button type="button" ref={ref} {...props} />;
      },
    );

    beforeEach(() => {
      renders.count = 0;
    });

    test.each(['top', 'right'] as const)('mounts a %s anchor with no tooltip behind it', (side) => {
      const store = jest.spyOn(Ariakit, 'useTooltipStore');
      const listen = jest.spyOn(document, 'addEventListener');
      const timers = jest.spyOn(window, 'setTimeout');
      try {
        render(
          <TooltipAnchor description="Once" aria-label="Once" side={side} render={<Probe />} />,
        );

        expect(screen.getByLabelText('Once')).toBeInTheDocument();
        expect(store).not.toHaveBeenCalled();
        expect(timers).not.toHaveBeenCalled();
        expect(listen.mock.calls.map(([type]) => type)).not.toContain('mouseleave');
      } finally {
        store.mockRestore();
        listen.mockRestore();
        timers.mockRestore();
      }
    });

    test('adds nothing to the document for each further anchor once one has been used', async () => {
      render(<TooltipAnchor description="First" aria-label="First" />);
      const first = screen.getByLabelText('First');
      fireEvent.mouseEnter(first);
      fireEvent.mouseMove(first);
      await screen.findByRole('tooltip', undefined, { timeout: 3000 });

      const listen = jest.spyOn(document, 'addEventListener');
      try {
        render(
          <>
            <TooltipAnchor description="Second" aria-label="Second" />
            <TooltipAnchor description="Third" aria-label="Third" />
          </>,
        );
        fireEvent.mouseEnter(screen.getByLabelText('Second'));
        fireEvent.mouseEnter(screen.getByLabelText('Third'));
        expect(listen.mock.calls.map(([type]) => type)).not.toContain('mouseleave');
      } finally {
        listen.mockRestore();
      }
    });

    test('builds no sanitizer for plain descriptions, and one for every tooltip with markup', async () => {
      const built = DOMPurify as unknown as jest.Mock;
      built.mockClear();
      const plain = render(
        <>
          <TooltipAnchor description="Copy" aria-label="Copy" />
          <TooltipAnchor description="Edit" aria-label="Edit" />
        </>,
      );
      fireEvent.mouseEnter(screen.getByLabelText('Copy'));
      fireEvent.mouseEnter(screen.getByLabelText('Edit'));
      expect(built).not.toHaveBeenCalled();
      plain.unmount();

      render(
        <>
          <TooltipAnchor description='<a href="/docs">Docs</a>' aria-label="Docs" enableHTML />
          <TooltipAnchor description="<b>Bold</b><script>x</script>" aria-label="Bold" enableHTML />
        </>,
      );
      /** Not until a tooltip with markup is about to be shown. */
      expect(built).not.toHaveBeenCalled();

      fireEvent.mouseEnter(screen.getByLabelText('Bold'));
      const anchor = screen.getByLabelText('Docs');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);
      const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
      /** The sanitizer is the module's, so this holds for the first markup this file renders. */
      expect(built).toHaveBeenCalledTimes(1);
      const link = tooltip.querySelector('a');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    test('renders the anchor once more for its first use and not again as the tooltip opens', async () => {
      render(<TooltipAnchor description="Opens" aria-label="Opens" render={<Probe />} />);

      const anchor = screen.getByLabelText('Opens');
      const mounted = renders.count;
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);
      expect(renders.count).toBe(mounted + 1);

      expect(await screen.findByRole('tooltip', undefined, { timeout: 3000 })).toHaveTextContent(
        'Opens',
      );
      expect(renders.count).toBe(mounted + 1);
      /** The element is the one that was hovered: nothing was swapped under the pointer. */
      expect(screen.getByLabelText('Opens')).toBe(anchor);
    });
  });

  describe('showing and hiding', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.runOnlyPendingTimers();
      jest.useRealTimers();
    });

    const settle = (ms: number) =>
      act(async () => {
        jest.advanceTimersByTime(ms);
      });

    test('shows after the delay when the pointer moves over the anchor', async () => {
      render(<TooltipAnchor description="Hovered" aria-label="Hovered" />);
      const anchor = screen.getByLabelText('Hovered');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);
      await settle(200);
      expect(screen.queryByRole('tooltip')).toBeNull();

      await settle(400);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Hovered');
    });

    /** A pointer that comes to rest on the anchor: it enters and moves in the same instant,
     *  before the first use has mounted anything, and does not move again. */
    test('shows for a pointer that moved onto the anchor once and stopped', async () => {
      render(<TooltipAnchor description="Rested" aria-label="Rested" />);
      const anchor = screen.getByLabelText('Rested');
      act(() => {
        fireEvent.mouseEnter(anchor);
        fireEvent.mouseMove(anchor);
      });

      await settle(600);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Rested');
    });

    test('does not show for a pointer that entered, moved once and left at once', async () => {
      render(<TooltipAnchor description="Passing" aria-label="Passing" />);
      const anchor = screen.getByLabelText('Passing');
      act(() => {
        fireEvent.mouseEnter(anchor);
        fireEvent.mouseMove(anchor);
        fireEvent.mouseLeave(anchor);
      });

      await settle(1000);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    test('does not show for a press that comes before the delay is up', async () => {
      render(<TooltipAnchor description="Pressed" aria-label="Pressed" />);
      const anchor = screen.getByLabelText('Pressed');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);
      await settle(200);
      fireEvent.click(anchor);

      await settle(1000);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    test('does not show once the pointer has left', async () => {
      render(<TooltipAnchor description="Left" aria-label="Left" />);
      const anchor = screen.getByLabelText('Left');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);
      fireEvent.mouseLeave(anchor);

      await settle(1000);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    test('stays away on hover when the caller says so', async () => {
      render(<TooltipAnchor description="Quiet" aria-label="Quiet" showOnHover={false} />);
      const anchor = screen.getByLabelText('Quiet');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);

      await settle(1000);
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    test('shows at once for keyboard focus, on the anchor that was untouched until then', async () => {
      render(<TooltipAnchor description="Focused" aria-label="Focused" render={<button />} />);
      const anchor = screen.getByLabelText('Focused');
      fireEvent.keyDown(document.body, { key: 'Tab' });
      act(() => anchor.focus());

      await settle(50);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Focused');
      expect(document.activeElement).toBe(anchor);
    });

    test('shows the next tooltip without its delay while one is on screen', async () => {
      render(
        <>
          <TooltipAnchor description="One" aria-label="One" />
          <TooltipAnchor description="Two" aria-label="Two" />
        </>,
      );
      const one = screen.getByLabelText('One');
      fireEvent.mouseEnter(one);
      fireEvent.mouseMove(one);
      await settle(600);
      expect(screen.getByRole('tooltip')).toHaveTextContent('One');

      const two = screen.getByLabelText('Two');
      fireEvent.mouseLeave(one);
      act(() => {
        fireEvent.mouseEnter(two);
        fireEvent.mouseMove(two);
      });
      await settle(50);
      const shown = screen.getAllByRole('tooltip').map((tip) => tip.textContent);
      expect(shown).toContain('Two');
    });
  });

  describe('zIndex', () => {
    /** Lets a tooltip clear a host layer above the stylesheet's default (150). */
    test('applies the zIndex prop to the tooltip popup', async () => {
      render(
        <TooltipAnchor description="Layered" zIndex={250} aria-label="Layered" tabIndex={0}>
          <span>icon</span>
        </TooltipAnchor>,
      );

      const anchor = screen.getByLabelText('Layered');
      fireEvent.mouseEnter(anchor);
      fireEvent.mouseMove(anchor);

      const tooltip = await screen.findByRole('tooltip', undefined, { timeout: 3000 });
      expect(tooltip).toHaveStyle({ zIndex: '250' });
    });
  });

  describe('role="button" keyboard activation', () => {
    /** Renders a non-native element, so Enter and Space must both be handled (WCAG 2.1.1). */
    const renderButtonAnchor = (onClick: jest.Mock) => {
      render(
        <TooltipAnchor
          role="button"
          tabIndex={0}
          description="Do the thing"
          aria-label="Do the thing"
          onClick={onClick}
        >
          <span>icon</span>
        </TooltipAnchor>,
      );
      return screen.getByLabelText('Do the thing');
    };

    test('activates on Enter', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: 'Enter' });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('activates on Space', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: ' ' });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('ignores repeated Space keydowns from a held key', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: ' ' });
      fireEvent.keyDown(anchor, { key: ' ', repeat: true });
      fireEvent.keyDown(anchor, { key: ' ', repeat: true });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('ignores repeated Enter keydowns from a held key', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: 'Enter' });
      fireEvent.keyDown(anchor, { key: 'Enter', repeat: true });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('prevents default on Space so the page does not scroll', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      const notCancelled = fireEvent.keyDown(anchor, { key: ' ', cancelable: true });

      expect(notCancelled).toBe(false);
    });

    test('still prevents default on repeated Space keydowns', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: ' ' });
      const notCancelled = fireEvent.keyDown(anchor, {
        key: ' ',
        repeat: true,
        cancelable: true,
      });

      expect(notCancelled).toBe(false);
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    test('ignores unrelated keys', () => {
      const onClick = jest.fn();
      const anchor = renderButtonAnchor(onClick);

      fireEvent.keyDown(anchor, { key: 'a' });
      fireEvent.keyDown(anchor, { key: 'Escape' });

      expect(onClick).not.toHaveBeenCalled();
    });

    test('does not synthesize activation without role="button"', () => {
      const onClick = jest.fn();
      render(
        <TooltipAnchor description="Plain" aria-label="Plain" onClick={onClick}>
          <span>icon</span>
        </TooltipAnchor>,
      );

      fireEvent.keyDown(screen.getByLabelText('Plain'), { key: 'Enter' });
      fireEvent.keyDown(screen.getByLabelText('Plain'), { key: ' ' });

      expect(onClick).not.toHaveBeenCalled();
    });

    test('defaults tabIndex to 0 when role is button', () => {
      render(
        <TooltipAnchor role="button" description="Focusable" aria-label="Focusable">
          <span>icon</span>
        </TooltipAnchor>,
      );

      expect(screen.getByLabelText('Focusable')).toHaveAttribute('tabindex', '0');
    });

    test('preserves an explicit tabIndex for role-button anchors', () => {
      render(
        <TooltipAnchor role="button" tabIndex={-1} description="Deferred" aria-label="Deferred">
          <span>icon</span>
        </TooltipAnchor>,
      );

      expect(screen.getByLabelText('Deferred')).toHaveAttribute('tabindex', '-1');
    });
  });

  describe('consumer onKeyDown', () => {
    test('is invoked rather than silently overridden', () => {
      const onKeyDown = jest.fn();
      render(
        <TooltipAnchor
          role="button"
          tabIndex={0}
          description="Chained"
          aria-label="Chained"
          onKeyDown={onKeyDown}
        >
          <span>icon</span>
        </TooltipAnchor>,
      );

      fireEvent.keyDown(screen.getByLabelText('Chained'), { key: 'Enter' });

      expect(onKeyDown).toHaveBeenCalledTimes(1);
    });

    test('can suppress the built-in activation via preventDefault', () => {
      const onClick = jest.fn();
      render(
        <TooltipAnchor
          role="button"
          tabIndex={0}
          description="Suppressed"
          aria-label="Suppressed"
          onClick={onClick}
          onKeyDown={(event) => event.preventDefault()}
        >
          <span>icon</span>
        </TooltipAnchor>,
      );

      fireEvent.keyDown(screen.getByLabelText('Suppressed'), { key: 'Enter' });

      expect(onClick).not.toHaveBeenCalled();
    });
  });
});
