import { useEffect, useState } from 'react';
import type { IThemeAppearance } from '@librechat/client';
import type { ComponentType } from 'react';

/**
 * What the welcome screen paints behind its greeting and composer is a theme's to ask
 * for: the theme sets `welcomeBackdrop`, which reaches the document as
 * `--theme-welcome-backdrop`, and the app paints the component registered for that value.
 * No component names a theme, and a theme that asks for a backdrop this build does not
 * register keeps the plain surface.
 */
export type WelcomeBackdropId = Exclude<IThemeAppearance['welcomeBackdrop'], 'none'>;

const BACKDROP_PROPERTY = '--theme-welcome-backdrop';

const backdrops = new Map<WelcomeBackdropId, ComponentType>();

/**
 * Provides the component a theme's `welcomeBackdrop` value paints. Register before the
 * app renders. The component mounts inside the welcome column, a positioned box that
 * holds the greeting and the composer, and is gone once a conversation starts; it should
 * fill that box (`absolute inset-0`), take no pointer events of its own, hide from
 * assistive technology, and keep still under `prefers-reduced-motion`. Returns the
 * unregister.
 */
export function registerWelcomeBackdrop(id: WelcomeBackdropId, component: ComponentType) {
  backdrops.set(id, component);
  return () => {
    if (backdrops.get(id) === component) {
      backdrops.delete(id);
    }
  };
}

const readBackdrop = (): string => {
  if (typeof window === 'undefined') {
    return 'none';
  }
  return (
    getComputedStyle(document.documentElement).getPropertyValue(BACKDROP_PROPERTY).trim() || 'none'
  );
};

/** Read from the document root, where a theme is applied and where a swap announces
 * itself: `applyResolvedTheme` names the theme in `data-theme`, and a mode switch
 * toggles the root's class. */
function useThemeBackdrop(): string {
  const [backdrop, setBackdrop] = useState(readBackdrop);

  useEffect(() => {
    const read = () => setBackdrop(readBackdrop());
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return backdrop;
}

/** The welcome screen's backdrop, or nothing when the theme asks for none or the build
 * registers none for its value. */
export default function WelcomeBackdrop() {
  const backdrop = useThemeBackdrop();
  const Component = backdrop === 'none' ? undefined : backdrops.get(backdrop as WelcomeBackdropId);
  return Component ? <Component /> : null;
}
