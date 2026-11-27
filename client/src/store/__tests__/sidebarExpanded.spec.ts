const KEY = 'unifiedSidebarExpanded';

/** The shared setup defines `matchMedia` as writable, so assign over it. */
const setViewport = (isSmall: boolean) => {
  window.matchMedia = ((query: string) => ({
    matches: isSmall && query === '(max-width: 768px)',
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    onchange: null,
    dispatchEvent: jest.fn(),
  })) as unknown as typeof window.matchMedia;
};

/**
 * The atom reads the viewport at module load, so each case needs a fresh
 * import — and Recoil must come from the same registry as the reloaded atom.
 */
const readInitialValue = async (): Promise<boolean> => {
  const { snapshot_UNSTABLE } = await import('recoil');
  const settings = await import('../settings');
  return snapshot_UNSTABLE().getLoadable(settings.default.sidebarExpanded).valueOrThrow();
};

describe('sidebarExpanded', () => {
  beforeEach(() => {
    jest.resetModules();
    localStorage.clear();
  });

  it('ignores a persisted open drawer on a small viewport', async () => {
    setViewport(true);
    localStorage.setItem(KEY, JSON.stringify(true));

    /**
     * Normalized during initialization rather than corrected by an effect, so
     * the closed state reaches the first paint — otherwise the nav covers the
     * app and animates shut afterwards.
     */
    expect(await readInitialValue()).toBe(false);
  });

  it('honours a persisted collapsed sidebar on a wide viewport', async () => {
    setViewport(false);
    localStorage.setItem(KEY, JSON.stringify(false));

    expect(await readInitialValue()).toBe(false);
  });

  it('honours a persisted open sidebar on a wide viewport', async () => {
    setViewport(false);
    localStorage.setItem(KEY, JSON.stringify(true));

    expect(await readInitialValue()).toBe(true);
  });

  it('starts closed on a small viewport with nothing persisted', async () => {
    setViewport(true);

    expect(await readInitialValue()).toBe(false);
  });

  /**
   * The default is captured when the module is evaluated, which on a login
   * screen can be long before the app mounts. Without a persisted key there is
   * no saved value to normalize, so a viewport that narrows in between would
   * otherwise leave the drawer covering the first authenticated screen.
   */
  it('rechecks the viewport when no value was ever persisted', async () => {
    setViewport(false);
    const { snapshot_UNSTABLE } = await import('recoil');
    const settings = await import('../settings');

    setViewport(true);

    expect(snapshot_UNSTABLE().getLoadable(settings.default.sidebarExpanded).valueOrThrow()).toBe(
      false,
    );
  });

  it('starts open on a wide viewport with nothing persisted', async () => {
    setViewport(false);

    expect(await readInitialValue()).toBe(true);
  });
});
