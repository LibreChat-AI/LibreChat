import { act, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { RecoilRoot } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import UndockedArtifacts from '../UndockedArtifacts';
import { prepareUndockedDocument } from '../undockedWindow';
import { undockedArtifacts } from '../state';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string =>
      key,
}));

interface FakeWindow extends Window {
  closed: boolean;
}

const createFakeWindow = (): FakeWindow => {
  const detachedDocument = document.implementation.createHTMLDocument('');
  const fake = {
    document: detachedDocument,
    closed: false,
    outerWidth: 900,
    outerHeight: 700,
    screenX: 120,
    screenY: 40,
    focus: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    close: jest.fn(() => {
      fake.closed = true;
    }),
  };
  return fake as unknown as FakeWindow;
};

const artifact = {
  id: 'artifact-1',
  type: 'text/html',
  title: 'dashboard.html',
  content: '<p>hi</p>',
  lastUpdateTime: 1,
};

const seedArtifacts = ({ set }: MutableSnapshot) => {
  set(store.artifactsState, { [artifact.id]: artifact });
  set(store.currentArtifactId, artifact.id);
};

const renderUndocked = (detached: FakeWindow) => {
  const jotaiStore = createStore();
  jotaiStore.set(undockedArtifacts, {
    window: detached,
    root: prepareUndockedDocument(document, detached.document),
  });
  const view = render(
    <RecoilRoot initializeState={seedArtifacts}>
      <Provider store={jotaiStore}>
        <UndockedArtifacts>
          <div data-testid="artifact-pane" />
        </UndockedArtifacts>
      </Provider>
    </RecoilRoot>,
  );
  return { ...view, jotaiStore };
};

describe('UndockedArtifacts', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the pane inside the detached window rather than the host page', () => {
    const detached = createFakeWindow();

    const { jotaiStore } = renderUndocked(detached);

    const pane = detached.document.querySelector('[data-testid="artifact-pane"]');
    expect(pane).not.toBeNull();
    expect(pane?.closest('#undocked-artifacts-root')).not.toBeNull();
    expect(screen.queryByTestId('artifact-pane')).not.toBeInTheDocument();
    expect(detached.document.title).toBe('dashboard.html');
    expect(detached.document.head.querySelector('style')).not.toBeNull();
    expect(jotaiStore.get(undockedArtifacts)?.window).toBe(detached);
  });

  it('closes the window when the pane docks back', () => {
    const detached = createFakeWindow();
    const { unmount } = renderUndocked(detached);

    unmount();

    expect(detached.close).toHaveBeenCalled();
    expect(window.localStorage.getItem('artifacts:undocked-window-bounds')).toBe(
      JSON.stringify({ width: 900, height: 700, left: 120, top: 40 }),
    );
  });

  /* The user closing the popup is the other way to dock: the pane has to come
   * home, not vanish with the window. */
  it('docks the pane back when the user closes the window', () => {
    const detached = createFakeWindow();
    const { jotaiStore } = renderUndocked(detached);

    detached.closed = true;
    act(() => jest.advanceTimersByTime(500));

    expect(jotaiStore.get(undockedArtifacts)).toBeNull();
  });
});
