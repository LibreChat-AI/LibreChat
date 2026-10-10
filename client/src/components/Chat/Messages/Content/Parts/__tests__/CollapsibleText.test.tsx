import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import CollapsibleText from '../CollapsibleText';

let mockRemScale = 1;
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useRemScale: () => mockRemScale,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const longMessage = 'line\n'.repeat(80);
const shortMessage = 'a short message';
const plainMessage = 'a long message';
const linkLabel = 'focusable link';

/** jsdom does no layout, so scrollHeight is 0 unless stubbed. Returning a set
 *  height above the collapse cap (256px) makes the content read as overflowing;
 *  the default 0 keeps it within the cap. */
const stubScrollHeight = (height: number) =>
  jest.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);

beforeEach(() => {
  mockRemScale = 1;
});

describe('CollapsibleText', () => {
  it('renders children untouched while the preference is off', () => {
    const scrollHeight = stubScrollHeight(5000);
    try {
      const { container } = render(
        <CollapsibleText enabled={false}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      // No clamp wrapper, no toggle: the DOM stays identical to before.
      const paragraph = screen.getByText(plainMessage);
      expect(paragraph.parentElement).toBe(container);
      expect(screen.queryByRole('button')).toBeNull();
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('offers no toggle for content that fits the preview', () => {
    const scrollHeight = stubScrollHeight(100);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>{shortMessage}</p>
        </CollapsibleText>,
      );
      expect(screen.getByText(shortMessage)).toBeInTheDocument();
      expect(screen.queryByRole('button')).toBeNull();
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('does not clamp sub-tolerance content that barely exceeds the cap', () => {
    // 260px is within the 8px tolerance, so no toggle appears; the clamp must
    // not apply either, or the trailing sliver would be hidden irrecoverably.
    const scrollHeight = stubScrollHeight(260);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>{shortMessage}</p>
        </CollapsibleText>,
      );
      expect(screen.queryByRole('button')).toBeNull();
      const region = screen.getByText(shortMessage).closest('[id]');
      expect(region).not.toHaveStyle({ maxHeight: '256px' });
      expect(region?.className).not.toContain('overflow-hidden');
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('clamps an overflowing message and keeps the full text in the page', () => {
    const scrollHeight = stubScrollHeight(500);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>{longMessage}</p>
        </CollapsibleText>,
      );
      const toggle = screen.getByRole('button', { name: 'com_ui_show_more' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      // aria-controls must point at the clamped region holding the text.
      const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
      expect(region).not.toBeNull();
      expect(region?.textContent).toBe(longMessage);

      // The clamp is visual only: the full text stays in the DOM.
      expect(region?.className).toContain('overflow-hidden');
      expect(region).toHaveStyle({ maxHeight: '256px' });
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('reveals the message when focus reaches clipped content', () => {
    // Links and code-block controls below the cutoff stay in the tab order;
    // focusing one must not leave focus inside visually hidden content. jsdom
    // has no layout, so place the link's box below the 256px cutoff by hand
    // (the region's own rect stays all-zero, putting its boundary at 256).
    const scrollHeight = stubScrollHeight(500);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>
            <a href="#target">{linkLabel}</a>
          </p>
        </CollapsibleText>,
      );
      const link = screen.getByRole('link');
      link.getBoundingClientRect = () =>
        ({ top: 300, bottom: 320, height: 20, width: 40, left: 0, right: 40 }) as DOMRect;
      fireEvent(link, new FocusEvent('focusin', { bubbles: true }));
      expect(screen.getByRole('button', { name: 'com_ui_show_less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('keeps the message collapsed when a visible control gains focus', () => {
    const scrollHeight = stubScrollHeight(500);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>
            <a href="#target">{linkLabel}</a>
          </p>
        </CollapsibleText>,
      );
      const link = screen.getByRole('link');
      link.getBoundingClientRect = () =>
        ({ top: 10, bottom: 30, height: 20, width: 40, left: 0, right: 40 }) as DOMRect;
      fireEvent(link, new FocusEvent('focusin', { bubbles: true }));
      expect(screen.getByRole('button', { name: 'com_ui_show_more' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('reveals a control clipped by even a pixel at the boundary', () => {
    // The overflow tolerance absorbs trailing margins for the toggle decision
    // only: a focused control hanging 2px past the cutoff is still hidden.
    const scrollHeight = stubScrollHeight(500);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>
            <a href="#target">{linkLabel}</a>
          </p>
        </CollapsibleText>,
      );
      const link = screen.getByRole('link');
      link.getBoundingClientRect = () =>
        ({ top: 254, bottom: 258, height: 4, width: 40, left: 0, right: 40 }) as DOMRect;
      fireEvent(link, new FocusEvent('focusin', { bubbles: true }));
      expect(screen.getByRole('button', { name: 'com_ui_show_less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it.each([
    [0.5, 128, 131],
    [1.5, 384, 395],
  ])(
    'scales the collapsed boundary and tolerance with the root at %s',
    (scale, collapsedMaxHeight, scrollHeight) => {
      mockRemScale = scale;
      const scroll = stubScrollHeight(scrollHeight);
      try {
        render(
          <CollapsibleText enabled={true}>
            <p>{plainMessage}</p>
          </CollapsibleText>,
        );
        expect(screen.queryByRole('button')).toBeNull();
        const region = screen.getByText(plainMessage).closest('[id]');
        expect(region).not.toHaveStyle({ maxHeight: `${collapsedMaxHeight}px` });
      } finally {
        scroll.mockRestore();
      }
    },
  );

  it.each([
    [0.5, 128],
    [1.5, 384],
  ])('uses the scaled boundary when revealing focused content at %s', (scale, boundary) => {
    mockRemScale = scale;
    const scroll = stubScrollHeight(boundary * 2);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>
            <a href="#target">{linkLabel}</a>
          </p>
        </CollapsibleText>,
      );
      const link = screen.getByRole('link');
      link.getBoundingClientRect = () =>
        ({
          top: boundary + 1,
          bottom: boundary + 2,
          height: 1,
          width: 40,
          left: 0,
          right: 40,
        }) as DOMRect;
      fireEvent(link, new FocusEvent('focusin', { bubbles: true }));
      expect(screen.getByRole('button', { name: 'com_ui_show_less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    } finally {
      scroll.mockRestore();
    }
  });

  it('re-measures overflow when the root scale changes', () => {
    mockRemScale = 1.5;
    const scroll = stubScrollHeight(390);
    try {
      const { rerender } = render(
        <CollapsibleText enabled={true}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      expect(screen.queryByRole('button')).toBeNull();

      mockRemScale = 0.5;
      rerender(
        <CollapsibleText enabled={true}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      expect(screen.getByRole('button', { name: 'com_ui_show_more' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    } finally {
      scroll.mockRestore();
    }
  });

  it('expands in place and offers show less', () => {
    const scrollHeight = stubScrollHeight(500);
    try {
      render(
        <CollapsibleText enabled={true}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_more' }));
      const collapse = screen.getByRole('button', { name: 'com_ui_show_less' });
      expect(collapse).toHaveAttribute('aria-expanded', 'true');
      expect(document.getElementById(collapse.getAttribute('aria-controls') ?? '')).toHaveStyle({
        maxHeight: '',
      });
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('starts collapsed again after the preference is turned off and back on', () => {
    const scrollHeight = stubScrollHeight(500);
    try {
      const { rerender } = render(
        <CollapsibleText enabled={true}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_more' }));
      rerender(
        <CollapsibleText enabled={false}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      rerender(
        <CollapsibleText enabled={true}>
          <p>{plainMessage}</p>
        </CollapsibleText>,
      );
      expect(screen.getByRole('button', { name: 'com_ui_show_more' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    } finally {
      scrollHeight.mockRestore();
    }
  });
});
