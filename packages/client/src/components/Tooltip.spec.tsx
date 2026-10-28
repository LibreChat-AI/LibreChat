import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipAnchor } from './Tooltip';

describe('TooltipAnchor', () => {
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
