import { ContentTypes, Tools } from 'librechat-data-provider';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TAttachment, TMessageContentParts } from 'librechat-data-provider';
import { ROW_GLYPH_SLOT, TOOL_ROW_CLASSES } from '../rows';
import { MessageSurfaceContext } from '../../ui/surface';
import ActivityPhaseGroup from '../ActivityPhaseGroup';
import { useFailedReveal } from '../reveal';

const mockUseSmoothStreaming = jest.fn(() => true);
const mockScheduleLayoutReconcile = jest.fn((_target: HTMLElement | null) => jest.fn());

jest.mock('~/hooks/Messages/useSmoothStreaming', () => ({
  __esModule: true,
  default: () => mockUseSmoothStreaming(),
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

jest.mock('~/hooks', () => {
  const expandCollapse = jest.requireActual('~/hooks/Messages/useExpandCollapse');
  const lazyCollapseBody = jest.requireActual('~/hooks/Messages/useLazyCollapseBody');
  return {
    useLocalize: () => (key: string, values?: Record<string | number, string>) =>
      key === 'com_ui_n_of_n_actions_failed' ? `${values?.[0]}/${values?.[1]} failed` : key,
    useExpandCollapse: expandCollapse.default,
    useLazyCollapseBody: lazyCollapseBody.default,
    EXPAND_TRANSITION: expandCollapse.EXPAND_TRANSITION,
    scheduleMessageContentLayoutReconcile: (target: HTMLElement | null) =>
      mockScheduleLayoutReconcile(target),
  };
});

jest.mock('~/components/MCPUIResource', () => ({
  MCPAppViews: ({ attachments }: { attachments?: TAttachment[] }) => (
    <>
      {(attachments ?? [])
        .filter((item) => item.type === 'ui_resources')
        .flatMap((item) => item.ui_resources ?? [])
        .map((resource: { resourceId: string; toolName?: string }, index) => (
          <iframe key={`${resource.resourceId}:${index}`} title={`MCP App: ${resource.toolName}`} />
        ))}
    </>
  ),
}));

const LABEL = 'Compared both release paths';
const NEXT_LABEL = 'Confirmed the rollback path is clean';

const makeLabelPart = (
  text: string,
): Extract<TMessageContentParts, { type: ContentTypes.ACTIVITY_LABEL }> => ({
  type: ContentTypes.ACTIVITY_LABEL,
  activity_label: text,
  activity_label_type: 'phase',
  activity_start_index: 0,
  pending: false,
});

const labelPart = makeLabelPart(LABEL);
const nextLabelPart = makeLabelPart(NEXT_LABEL);

/** A completed web search inside the phase: `AttachmentGroup` discards the
 *  `web_search` type, so only `SearchVerticals` can surface these. */
const searchAttachment = {
  type: Tools.web_search,
  [Tools.web_search]: {
    images: [
      {
        title: 'A pictured result',
        imageUrl: 'https://example.com/pic.png',
        thumbnailUrl: 'https://example.com/thumb.png',
        link: 'https://example.com/page',
      },
    ],
  },
} as unknown as TAttachment;

describe('ActivityPhaseGroup', () => {
  let frames: Array<FrameRequestCallback | undefined>;
  const originalRequestAnimationFrame = window.requestAnimationFrame;
  const originalCancelAnimationFrame = window.cancelAnimationFrame;

  /** The fold waits for a painted start value, so it spans more than one
   *  frame. Drain the queue the way a real compositor would. */
  const flushFrames = () =>
    act(() => {
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        frames[index] = undefined;
        frame?.(index);
      }
    });

  const pendingFrames = () => frames.filter((frame) => frame != null).length;

  beforeEach(() => {
    frames = [];
    mockUseSmoothStreaming.mockReturnValue(true);
    mockScheduleLayoutReconcile.mockClear();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: jest.fn((callback: FrameRequestCallback) => frames.push(callback)),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: jest.fn((handle: number) => {
        frames[handle - 1] = undefined;
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalRequestAnimationFrame == null) {
      Reflect.deleteProperty(window, 'requestAnimationFrame');
    } else {
      window.requestAnimationFrame = originalRequestAnimationFrame;
    }
    if (originalCancelAnimationFrame == null) {
      Reflect.deleteProperty(window, 'cancelAnimationFrame');
    } else {
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    }
  });

  test('renders a streaming cursor after an active tail phase', () => {
    const { container } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent showCursor>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(container.querySelector('.result-thinking')).toBeInTheDocument();
  });

  test('the cursor occupies exactly a tool row box', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent showCursor>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    /** The cursor and the next call's row trade places under the card for the
     *  rest of the run. Any difference between their boxes moves everything
     *  beneath the card on every swap. */
    const cursor = screen.getByTestId('activity-phase-cursor');
    for (const token of TOOL_ROW_CLASSES.split(' ')) {
      expect(cursor).toHaveClass(token);
    }
    /** The dot rides the same glyph slot as every row's icon, in flow, so the
     *  slot centers it on the avatar's axis instead of a text baseline. */
    const slot = cursor.firstElementChild;
    for (const token of ROW_GLYPH_SLOT.split(' ')) {
      expect(slot).toHaveClass(token);
    }
    expect(slot).toHaveClass('submitting');
    expect(cursor.querySelector('.result-thinking')).toHaveClass('after:!static');
  });

  test('opens the summary on the same glyph rail as the rows it replaces', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    expect(trigger).toHaveClass('justify-start', 'gap-2', 'p-0');
    /** Leading glyph plus the chevron, in the slot every row shares: a
     *  summary without it sits left of the rows it replaces. */
    expect(trigger.querySelectorAll('svg')).toHaveLength(2);
    for (const token of ROW_GLYPH_SLOT.split(' ')) {
      expect(trigger.firstElementChild).toHaveClass(token);
    }
    expect(screen.getByText(LABEL).parentElement).toHaveClass('flex-1', 'text-left');
  });

  test.each([
    ['create_file', '', 'lucide-file-plus-2'],
    ['edit_file', '', 'lucide-file-pen-line'],
    ['create_file', 'Created skills/demo/SKILL.md', 'lucide-file-plus-2'],
    ['create_file', 'Updated AGENTS.md with safe diagnostic guidance', 'lucide-file-pen-line'],
    ['edit_file', 'Edited AGENTS.md', 'lucide-file-pen-line'],
  ])(
    'shows the file-row glyph on settled and live phase headers for %s: %s',
    (name, output, glyph) => {
      const part = {
        type: ContentTypes.TOOL_CALL,
        [ContentTypes.TOOL_CALL]: {
          id: 'file-1',
          name,
          args: '{"path":"AGENTS.md"}',
          output,
          type: 'tool_call',
        },
      } as unknown as TMessageContentParts;
      const { rerender } = render(
        <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[part]}>
          <div data-testid="phase-content" />
        </ActivityPhaseGroup>,
      );

      expect(screen.getByRole('button', { name: LABEL }).querySelector(`.${glyph}`)).not.toBeNull();
      expect(
        screen.getByRole('button', { name: LABEL }).querySelector('.lucide-wrench'),
      ).toBeNull();

      rerender(
        <ActivityPhaseGroup labelPart={labelPart} hasContent liveParts={[part]}>
          <div data-testid="phase-content" />
        </ActivityPhaseGroup>,
      );
      expect(screen.getByRole('button').querySelector(`.${glyph}`)).not.toBeNull();
    },
  );

  test('keeps the focus ring inside the clipped header', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    /** The header's wrapper clips permanently — the 0fr/1fr grid needs it — so
     *  an outset ring would be drawn outside the border box and clipped away. */
    expect(trigger.parentElement).toHaveClass('overflow-hidden');
    expect(trigger).toHaveClass('focus-visible:ring-inset', 'focus-visible:ring-2');
  });

  test('mounts in the pre-marker shape, then folds the activity into the summary', () => {
    const { container } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent animateEntrance>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const card = screen.getByTestId('activity-phase-card');
    const trigger = screen.getByRole('button', { name: LABEL });
    const header = trigger.parentElement?.parentElement as HTMLElement;
    const panel = screen.getByTestId('activity-phase-panel');

    /** Frame zero must be indistinguishable from the layout the marker
     *  replaced: no header height, activity still open. */
    expect(header).toHaveStyle({ gridTemplateRows: '0fr', opacity: '0' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(panel).toHaveAttribute('aria-hidden', 'false');

    flushFrames();

    expect(header).toHaveStyle({ gridTemplateRows: '1fr', opacity: '1' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(mockScheduleLayoutReconcile).toHaveBeenCalledTimes(1);
    /** The two grid rows are the whole entrance. Chrome that materializes on
     *  the same curve is what made the fold read as four movements, and its
     *  inset is what stepped every folded row sideways. */
    expect(card.className).not.toMatch(/border|bg-surface|rounded|px-/);
    expect(container.querySelector('[style*="padding"]')).toBeNull();
  });

  test('tickers the header when the phase absorbs another finished block', () => {
    const { rerender } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(screen.queryByText(NEXT_LABEL)).not.toBeInTheDocument();

    rerender(
      <ActivityPhaseGroup labelPart={nextLabelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    /** The retired summary stays on screen, clipped, and rises out while the
     *  new one comes up from below — the absorbed block is the thing that
     *  moved, so it has to be visible while it moves. */
    const retired = screen.getByText(LABEL);
    expect(retired).toHaveClass('animate-out', 'slide-out-to-top-5');
    expect(retired).toHaveAttribute('aria-hidden', 'true');
    expect(
      within(screen.getByRole('button', { name: NEXT_LABEL })).getByText(NEXT_LABEL),
    ).toHaveClass('animate-in', 'slide-in-from-bottom-5');

    /** Retiring the outgoing line must not strip the incoming one's animation
     *  class: both run for the same 300ms, so removing it on the partner's
     *  `animationend` would snap a slide that is still in flight. */
    fireEvent.animationEnd(retired);
    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: NEXT_LABEL })).getByText(NEXT_LABEL),
    ).toHaveClass('animate-in', 'slide-in-from-bottom-5');
  });

  test('swaps the header outright when smooth streaming is off', () => {
    mockUseSmoothStreaming.mockReturnValue(false);

    const { rerender } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    rerender(
      <ActivityPhaseGroup labelPart={nextLabelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('button', { name: NEXT_LABEL })).getByText(NEXT_LABEL),
    ).not.toHaveClass('animate-in');
  });

  test('keeps historical phases closed without replaying the entrance', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    const header = trigger.parentElement?.parentElement as HTMLElement;
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(header.getAttribute('style')).toBeNull();
    expect(pendingFrames()).toBe(0);

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  test('honors the smooth-streaming preference', () => {
    mockUseSmoothStreaming.mockReturnValue(false);

    const { container } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent animateEntrance>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('[style*="grid-template-rows"]')).toBe(
      screen.getByTestId('activity-phase-panel'),
    );
    expect(pendingFrames()).toBe(0);
  });

  test('a click during the entrance wins over the scheduled fold', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent animateEntrance>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    flushFrames();

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('a phase without activity renders a label-only header', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent={false} animateEntrance>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(LABEL)).toHaveClass('text-left');
    expect(pendingFrames()).toBe(0);
  });

  test('keeps a collapsed history phase body unmounted until expanded', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(screen.queryByTestId('phase-content')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    expect(screen.getByTestId('phase-content')).toBeInTheDocument();
  });

  test('releases the body only after the collapse transition completes', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    fireEvent.click(trigger);
    expect(screen.getByTestId('phase-content')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByTestId('phase-content')).toBeInTheDocument();

    fireEvent.transitionEnd(screen.getByTestId('activity-phase-panel'));
    expect(screen.queryByTestId('phase-content')).not.toBeInTheDocument();
  });

  test('a pending approval retains the collapsed body until it resolves', () => {
    const { rerender } = render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent hasPendingApproval>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const trigger = screen.getByRole('button', { name: LABEL });
    fireEvent.click(trigger);
    const rail = screen.getByTestId('fold-rail');
    fireEvent.mouseEnter(rail);
    expect(screen.getByTestId('fold-rail-knob')).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    expect(rail).toBeDisabled();
    fireEvent.mouseEnter(rail);
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    fireEvent.transitionEnd(screen.getByTestId('activity-phase-panel'));
    expect(screen.getByTestId('phase-content')).toBeInTheDocument();

    rerender(
      <ActivityPhaseGroup labelPart={labelPart} hasContent hasPendingApproval={false}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    expect(screen.queryByTestId('phase-content')).not.toBeInTheDocument();
  });

  test('the entrance fold keeps the body mounted, then releases it after settling', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent animateEntrance>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    expect(screen.getByTestId('phase-content')).toBeInTheDocument();

    flushFrames();
    flushFrames();

    fireEvent.transitionEnd(screen.getByTestId('activity-phase-panel'));
    expect(screen.queryByTestId('phase-content')).not.toBeInTheDocument();
  });

  test('hoists a folded search call verticals out of the card', () => {
    /** The nested segment renders with `hideAttachments`, standing its own
     *  `WebSearch` verticals down for this hoist, and `AttachmentGroup` drops
     *  `web_search` attachments outright — so the card is the only surface
     *  left for a folded search's images, products and places. */
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent attachments={[searchAttachment]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const image = screen.getByRole('link', { name: 'A pictured result' });
    expect(image).toHaveAttribute('href', 'https://example.com/page');
    /** Outside the fold: collapsing the card must not take the media with it. */
    expect(screen.getByTestId('activity-phase-panel')).not.toContainElement(image);
  });

  test('keeps correlated App views outside the phase panel across disclosure toggles', () => {
    const appAttachment = {
      type: Tools.ui_resources,
      [Tools.ui_resources]: [
        { resourceId: 'alpha', toolName: 'alpha' },
        { resourceId: 'beta', toolName: 'beta' },
      ],
    } as unknown as TAttachment;
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent attachments={[appAttachment]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );

    const frames = screen.getAllByTitle(/MCP App:/);
    expect(frames).toHaveLength(2);
    expect(screen.getByTestId('activity-phase-panel')).not.toContainElement(frames[0]);
    const firstFrame = frames[0];

    const toggle = screen.getByRole('button', { name: LABEL });
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    expect(screen.getAllByTitle(/MCP App:/)).toHaveLength(2);
    expect(screen.getAllByTitle(/MCP App:/)[0]).toBe(firstFrame);
  });
});

describe('ActivityPhaseGroup failure fast path', () => {
  const toPart = (call: Record<string, unknown>, id: string): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: { id, args: '{}', type: 'tool_call', progress: 1, ...call },
    }) as unknown as TMessageContentParts;
  const okCall = toPart({ name: 'lookup', output: 'rows' }, 'ok');
  const failedCall = toPart(
    { name: 'fetch_page', output: 'Error: tool call failed: HTTP 429\nretry after 60' },
    'f1',
  );
  const RevealProbe = ({ onReveal }: { onReveal: () => void }) => {
    useFailedReveal(true, onReveal);
    return <div data-testid="phase-content" />;
  };

  test('counts only tool calls in the phase, not reasoning, labels or missing stream slots', () => {
    const thought = {
      type: ContentTypes.THINK,
      think: 'Checking a source',
    } as TMessageContentParts;
    render(
      <ActivityPhaseGroup
        labelPart={labelPart}
        hasContent
        spanParts={[okCall, undefined, thought, failedCall, okCall]}
      >
        <div />
      </ActivityPhaseGroup>,
    );

    expect(screen.getByTestId('failed-reveal-pill')).toHaveTextContent('1/3 failed');
    expect(screen.getByRole('button', { name: 'com_ui_show_failed_one_of_n' })).toBeInTheDocument();
  });

  test('peeks the first failed call under a collapsed card and reaches it in one click', () => {
    const onReveal = jest.fn();
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[okCall, failedCall]}>
        <RevealProbe onReveal={onReveal} />
      </ActivityPhaseGroup>,
    );
    const peek = screen.getByTestId('activity-phase-failed-peek');
    expect(peek).toHaveTextContent('HTTP 429');
    expect(peek).toHaveTextContent('com_ui_show_error');
    expect(screen.queryByTestId('activity-phase-failed-time')).not.toBeInTheDocument();
    expect(screen.queryByTestId('phase-content')).not.toBeInTheDocument();

    fireEvent.click(peek);

    expect(screen.getByRole('button', { name: LABEL })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByTestId('activity-phase-failed-peek')).not.toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  test('shows when the first failure happened, even after the conversation is restored', () => {
    const failedAt = Date.now() - 2 * 60_000;
    const timed = toPart(
      { name: 'fetch_page', runStepStatus: 'failed', runStepClosedAt: failedAt },
      'timed',
    );
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[timed, okCall]}>
        <div />
      </ActivityPhaseGroup>,
    );

    const time = screen.getByTestId('activity-phase-failed-time');
    expect(time).toHaveAttribute('dateTime', new Date(failedAt).toISOString());
    expect(time).toHaveTextContent(/2 minutes ago/);
  });

  test('keeps the error action and remaining count outside the shrinking peek label', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[failedCall, failedCall]}>
        <div />
      </ActivityPhaseGroup>,
    );

    const peek = screen.getByTestId('activity-phase-failed-peek');
    const label = screen.getByText('com_ui_failed_subject');
    const box = label.parentElement;
    expect(box).toHaveClass('min-w-0', 'flex');
    expect(label).toHaveClass('max-w-full', 'shrink-0', 'truncate');
    expect(box).toContainElement(screen.getByText('HTTP 429'));
    expect(screen.getByText('com_ui_plus_n_more')).toHaveClass('shrink-0');
    expect(screen.getByText('com_ui_show_error')).toHaveClass('shrink-0');
    expect(peek.firstElementChild).toHaveClass('shrink-0');
  });

  test('the pill beside the header does the same on an open card', () => {
    const onReveal = jest.fn();
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[failedCall, failedCall]}>
        <RevealProbe onReveal={onReveal} />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button', { name: LABEL }));
    const pill = screen.getByRole('button', { name: 'com_ui_show_failed_n_of_n' });
    expect(pill).toHaveTextContent('2/2 failed');
    fireEvent.click(pill);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: LABEL })).toHaveAttribute('aria-expanded', 'true');
  });

  test('announces the same failed-over-total count while later calls are still running', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent liveParts={[failedCall, okCall]}>
        <div />
      </ActivityPhaseGroup>,
    );
    expect(screen.getByTestId('failed-reveal-pill')).toHaveTextContent('1/2 failed');
    expect(screen.getByTestId('live-phase-outcome')).toHaveTextContent('1/2 failed');
  });

  test('a card with no failure shows neither pill nor peek', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent spanParts={[okCall]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    expect(screen.queryByTestId('failed-reveal-pill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('activity-phase-failed-peek')).not.toBeInTheDocument();
  });
});

describe('ActivityPhaseGroup open header', () => {
  const runningCall = {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 'r1',
      name: 'lookup',
      args: '{"intent":"Checking the rollback path"}',
      type: 'tool_call',
      progress: 0.5,
      output: '',
    },
  } as unknown as TMessageContentParts;

  test('titles an open card by its label instead of the live line', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent liveParts={[runningCall]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    const live = screen.getByRole('button');
    expect(live).toHaveAttribute('aria-labelledby');
    expect(live).toHaveTextContent('Checking the rollback path');

    fireEvent.click(live);

    const open = screen.getByRole('button', { name: LABEL });
    expect(open).not.toHaveAttribute('aria-labelledby');
    expect(open).toHaveClass('font-semibold', 'text-text-primary');
    expect(open).not.toHaveTextContent('Checking the rollback path');
  });

  test('keeps the live line open when the span has no label yet', () => {
    render(
      <ActivityPhaseGroup labelPart={makeLabelPart('')} hasContent liveParts={[runningCall]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('Checking the rollback path');
  });

  test.each(['bg-surface-dialog', 'bg-surface-secondary'] as const)(
    'paints the sticky header from its hosting %s canvas',
    (surface) => {
      render(
        <MessageSurfaceContext.Provider value={surface}>
          <ActivityPhaseGroup labelPart={labelPart} hasContent>
            <div data-testid="phase-content" />
          </ActivityPhaseGroup>
        </MessageSurfaceContext.Provider>,
      );
      const header = screen.getByRole('button', { name: LABEL });
      fireEvent.click(header);
      const pinned = header.parentElement?.parentElement;
      expect(pinned).toHaveClass('sticky', surface);
      expect(pinned).not.toHaveClass('bg-surface-primary-alt', 'bg-presentation');
    },
  );

  test('pins the open header and rails the rows under it', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    const header = screen.getByRole('button', { name: LABEL });
    const pinned = header.parentElement?.parentElement;
    expect(pinned).not.toHaveClass('sticky');
    fireEvent.click(header);
    expect(pinned).toHaveClass('sticky', 'top-0', 'bg-surface-primary-alt');
    expect(pinned).not.toHaveClass('bg-presentation');
    expect(screen.getByTestId('activity-phase-panel').firstElementChild).toHaveClass('pl-6');
  });

  test('collapses from its rail, showing the knob on its header while the rail is hovered', () => {
    render(
      <ActivityPhaseGroup labelPart={labelPart} hasContent>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    const header = screen.getByRole('button', { name: LABEL });
    fireEvent.click(header);
    const rail = screen.getByTestId('fold-rail');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    fireEvent.mouseEnter(rail);
    expect(header).toContainElement(screen.getByTestId('fold-rail-knob'));
    fireEvent.mouseLeave(rail);
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    fireEvent.click(rail);
    expect(header).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(rail);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ActivityPhaseGroup open live header', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  /** A thought's line holds for a second; the retired line lingers in the
   *  ticker, so the current line is read from its own title. */
  const settle = () => act(() => jest.advanceTimersByTime(1000));
  const thought = (reasoning_label?: string): TMessageContentParts =>
    ({
      type: ContentTypes.THINK,
      think: 'The refs share a commit. Next I check the ordering.',
      ...(reasoning_label == null ? {} : { reasoning_label }),
    }) as unknown as TMessageContentParts;

  test('previews the newest finished sentence while collapsed', () => {
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[thought('Comparing refs')]}
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    expect(screen.getByRole('button')).toHaveTextContent('Next I check the ordering.');
  });

  test("titles an open card by the thought's label instead of repeating its text", () => {
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[thought('Comparing refs')]}
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    settle();
    const header = screen.getByRole('button');
    expect(within(header).getByTitle('Comparing refs')).toBeInTheDocument();
    expect(within(header).queryByTitle('Next I check the ordering.')).toBeNull();
  });

  test('falls back to a running line no row uses when no label has landed', () => {
    render(
      <ActivityPhaseGroup labelPart={makeLabelPart('')} hasContent liveParts={[thought()]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    settle();
    const header = screen.getByRole('button');
    expect(within(header).getByTitle('com_ui_running')).toBeInTheDocument();
    expect(within(header).queryByTitle('com_ui_thinking')).toBeNull();
  });

  const runningCall = (intent: string): TMessageContentParts =>
    ({
      type: ContentTypes.TOOL_CALL,
      [ContentTypes.TOOL_CALL]: {
        id: 'r1',
        name: 'list_documents',
        args: JSON.stringify({ intent }),
        type: 'tool_call',
        progress: 0.5,
        output: '',
      },
    }) as unknown as TMessageContentParts;
  const batchLabel = (text: string): TMessageContentParts =>
    ({
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: text,
      activity_label_type: 'batch',
      pending: false,
    }) as unknown as TMessageContentParts;

  test("does not repeat the newest call's intent, which is its own row", () => {
    const intent = 'Reading the roadmap card so edits preserve project choices';
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[runningCall(intent)]}
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    settle();
    const header = screen.getByRole('button');
    expect(within(header).queryByTitle(intent)).toBeNull();
    expect(within(header).getByTitle('com_ui_running')).toBeInTheDocument();
  });

  test('titles an open card by the newest batch label behind a running call', () => {
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[batchLabel('Found the recap'), runningCall('Reading the roadmap card')]}
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    settle();
    expect(within(screen.getByRole('button')).getByTitle('Found the recap')).toBeInTheDocument();
  });
});

describe('ActivityPhaseGroup streaming thought peek', () => {
  const thought: TMessageContentParts = {
    type: ContentTypes.THINK,
    think: '<think>The refs share a commit. Next I check the ordering. Then the tags.',
  } as unknown as TMessageContentParts;
  const call: TMessageContentParts = {
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 'c1',
      name: 'lookup',
      args: '{}',
      type: 'tool_call',
      output: '',
    },
  } as unknown as TMessageContentParts;

  test("shows the streaming thought under a collapsed live card, in the cursor's place", () => {
    render(
      <ActivityPhaseGroup labelPart={makeLabelPart('')} hasContent liveParts={[thought]} showCursor>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    const peek = screen.getByTestId('streaming-thought-peek');
    expect(peek).toHaveTextContent('Next I check the ordering. Then the tags.');
    /** Straight from the stream, the thought still carries its opening tag. */
    expect(peek).not.toHaveTextContent('<think>');
    expect(screen.queryByTestId('activity-phase-cursor')).toBeNull();
    /** Under the header, not inside the fold that would unmount it. */
    expect(screen.getByTestId('activity-phase-panel')).not.toContainElement(peek);
  });

  test('gives way to the rows once the card is open', () => {
    render(
      <ActivityPhaseGroup labelPart={makeLabelPart('')} hasContent liveParts={[thought]}>
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByTestId('streaming-thought-peek')).toBeNull();
  });

  test('keeps the cursor when a call, not a thought, is at the tail', () => {
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[thought, call]}
        showCursor
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    expect(screen.queryByTestId('streaming-thought-peek')).toBeNull();
    expect(screen.getByTestId('activity-phase-cursor')).toBeInTheDocument();
  });

  test('hides the thought when it streams after tool calls in the same card', () => {
    render(
      <ActivityPhaseGroup
        labelPart={makeLabelPart('')}
        hasContent
        liveParts={[call, thought]}
        showCursor
      >
        <div data-testid="phase-content" />
      </ActivityPhaseGroup>,
    );
    expect(screen.queryByTestId('streaming-thought-peek')).toBeNull();
    expect(screen.getByTestId('activity-phase-cursor')).toBeInTheDocument();
  });
});
