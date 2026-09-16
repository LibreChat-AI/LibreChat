import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { QueryKeys } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { STEER_ICON } from '~/components/Chat/Steering/identity';
import SteerPart from '../SteerPart';
import store from '~/store';

let mockShareContext: { isSharedConvo?: boolean; shareId?: string } = {};
let mockFileMap: Record<string, { llmDeliveryPath?: 'provider' | 'text' | 'none' }> = {};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers', () => ({
  useShareContext: () => mockShareContext,
  useFileMapContext: () => mockFileMap,
}));

jest.mock('~/components/Chat/Messages/ui/MessageTimestamp', () => ({
  __esModule: true,
  default: () => <time data-testid="steer-timestamp" />,
}));

jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

jest.mock('~/components/Chat/Input/Files/FileContainer', () => ({
  __esModule: true,
  default: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="steer-file" onClick={onClick}>
      {file.filename}
    </button>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/FilePreviewDialog', () => ({
  __esModule: true,
  default: ({
    open,
    fileName,
    deliveryPath,
  }: {
    open: boolean;
    fileName: string;
    deliveryPath?: string;
  }) =>
    open ? (
      <div data-testid="steer-file-preview" data-delivery-path={deliveryPath}>
        {fileName}
      </div>
    ) : null,
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: ({ altText }: { altText: string }) => <img alt={altText} data-testid="steer-image" />,
}));

/** Seeds the user atom rather than mocking `useAuthContext`, matching the share
 * route where neither an auth context nor a user exists. */
const SEEDED_USER = { name: 'Danny', username: 'danny' };

function renderPart(
  files?: TMessage['files'],
  /** `null` seeds nothing — passing `undefined` would fall back to the default and
   *  silently test the signed-in state instead of the anonymous share route. */
  user: { name: string; username: string } | null = SEEDED_USER,
) {
  const queryClient = new QueryClient();
  queryClient.setQueryData([QueryKeys.endpoints], {});

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={({ set }) => user && set(store.user, user as never)}>
        <SteerPart steer="steered words" steerId="s1" createdAt={1} files={files} />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('SteerPart author label', () => {
  beforeEach(() => {
    mockShareContext = {};
    mockFileMap = {};
  });

  it('labels with the logged-in user name in the owner view (username display on)', () => {
    renderPart();
    expect(screen.getByText('Danny')).toBeInTheDocument();
    expect(screen.queryByText('com_user_message')).toBeNull();
  });

  it('renders on the share route, where there is no auth context and no user', () => {
    /** Regression for #14474: `/share/:shareId` mounts outside AuthContextProvider,
     *  so any `useAuthContext()` on this tree throws and the whole page is replaced
     *  by the route error boundary. Both SteerPart and the MessageIcon tree it
     *  renders used to call it. */
    mockShareContext = { isSharedConvo: true, shareId: 'share-1' };

    expect(() => renderPart(undefined, null)).not.toThrow();
    expect(screen.getByText('steered words')).toBeInTheDocument();
    expect(screen.getByText('com_user_message')).toBeInTheDocument();
  });

  it('never renders the viewer identity on a shared steer bubble', () => {
    /** The user atom is app-wide and survives navigation, so a signed-in viewer
     *  opening a share link still has an identity in state. The shared steer must
     *  keep generic attribution regardless. */
    mockShareContext = { isSharedConvo: true, shareId: 'share-1' };
    renderPart(undefined, SEEDED_USER);

    expect(screen.queryByTitle('Danny')).toBeNull();
    expect(screen.queryByText('Danny')).toBeNull();
  });

  it('labels with the generic user message in the share view, never the viewer identity', () => {
    mockShareContext = { isSharedConvo: true, shareId: 'share-1' };
    renderPart();
    expect(screen.queryByText('Danny')).toBeNull();
    expect(screen.getByText('com_user_message')).toBeInTheDocument();
  });

  it('shows the applied receipt with its explanation as the accessible label', () => {
    renderPart();
    // The ✓✓ receipt replaces the old hover-only "?" affordance; the info text
    // is the trigger's accessible label so the marks never read as bare glyphs.
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt).toHaveAttribute('data-receipt-state', 'applied');
    expect(screen.getByLabelText('com_ui_steer_applied_info')).toBeInTheDocument();
  });

  it('keeps the receipt visible at rest instead of gating it behind hover', () => {
    renderPart();
    // The whole point of the receipt is that "it landed" is visible without
    // hunting: no hover-capable-pointer opacity gate like the old "?" had.
    const receipt = screen.getByTestId('steer-receipt');
    expect(receipt.className).not.toContain('opacity-0');
  });

  it('anchors the receipt after the timestamp, at the trailing edge of the row', () => {
    renderPart();
    // The timestamp is the hover-revealed half of the row and its width changes
    // as the relative string ticks; leading the checks with it would park the
    // one always-visible mark at a moving offset from the bubble's corner.
    const row = screen.getByTestId('steer-receipt').parentElement;
    const children = Array.from(row?.children ?? []);
    expect(children.map((child) => child.getAttribute('data-testid'))).toEqual([
      'steer-timestamp',
      'steer-receipt',
    ]);
  });
});

describe('SteerPart presentation', () => {
  beforeEach(() => {
    mockShareContext = {};
    mockFileMap = {};
  });

  it('presents the steer as a compact user bubble with accessible attribution', () => {
    renderPart();
    const message = screen.getByText('steered words');

    expect(message.closest('.bg-surface-tertiary')).toHaveClass('rounded-theme-surface');
    expect(screen.getByRole('heading', { name: 'Danny' })).toHaveClass('sr-only');
    expect(screen.queryByTitle('Danny')).not.toBeInTheDocument();
  });

  it('anchors the steer for the message-nav rail', () => {
    renderPart();
    const part = screen.getByTestId('steer-part');
    expect(part).toHaveAttribute('id', 'steer-s1');
    expect(part).toHaveClass('steer-render');
  });

  it('stays on the message content edge instead of outdenting', () => {
    renderPart();
    const part = screen.getByTestId('steer-part');
    expect(part).toHaveClass('w-full');
    expect(part).not.toHaveClass('md:-ml-9', '-ml-9');
  });

  it('renders steer attachments', () => {
    renderPart([
      { file_id: 'f1', filename: 'notes.pdf', type: 'application/pdf' },
      { file_id: 'f2', filename: 'shot.png', type: 'image/png', filepath: '/images/shot.png' },
    ]);
    expect(screen.getByTestId('steer-file')).toHaveTextContent('notes.pdf');
    expect(screen.getByTestId('steer-image')).toBeInTheDocument();
  });

  it.each(['application/pdf', 'image/png'])(
    'opens extracted previews for %s attachments',
    (type) => {
      mockFileMap = { f1: { llmDeliveryPath: 'text' } };
      renderPart([{ file_id: 'f1', filename: 'notes.pdf', type }]);
      expect(screen.queryByTestId('steer-file-preview')).toBeNull();

      fireEvent.click(screen.getByTestId('steer-file'));
      expect(screen.getByTestId('steer-file-preview')).toHaveTextContent('notes.pdf');
      expect(screen.getByTestId('steer-file-preview')).toHaveAttribute(
        'data-delivery-path',
        'text',
      );
    },
  );

  it('renders quoted excerpts as reference blocks inside the bubble', () => {
    render(
      <RecoilRoot initializeState={({ set }) => set(store.user, SEEDED_USER as never)}>
        <SteerPart
          steer="steered words"
          steerId="s1"
          createdAt={1}
          quotes={['the selected excerpt']}
        />
      </RecoilRoot>,
    );
    const quotes = screen.getByTestId('message-quotes');
    expect(quotes).toHaveTextContent('the selected excerpt');
    expect(quotes.closest('.bg-surface-tertiary')).not.toBeNull();
  });

  it('renders no quote block when the steer carried none', () => {
    renderPart();
    expect(screen.queryByTestId('message-quotes')).toBeNull();
  });
});

describe('SteerPart live receipt draw-in', () => {
  function LiveIdsProbe() {
    const ids = useRecoilValue(store.liveAppliedSteerIds);
    return <div data-testid="live-ids">{ids.join(',')}</div>;
  }

  function renderLive(liveIds: string[]) {
    return render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.user, SEEDED_USER as never);
          set(store.liveAppliedSteerIds, liveIds);
        }}
      >
        <SteerPart steer="steered words" steerId="s1" createdAt={1} />
        <LiveIdsProbe />
      </RecoilRoot>,
    );
  }

  const appliedChecks = () =>
    screen.getByLabelText('com_ui_steer_applied_info').querySelector('svg');

  it('animates the checks once when its applied event landed this session, then consumes the id', () => {
    renderLive(['s1', 'other']);
    expect(appliedChecks()).toHaveClass('animate-in');
    // Consumed on mount so a remount (revisit, reload) renders without motion;
    // unrelated ids survive for their own parts.
    expect(screen.getByTestId('live-ids')).toHaveTextContent('other');
  });

  it('renders the settled checks without the draw-in when not applied live', () => {
    renderLive([]);
    expect(appliedChecks()).not.toHaveClass('animate-in');
  });

  it('re-derives and consumes per identity when a slot is overwritten with another steer', () => {
    // ContentParts keys by content index, and applySteerPart permits a
    // different steer to overwrite that index — React reuses this component.
    const partFor = (steerId: string) => (
      <>
        <SteerPart steer="steered words" steerId={steerId} createdAt={1} />
        <LiveIdsProbe />
      </>
    );
    const { rerender } = render(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.user, SEEDED_USER as never);
          set(store.liveAppliedSteerIds, ['s2']);
        }}
      >
        {partFor('s1')}
      </RecoilRoot>,
    );
    expect(appliedChecks()).not.toHaveClass('animate-in');
    expect(screen.getByTestId('live-ids')).toHaveTextContent('s2');

    rerender(
      <RecoilRoot
        initializeState={({ set }) => {
          set(store.user, SEEDED_USER as never);
          set(store.liveAppliedSteerIds, ['s2']);
        }}
      >
        {partFor('s2')}
      </RecoilRoot>,
    );
    expect(appliedChecks()).toHaveClass('animate-in');
    expect(screen.getByTestId('live-ids').textContent).toBe('');
  });
});

describe('SteerPart receipt settling', () => {
  const checks = () => screen.getByLabelText('com_ui_steer_applied_info').querySelector('svg');

  it('keeps the steer identity while the owning response is still generating', () => {
    render(
      <RecoilRoot initializeState={({ set }) => set(store.user, SEEDED_USER as never)}>
        <SteerPart steer="steered words" steerId="s1" createdAt={1} isSubmitting />
      </RecoilRoot>,
    );
    expect(checks()).toHaveClass(STEER_ICON);
    expect(checks()).not.toHaveClass('text-text-secondary');
  });

  it('settles to timestamp gray once the response is done, and on reload/share', () => {
    // The default (no isSubmitting) is the settled, reload, share, and search
    // rendering: still a double check, no longer lit.
    renderPart();
    expect(checks()).toHaveClass('text-text-secondary');
    expect(checks()).not.toHaveClass(STEER_ICON);
  });
});
