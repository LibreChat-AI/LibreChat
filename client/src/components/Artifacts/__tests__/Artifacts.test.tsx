import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import type { Artifact } from '~/common';
import { act, fireEvent, render, screen } from 'test/layout-test-utils';
import { ArtifactsProvider, EditorProvider } from '~/Providers';
import Artifacts from '../Artifacts';
import store from '~/store';

const mockRequestFullscreen = jest.fn<Promise<void>, []>();
const mockExitFullscreen = jest.fn<Promise<void>, []>();
const clearArtifactsLabel = 'Clear artifacts';
const restoreArtifactsLabel = 'Restore artifacts';

const primaryArtifact: Artifact = {
  id: 'artifact-1',
  type: 'text/html',
  title: 'Preview',
  lastUpdateTime: 0,
};

const secondaryArtifact: Artifact = {
  ...primaryArtifact,
  id: 'artifact-2',
  title: 'Preview v2',
  lastUpdateTime: 1,
};

type BrowserPropertyDescriptors = {
  fullscreenElement?: PropertyDescriptor;
  fullscreenEnabled?: PropertyDescriptor;
  exitFullscreen?: PropertyDescriptor;
  requestFullscreen?: PropertyDescriptor;
  matchMedia?: PropertyDescriptor;
};

let originalDescriptors: BrowserPropertyDescriptors;

const restoreProperty = (
  target: object,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) => {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
};

const setFullscreenElement = (element: Element | null) => {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: element,
  });
};

const setMobileViewport = (isMobile: boolean) => {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: isMobile && query.includes('max-width'),
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
};

const initializeArtifacts =
  (artifacts: Artifact[]) =>
  ({ set }: MutableSnapshot) => {
    set(
      store.artifactsState,
      Object.fromEntries(artifacts.map((artifact) => [artifact.id, artifact])),
    );
    set(store.currentArtifactId, artifacts[0]?.id ?? null);
    set(store.queriesEnabled, false);
  };

function ArtifactStateControls() {
  const setArtifacts = useSetRecoilState(store.artifactsState);

  return (
    <>
      <button type="button" onClick={() => setArtifacts(null)}>
        {clearArtifactsLabel}
      </button>
      <button type="button" onClick={() => setArtifacts({ [primaryArtifact.id]: primaryArtifact })}>
        {restoreArtifactsLabel}
      </button>
    </>
  );
}

const renderArtifacts = async ({
  artifacts = [primaryArtifact],
  includeStateControls = false,
}: {
  artifacts?: Artifact[];
  includeStateControls?: boolean;
} = {}) => {
  render(
    <RecoilRoot initializeState={initializeArtifacts(artifacts)}>
      <EditorProvider>
        <ArtifactsProvider
          value={{
            isSubmitting: false,
            latestMessageId: null,
            latestMessageText: '',
            conversationId: 'conversation-1',
            canUndock: true,
          }}
        >
          {includeStateControls && <ArtifactStateControls />}
          <Artifacts />
        </ArtifactsProvider>
      </EditorProvider>
    </RecoilRoot>,
  );

  await screen.findByRole('button', { name: 'Refresh' });
};

describe('Artifacts fullscreen preview', () => {
  beforeEach(() => {
    originalDescriptors = {
      fullscreenElement: Object.getOwnPropertyDescriptor(document, 'fullscreenElement'),
      fullscreenEnabled: Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled'),
      exitFullscreen: Object.getOwnPropertyDescriptor(document, 'exitFullscreen'),
      requestFullscreen: Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        'requestFullscreen',
      ),
      matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
    };

    mockRequestFullscreen.mockReset();
    mockExitFullscreen.mockReset();
    setMobileViewport(false);
    setFullscreenElement(null);
    Object.defineProperty(document, 'fullscreenEnabled', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: mockRequestFullscreen,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: mockExitFullscreen,
    });
    mockRequestFullscreen.mockImplementation(function (this: HTMLElement) {
      setFullscreenElement(this);
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
    mockExitFullscreen.mockImplementation(() => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    });
  });

  afterEach(() => {
    restoreProperty(document, 'fullscreenElement', originalDescriptors.fullscreenElement);
    restoreProperty(document, 'fullscreenEnabled', originalDescriptors.fullscreenEnabled);
    restoreProperty(document, 'exitFullscreen', originalDescriptors.exitFullscreen);
    restoreProperty(
      HTMLElement.prototype,
      'requestFullscreen',
      originalDescriptors.requestFullscreen,
    );
    restoreProperty(window, 'matchMedia', originalDescriptors.matchMedia);
  });

  it('enters and exits fullscreen from the preview header', async () => {
    await renderArtifacts();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }));
    });

    expect(mockRequestFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    });

    expect(mockExitFullscreen).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Enter full screen' })).toBeInTheDocument();
  });

  it('ignores fullscreen changes while the artifact container is not rendered', async () => {
    await renderArtifacts({ includeStateControls: true });

    fireEvent.click(screen.getByRole('button', { name: clearArtifactsLabel }));
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();

    act(() => {
      setFullscreenElement(null);
      document.dispatchEvent(new Event('fullscreenchange'));
    });

    fireEvent.click(screen.getByRole('button', { name: restoreArtifactsLabel }));

    expect(await screen.findByRole('button', { name: 'Enter full screen' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Exit full screen' })).not.toBeInTheDocument();
  });

  it('expands the mobile artifact panel to fill the fullscreen container', async () => {
    setMobileViewport(true);
    await renderArtifacts();

    const closeButton = screen.getByRole('button', { name: 'Close' });
    const panel = closeButton.parentElement?.parentElement?.parentElement;

    expect(panel).toHaveStyle({ height: '90vh' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }));
    });

    expect(panel).toHaveStyle({ height: '100%' });
    expect(panel).toHaveClass('inset-0', 'rounded-none');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    });

    expect(panel).toHaveStyle({ height: '90vh' });
    expect(panel).toHaveClass('inset-x-0', 'bottom-0', 'rounded-t-[20px]');
  });

  it('keeps the mobile version menu above the fullscreen panel', async () => {
    setMobileViewport(true);
    await renderArtifacts({ artifacts: [primaryArtifact, secondaryArtifact] });

    const closeButton = screen.getByRole('button', { name: 'Close' });
    const panel = closeButton.parentElement?.parentElement?.parentElement;

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Change Version' }));
    const versionMenu = await screen.findByRole('menu');
    const fullscreenPortal = screen.getByTestId('artifact-fullscreen-portal');

    expect(panel).toHaveClass('z-[100]');
    expect(fullscreenPortal).toHaveClass('z-[101]');
    expect(document.fullscreenElement).toContainElement(versionMenu);
    expect(fullscreenPortal).toContainElement(versionMenu);
  });

  it.each([
    { label: 'Change Version', artifacts: [primaryArtifact, secondaryArtifact], screenX: 1 },
    { label: 'Copy', artifacts: [primaryArtifact], screenX: 2 },
  ])(
    'keeps the $label tooltip inside the fullscreen container',
    async ({ label, artifacts, screenX }) => {
      await renderArtifacts({ artifacts });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Enter full screen' }));
      });

      const control = screen.getByRole('button', { name: label });
      fireEvent.mouseEnter(control);
      fireEvent.mouseMove(control, { screenX });
      const tooltip = await screen.findByRole('tooltip');
      const fullscreenPortal = screen.getByTestId('artifact-fullscreen-portal');

      expect(tooltip).toHaveTextContent(label);
      expect(document.fullscreenElement).toContainElement(tooltip);
      expect(fullscreenPortal).toContainElement(tooltip);
    },
  );

  it('hides the fullscreen control when the browser does not support it', async () => {
    Object.defineProperty(document, 'fullscreenEnabled', {
      configurable: true,
      value: false,
    });

    await renderArtifacts();

    expect(screen.queryByRole('button', { name: 'Enter full screen' })).not.toBeInTheDocument();
  });
});
