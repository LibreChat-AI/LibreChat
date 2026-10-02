import { act, fireEvent, render, screen } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from './OriginalDialog';
import ControlCombobox from './ControlCombobox';

type CapturedObserver = {
  callback: ResizeObserverCallback;
  target: Element | null;
  disconnect: jest.Mock;
};

const observers: CapturedObserver[] = [];

class CapturingResizeObserver {
  callback: ResizeObserverCallback;
  target: Element | null = null;
  disconnect = jest.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve = jest.fn();
}

const originalResizeObserver = window.ResizeObserver;

beforeEach(() => {
  observers.length = 0;
  (window as unknown as { ResizeObserver: typeof CapturingResizeObserver }).ResizeObserver =
    CapturingResizeObserver;
});

afterEach(() => {
  (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    originalResizeObserver;
});

const items = [
  { label: 'Option A', value: 'a' },
  { label: 'Option B', value: 'b' },
];

const renderCombobox = (initialButtonWidth: number, isCollapsed = false) => {
  const offsetWidthSpy = jest
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockReturnValue(initialButtonWidth);

  const utils = render(
    <ControlCombobox
      selectedValue="a"
      displayValue="Option A"
      items={items}
      setValue={() => undefined}
      ariaLabel="Test combobox"
      isCollapsed={isCollapsed}
      showCarat
    />,
  );

  return { ...utils, offsetWidthSpy };
};

const getPopoverWidth = () => {
  const popover = document.querySelector('.animate-popover') as HTMLElement | null;
  return popover?.style.width ?? null;
};

const openPopover = () => {
  const trigger = screen.getByRole('combobox');
  act(() => {
    trigger.click();
  });
};

describe('ControlCombobox popover sizing', () => {
  it('uses the button width measured on mount when layout is stable', () => {
    renderCombobox(275);
    openPopover();
    expect(getPopoverWidth()).toBe('275px');
  });

  it('updates the popover width when the trigger resizes after mount (regression: agent select dropdown rendering at narrow width)', () => {
    const { offsetWidthSpy } = renderCombobox(26);
    openPopover();
    expect(getPopoverWidth()).toBe('26px');

    const observer = observers[0];
    expect(observer).toBeDefined();
    expect(observer.target).not.toBeNull();

    offsetWidthSpy.mockReturnValue(275);

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 275 } as DOMRectReadOnly,
            borderBoxSize: [{ inlineSize: 275, blockSize: 36 }],
            contentBoxSize: [{ inlineSize: 275, blockSize: 36 }],
            devicePixelContentBoxSize: [{ inlineSize: 275, blockSize: 36 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  it('disconnects the ResizeObserver on unmount', () => {
    const { unmount } = renderCombobox(275);
    openPopover();
    const observer = observers[0];
    expect(observer).toBeDefined();
    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not observe the trigger button when isCollapsed is true', () => {
    renderCombobox(275, true);
    const triggerObservers = observers.filter(
      (o) => (o.target as HTMLElement | null)?.tagName === 'BUTTON',
    );
    expect(triggerObservers).toHaveLength(0);
  });

  it('falls back to synchronous offsetWidth when ResizeObserver is unavailable', () => {
    (window as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      undefined;

    renderCombobox(275);
    openPopover();

    expect(getPopoverWidth()).toBe('275px');
    const triggerObservers = observers.filter(
      (o) => (o.target as HTMLElement | null)?.tagName === 'BUTTON',
    );
    expect(triggerObservers).toHaveLength(0);
  });

  it('uses button.offsetWidth when borderBoxSize is unavailable', () => {
    const { offsetWidthSpy } = renderCombobox(26);
    openPopover();
    expect(getPopoverWidth()).toBe('26px');

    const observer = observers[0];
    expect(observer).toBeDefined();

    offsetWidthSpy.mockReturnValue(275);

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 251 } as DOMRectReadOnly,
            borderBoxSize: undefined,
            contentBoxSize: undefined,
            devicePixelContentBoxSize: undefined,
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  it('ignores zero-width resize entries', () => {
    renderCombobox(275);
    openPopover();
    expect(getPopoverWidth()).toBe('275px');

    const observer = observers[0];
    expect(observer).toBeDefined();

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 0 } as DOMRectReadOnly,
            borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
            contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
            devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  it('filters listed options when the search field is typed in', () => {
    render(
      <ControlCombobox
        selectedValue="a"
        displayValue="Option A"
        items={items}
        setValue={() => undefined}
        ariaLabel="Test combobox"
        searchPlaceholder="Search projects"
        isCollapsed={false}
        showCarat
      />,
    );
    openPopover();

    const search = screen.getByPlaceholderText('Search projects');
    fireEvent.change(search, { target: { value: 'Option B' } });

    expect(screen.getByRole('option', { name: 'Option B' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Option A' })).not.toBeInTheDocument();
  });
});

describe('ControlCombobox dropdown caps', () => {
  const manyItems = Array.from({ length: 15 }, (_, index) => ({
    label: `Agent ${index + 1}`,
    value: `agent-${index + 1}`,
  }));

  const renderCapped = (
    overrides: { popoverMaxHeight?: number; unsearchedLimit?: number; selectedValue?: string } = {},
  ) =>
    render(
      <ControlCombobox
        selectedValue={overrides.selectedValue ?? 'agent-1'}
        displayValue="Agent 1"
        items={manyItems}
        setValue={() => undefined}
        ariaLabel="Test combobox"
        searchPlaceholder="Search agents"
        isCollapsed={false}
        showCarat
        popoverMaxHeight={480}
        unsearchedLimit={10}
        {...overrides}
      />,
    );

  it('lists at most unsearchedLimit options while the search field is empty', () => {
    renderCapped();
    openPopover();
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '10');
    expect(screen.queryByRole('option', { name: 'Agent 11' })).not.toBeInTheDocument();
  });

  it('lifts the cap while searching so options past the cut stay reachable', () => {
    renderCapped();
    openPopover();
    fireEvent.change(screen.getByPlaceholderText('Search agents'), {
      target: { value: 'Agent 15' },
    });
    expect(screen.getByRole('option', { name: 'Agent 15' })).toBeInTheDocument();
  });

  it('keeps the selected option in the capped list when it ranks past the cut', () => {
    renderCapped({ selectedValue: 'agent-15' });
    openPopover();
    /** SelectRenderer windowing renders only the visible slice in jsdom, so
     * the cap is read off aria-setsize rather than the option count. */
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '10');
    expect(screen.getByRole('option', { name: 'Agent 15' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('option', { name: 'Agent 10' })).not.toBeInTheDocument();
  });

  it('caps the popover at popoverMaxHeight with the list as the scrolling region', () => {
    renderCapped();
    openPopover();
    const popover = document.querySelector('.animate-popover') as HTMLElement;
    expect(popover.style.maxHeight).toBe('min(480px, var(--popover-available-height, 480px))');
    expect(popover.className).toContain('flex-col');
    const scroller = popover.querySelector('div.overflow-auto');
    expect(scroller?.className).toContain('flex-1');
    expect(scroller?.className).toContain('min-h-0');
  });

  it('keeps the fixed 300px list cap for consumers that pass neither prop', () => {
    renderCapped({ popoverMaxHeight: undefined, unsearchedLimit: undefined });
    openPopover();
    const popover = document.querySelector('.animate-popover') as HTMLElement;
    expect(popover.style.maxHeight).toBe('');
    const scroller = popover.querySelector('div.overflow-auto');
    expect(scroller?.className).toContain('max-h-[300px]');
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-setsize', '15');
  });
});

describe('ControlCombobox portal placement', () => {
  const renderInDialog = (portal: boolean) =>
    render(
      <OGDialog open>
        <OGDialogContent>
          <OGDialogTitle>Change project</OGDialogTitle>
          <ControlCombobox
            selectedValue="a"
            displayValue="Option A"
            items={items}
            setValue={() => undefined}
            ariaLabel="Test combobox"
            searchPlaceholder="Search projects"
            isCollapsed={false}
            showCarat
            portal={portal}
          />
        </OGDialogContent>
      </OGDialog>,
    );

  it('portals to the document by default so existing dialogs keep their current placement', () => {
    renderInDialog(true);
    openPopover();

    const dialog = screen.getByRole('dialog', { name: 'Change project' });
    expect(dialog.contains(screen.getByPlaceholderText('Search projects'))).toBe(false);
  });

  it('keeps the popover inside the dialog when portal is false, so its search field stays typeable', () => {
    renderInDialog(false);
    openPopover();

    const dialog = screen.getByRole('dialog', { name: 'Change project' });
    const search = screen.getByPlaceholderText('Search projects');
    expect(dialog.contains(search)).toBe(true);

    fireEvent.change(search, { target: { value: 'Option B' } });
    expect(screen.getByRole('option', { name: 'Option B' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Option A' })).not.toBeInTheDocument();
  });
});
