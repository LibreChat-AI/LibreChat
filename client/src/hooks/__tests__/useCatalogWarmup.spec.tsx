import React from 'react';
import { render, act, cleanup } from '@testing-library/react';
import type { CatalogId } from '../useCatalogWarmup';
import {
  useCatalogWarmup,
  useCatalogReady,
  activateCatalog,
  resetCatalogWarmup,
} from '../useCatalogWarmup';

const CATALOG_IDS: CatalogId[] = ['prompts', 'mcpServers', 'mcpTools'];

let readyState: Record<CatalogId, boolean>;

function Harness({ authenticated }: { authenticated: boolean }) {
  useCatalogWarmup(authenticated);
  readyState = {
    prompts: useCatalogReady('prompts'),
    mcpServers: useCatalogReady('mcpServers'),
    mcpTools: useCatalogReady('mcpTools'),
  };
  return null;
}

const idleCallbacks: Array<() => void> = [];

function installIdleCallback() {
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
  });
}

function flushIdle() {
  act(() => {
    idleCallbacks.splice(0).forEach((callback) => callback());
  });
}

describe('useCatalogWarmup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    idleCallbacks.length = 0;
    installIdleCallback();
    resetCatalogWarmup();
  });

  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('keeps every catalog gated until idle fires and each stagger elapses', () => {
    render(<Harness authenticated={true} />);
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });

    flushIdle();
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });

    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(readyState.prompts).toBe(true);
    expect(readyState.mcpServers).toBe(false);

    act(() => {
      jest.advanceTimersByTime(250);
    });
    expect(readyState.mcpServers).toBe(true);
    expect(readyState.mcpTools).toBe(false);

    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(readyState.mcpTools).toBe(true);
  });

  it('does not schedule warmup while unauthenticated', () => {
    render(<Harness authenticated={false} />);

    act(() => {
      jest.runAllTimers();
    });
    expect(idleCallbacks.length).toBe(0);
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });
  });

  it('releases a catalog immediately on activation', () => {
    render(<Harness authenticated={true} />);
    flushIdle();

    act(() => {
      activateCatalog('mcpTools');
    });
    expect(readyState.mcpTools).toBe(true);
    expect(readyState.prompts).toBe(false);

    /** The superseded stagger timer must not flip anything back */
    act(() => {
      jest.runAllTimers();
    });
    CATALOG_IDS.forEach((id) => {
      expect(readyState[id]).toBe(true);
    });
  });

  it('falls back to a timeout when requestIdleCallback is unavailable', () => {
    Object.defineProperty(window, 'requestIdleCallback', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    render(<Harness authenticated={true} />);

    act(() => {
      jest.advanceTimersByTime(199);
    });
    expect(readyState.prompts).toBe(false);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    /** The stagger timer is scheduled from inside the fallback timeout */
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(readyState.prompts).toBe(true);
  });

  it('resets to fully gated state', () => {
    render(<Harness authenticated={true} />);
    flushIdle();
    act(() => {
      jest.runAllTimers();
    });

    act(() => {
      resetCatalogWarmup();
    });
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });
  });

  it('re-arms the schedule after logout so the next session warms again', () => {
    const view = render(<Harness authenticated={true} />);
    flushIdle();
    act(() => {
      jest.runAllTimers();
    });
    CATALOG_IDS.forEach((id) => expect(readyState[id]).toBe(true));

    view.rerender(<Harness authenticated={false} />);
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });

    view.rerender(<Harness authenticated={true} />);
    flushIdle();
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(readyState.prompts).toBe(true);
    expect(readyState.mcpTools).toBe(false);
  });

  it('voids idle callbacks scheduled before a logout', () => {
    const view = render(<Harness authenticated={true} />);
    /** Idle has not fired yet when the user logs out */
    view.rerender(<Harness authenticated={false} />);

    flushIdle();
    act(() => {
      jest.runAllTimers();
    });
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });

    /** The next session schedules and warms normally */
    view.rerender(<Harness authenticated={true} />);
    flushIdle();
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(readyState.prompts).toBe(true);
  });

  it('resets on unmount, for logouts that tear Root down without a false render', () => {
    const view = render(<Harness authenticated={true} />);
    flushIdle();
    act(() => {
      jest.runAllTimers();
    });
    CATALOG_IDS.forEach((id) => expect(readyState[id]).toBe(true));

    view.unmount();
    idleCallbacks.length = 0;

    render(<Harness authenticated={true} />);
    expect(readyState).toEqual({ prompts: false, mcpServers: false, mcpTools: false });
    flushIdle();
    act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(readyState.prompts).toBe(true);
  });
});
