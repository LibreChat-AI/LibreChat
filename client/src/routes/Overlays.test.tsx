import React, { StrictMode, useState } from 'react';
import { OverlayBack } from '@librechat/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBrowserRouter, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { replaceBrowserUrl } from '~/utils/overlays';
import Overlays from './Overlays';

let mockIsMobile = true;
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useMediaQuery: () =>
    jest.requireActual('react').useSyncExternalStore(
      (callback: () => void) => {
        globalThis.window.addEventListener('resize', callback);
        return () => globalThis.window.removeEventListener('resize', callback);
      },
      () => mockIsMobile,
    ),
}));

function Windows({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [nested, setNested] = useState(initialOpen);
  const [refuseClose, setRefuseClose] = useState(false);
  const [draft, setDraft] = useState('original');
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="route">{location.pathname}</output>
      <input aria-label="draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <button onClick={() => setOpen(true)}>{'Open'}</button>
      <button onClick={() => setOpen(false)}>{'Close'}</button>
      <button onClick={() => setRefuseClose((value) => !value)}>{'Toggle refusal'}</button>
      <button
        onClick={() => {
          setOpen(false);
          void navigate('/c/next');
        }}
      >
        {'Navigate'}
      </button>
      <button
        onClick={() => {
          setOpen(false);
          void navigate('/c/next', { replace: true });
        }}
      >
        {'Replace'}
      </button>
      <button onClick={() => replaceBrowserUrl('/c/stream-123?model=example')}>
        {'Promote URL'}
      </button>
      <OverlayBack
        open={open}
        onClose={() => {
          if (!refuseClose) setOpen(false);
        }}
      >
        {open && (
          <div role="dialog" aria-label="outer">
            <button onClick={() => setNested(true)}>{'Open nested'}</button>
            <button onClick={() => setNested(false)}>{'Close nested'}</button>
            <OverlayBack open={nested} onClose={() => setNested(false)}>
              {nested && <div role="dialog" aria-label="inner" />}
            </OverlayBack>
          </div>
        )}
      </OverlayBack>
    </>
  );
}

class MockCloseWatcher extends EventTarget {
  static active = new Set<MockCloseWatcher>();

  constructor() {
    super();
    MockCloseWatcher.active.add(this);
  }

  destroy() {
    MockCloseWatcher.active.delete(this);
  }

  close() {
    this.destroy();
    this.dispatchEvent(new Event('close'));
  }
}

describe('native mobile overlay dismissal', () => {
  let router: ReturnType<typeof createBrowserRouter>;
  let navigation: EventTarget & { currentEntry: { index: number } };

  function mount(initialOpen = false) {
    window.history.replaceState({ key: 'before', idx: 0 }, '', '/before');
    window.history.pushState({ key: 'chat', idx: 1, usr: { preserved: true } }, '', '/c/chat');
    router = createBrowserRouter([
      {
        element: <Overlays />,
        children: [{ path: '*', element: <Windows initialOpen={initialOpen} /> }],
      },
    ]);
    return render(
      <StrictMode>
        <RouterProvider router={router} useTransitions={false} />
      </StrictMode>,
    );
  }

  async function open() {
    fireEvent.click(screen.getByText('Open', { selector: 'button' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'outer' })).toBeVisible());
  }

  function traverse({ forward = false, cancelable = true, sameDocument = true } = {}) {
    navigation.currentEntry.index = window.history.state.idx;
    const event = Object.assign(new Event('navigate', { cancelable }), {
      navigationType: 'traverse',
      destination: {
        index: navigation.currentEntry.index + (forward ? 1 : -1),
        sameDocument,
      },
    });
    navigation.dispatchEvent(event);
    return event;
  }

  async function back(options = {}) {
    await act(async () => {
      if (!traverse(options).defaultPrevented) window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function forward() {
    await act(async () => {
      if (!traverse({ forward: true }).defaultPrevented) window.history.forward();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  async function nativeClose() {
    await waitFor(() => expect(MockCloseWatcher.active.size).toBe(1));
    act(() => [...MockCloseWatcher.active][0].close());
  }

  beforeEach(() => {
    mockIsMobile = true;
    MockCloseWatcher.active.clear();
    navigation = Object.assign(new EventTarget(), { currentEntry: { index: 1 } });
    Object.defineProperty(window, 'navigation', { configurable: true, value: navigation });
    Object.defineProperty(window, 'CloseWatcher', { configurable: true, value: MockCloseWatcher });
  });
  afterEach(() => {
    router?.dispose();
  });

  it('cancels supported Back without changing URL, draft, state or history length', async () => {
    mount();
    const state = window.history.state;
    const length = window.history.length;
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'unsaved words' } });
    await open();
    await back();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/c/chat');
    expect(window.history.state).toEqual(state);
    expect(window.history.length).toBe(length);
    expect(screen.getByLabelText('draft')).toHaveValue('unsaved words');
    await back();
    await waitFor(() => expect(window.location.pathname).toBe('/before'));
  });

  it('closes explicitly without adding a dead Back step', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    await back();
    await waitFor(() => expect(window.location.pathname).toBe('/before'));
  });

  it('closes nested windows one at a time without adding history', async () => {
    mount();
    const length = window.history.length;
    await open();
    fireEvent.click(screen.getByText('Open nested'));
    await back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'inner' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
    expect(window.history.length).toBe(length);
    await back();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.history.length).toBe(length);
  });

  it('uses one native watcher for initially open nested windows under StrictMode', async () => {
    mount(true);
    await nativeClose();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'inner' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
    await nativeClose();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(MockCloseWatcher.active.size).toBe(0));
  });

  it.each(['Back', 'native close'])(
    'preserves controlled refusal of %s and accepts a later close',
    async (method) => {
      mount();
      await open();
      fireEvent.click(screen.getByText('Toggle refusal'));
      const close = method === 'Back' ? back : nativeClose;
      await close();
      expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
      expect(window.location.pathname).toBe('/c/chat');
      fireEvent.click(screen.getByText('Toggle refusal'));
      await close();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    },
  );

  it('does not undo navigation issued in the same action as dismissal', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Navigate'));
    await waitFor(() => expect(screen.getByLabelText('route')).toHaveTextContent('/c/next'));
    await back();
    await waitFor(() => expect(router.state.location.key).toBe('chat'));
    expect(window.location.pathname).toBe('/c/chat');
  });

  it('protects a rapidly reopened window without scheduling a history traversal', async () => {
    mount();
    const go = jest.spyOn(window.history, 'go');
    const backSpy = jest.spyOn(window.history, 'back');
    await open();
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    fireEvent.click(screen.getByText('Open', { selector: 'button' }));
    await nativeClose();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(go).not.toHaveBeenCalled();
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('does not add history or intercept navigation on desktop', async () => {
    mockIsMobile = false;
    mount();
    fireEvent.click(screen.getByText('Open', { selector: 'button' }));
    expect(window.history.state.key).toBe('chat');
    await back();
    await waitFor(() => expect(window.location.pathname).toBe('/before'));
    expect(MockCloseWatcher.active.size).toBe(0);
  });

  it('preserves the open window and draft when crossing to desktop', async () => {
    mount();
    await open();
    fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'keep on resize' } });
    await waitFor(() => expect(MockCloseWatcher.active.size).toBe(1));
    act(() => {
      mockIsMobile = false;
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(MockCloseWatcher.active.size).toBe(0));
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeVisible();
    expect(screen.getByLabelText('draft')).toHaveValue('keep on resize');
    expect(window.location.pathname).toBe('/c/chat');
    act(() => {
      mockIsMobile = true;
      window.dispatchEvent(new Event('resize'));
    });
    await nativeClose();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not resurrect a dismissed window on Forward and protects a reopened one', async () => {
    mount();
    await open();
    await back();
    await back();
    await forward();
    expect(window.location.pathname).toBe('/c/chat');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await open();
    await back();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
  });

  it.each(['explicit', 'Back', 'native close'])(
    'preserves an existing Forward destination after %s dismissal',
    async (method) => {
      mount();
      await act(async () => {
        await router.navigate('/c/next');
      });
      await back();
      await waitFor(() => expect(router.state.location.pathname).toBe('/c/chat'));
      const length = window.history.length;
      await open();
      if (method === 'explicit') fireEvent.click(screen.getByText('Close', { selector: 'button' }));
      else if (method === 'Back') await back();
      else await nativeClose();
      expect(window.history.length).toBe(length);
      await forward();
      await waitFor(() => expect(router.state.location.pathname).toBe('/c/next'));
    },
  );

  it('does not reopen a window or leave ghost entries after a router remount', async () => {
    const view = mount();
    await open();
    view.unmount();
    expect(MockCloseWatcher.active.size).toBe(0);
    router.dispose();
    router = createBrowserRouter([
      { element: <Overlays />, children: [{ path: '*', element: <Windows /> }] },
    ]);
    render(<RouterProvider router={router} useTransitions={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
  });

  it('does not undo navigation immediately following explicit close', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    fireEvent.click(screen.getByText('Navigate'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/next'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(router.state.location.pathname).toBe('/c/next');
  });

  it('preserves REPLACE semantics while an overlay is open', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Replace', { selector: 'button' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/next'));
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
  });

  it('preserves Back and Forward across consecutive real REPLACEs', async () => {
    mount();
    for (const pathname of ['/c/next', '/c/third']) {
      await open();
      await act(async () => {
        await router.navigate(pathname, { replace: true });
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
    await forward();
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/third'));
  });

  it.each(['before opening', 'while open'])(
    'preserves a mirrored streaming URL %s without switching routes',
    async (when) => {
      mount();
      if (when === 'while open') await open();
      fireEvent.click(screen.getByText('Promote URL'));
      if (when === 'before opening') await open();
      expect(window.location.pathname).toBe('/c/stream-123');
      expect(router.state.location.pathname).toBe('/c/chat');
      await back();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(window.location.pathname).toBe('/c/stream-123');
      expect(window.location.search).toBe('?model=example');
      expect(router.state.location.pathname).toBe('/c/chat');
      expect(window.history.state.usr).toEqual({ preserved: true });
    },
  );

  it.each(['before opening', 'while open'])(
    'keeps an overlay open when FINAL synchronizes a route mirrored %s',
    async (when) => {
      mount();
      if (when === 'while open') await open();
      fireEvent.click(screen.getByText('Promote URL'));
      if (when === 'before opening') await open();
      const length = window.history.length;
      await act(async () => {
        await router.navigate('/c/stream-123', { replace: true, state: { synchronized: true } });
      });
      expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/c/stream-123');
      expect(window.history.length).toBe(length);
      const key = router.state.location.key;
      await back();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(window.location.pathname).toBe('/c/stream-123');
      expect(window.location.search).toBe('');
      expect(window.history.state.key).toBe(key);
      expect(window.history.state.usr).toEqual({ synchronized: true });
      await back();
      await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
    },
  );

  it('keeps nested overlays through FINAL and closes explicitly without a dead Back step', async () => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Open nested'));
    fireEvent.click(screen.getByText('Promote URL'));
    await act(async () => {
      await router.navigate('/c/stream-123', { replace: true });
    });
    expect(screen.getByRole('dialog', { name: 'inner' })).toBeInTheDocument();
    await back();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'inner' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('dialog', { name: 'outer' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close', { selector: 'button' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/c/stream-123');
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
    await forward();
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/stream-123'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    { pathname: '/c/stream-123', replace: false },
    { pathname: '/c/elsewhere', replace: true },
  ])('still dismisses on real navigation after mirroring: %o', async ({ pathname, replace }) => {
    mount();
    await open();
    fireEvent.click(screen.getByText('Promote URL'));
    await act(async () => {
      await router.navigate(pathname, { replace });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(pathname);
  });

  it.each([{ cancelable: false }, { sameDocument: false }, { forward: true }])(
    'does not intercept unsupported traversal: %o',
    async (options) => {
      mount();
      await open();
      const event = traverse(options);
      expect(event.defaultPrevented).toBe(false);
      expect(screen.getByRole('dialog', { name: 'outer' })).toBeVisible();
    },
  );

  it('leaves normal Back available without native APIs', async () => {
    Object.defineProperty(window, 'navigation', { configurable: true, value: undefined });
    Object.defineProperty(window, 'CloseWatcher', { configurable: true, value: undefined });
    mount();
    const length = window.history.length;
    await open();
    expect(window.history.length).toBe(length);
    await back();
    await waitFor(() => expect(router.state.location.pathname).toBe('/before'));
    expect(MockCloseWatcher.active.size).toBe(0);
  });
});
