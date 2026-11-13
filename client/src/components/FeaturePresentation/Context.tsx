import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { atom, useAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NavigationPage, NavigationView, NavigationConfig } from 'librechat-data-provider';
import type { ComponentType, ReactNode, MutableRefObject } from 'react';
import type { Location } from 'react-router-dom';
import type { NavLink } from '~/common';
import {
  getChatReturnUrl,
  getPageForPath,
  getPageSettings,
  getRelatedPage,
  pageRegistry,
} from './registry';

type Feature = ComponentType<{ visible: boolean }>;
type Slot = { node: HTMLDivElement; page: NavigationPage; view: NavigationView; visible: boolean };
export type PageAvailability =
  | { status: 'ready' | 'loading' }
  | { status: 'error'; retry: () => void };

type Presentation = {
  startupError?: () => void;
  availability: Partial<Record<NavigationPage, PageAvailability>>;
  chatLocation?: Location;
  updateChatLocation: (location: Location) => void;
  ready: boolean;
  links: NavLink[];
  openPanel: (navId: string) => void;
  page?: NavigationPage;
  relatedPage?: NavigationPage;
  view: NavigationView;
  expand: (page: NavigationPage) => void;
  minimize: (page: NavigationPage) => void;
  open: (page: NavigationPage) => void;
  canOpenPage: (page: NavigationPage) => boolean;
  register: (slot: Slot) => () => void;
};

const Context = createContext<Presentation | undefined>(undefined);
export const FeatureVisibility = createContext(false);

export function useFeaturePresentation() {
  return useContext(Context);
}

function Session({
  Feature,
  slot,
  focusTarget,
}: {
  Feature: Feature;
  slot?: Slot;
  focusTarget: MutableRefObject<HTMLElement | null>;
}) {
  const container = useMemo(() => document.createElement('div'), []);
  container.className = 'flex min-h-0 flex-1 flex-col';
  useLayoutEffect(() => {
    slot?.node.appendChild(container);
    const target = focusTarget.current;
    if (slot?.visible && target && container.contains(target)) {
      target.focus({ preventScroll: true });
      focusTarget.current = null;
    }
    return () => container.remove();
  }, [container, slot?.node, slot?.visible, focusTarget]);
  return createPortal(<Feature visible={slot?.visible ?? false} />, container);
}

/** The host supplies authorized links. Presentation never grants feature permissions. */
export function FeaturePresentationProvider({
  children,
  links,
  features,
  navigation,
  onPanelOpen,
  ready = true,
  startupError,
  availability = {},
  revealPage = (show: () => void) => show(),
}: {
  availability?: Partial<Record<NavigationPage, PageAvailability>>;
  revealPage?: (show: () => void) => void;
  ready?: boolean;
  startupError?: () => void;
  children: ReactNode;
  links: NavLink[];
  features: Partial<Record<NavigationPage, Feature>>;
  navigation?: NavigationConfig;
  onPanelOpen: (navId: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const focusTarget = useRef<HTMLElement | null>(null);
  const state = useMemo(
    () => ({
      slots: atom<Slot[]>([]),
      mounted: atom<Partial<Record<NavigationPage, boolean>>>({}),
      returnUrl: atom('/c/new'),
      chatLocation: atom<Location | undefined>(undefined),
    }),
    [],
  );
  const [slots, setSlots] = useAtom(state.slots);
  const [mounted, setMounted] = useAtom(state.mounted);
  const [returnUrl, setReturnUrl] = useAtom(state.returnUrl);
  const [chatLocation, setChatLocation] = useAtom(state.chatLocation);
  const updateChatLocation = useCallback(
    (next: Location) => {
      setChatLocation(next);
      setReturnUrl(getChatReturnUrl(next.pathname + next.search + next.hash));
    },
    [setChatLocation, setReturnUrl],
  );
  useLayoutEffect(() => {
    if (/^\/c(?:\/|$)/.test(location.pathname)) {
      setChatLocation(undefined);
      setReturnUrl(getChatReturnUrl(location.pathname + location.search + location.hash));
    }
  }, [location.pathname, location.search, location.hash, setChatLocation, setReturnUrl]);
  const relatedPage = getRelatedPage(location.pathname);
  const routePage = getPageForPath(location.pathname);
  const page = routePage && features[routePage] ? routePage : undefined;
  const canUse = useCallback(
    (target: NavigationPage) =>
      links.some((link) => link.id === pageRegistry[target].navId && !link.disabled),
    [links],
  );
  const canOpenPage = useCallback(
    (target: NavigationPage) =>
      ready &&
      features[target] != null &&
      (availability[target]?.status ?? 'ready') === 'ready' &&
      canUse(target) &&
      getPageSettings(navigation, target).enabled,
    [ready, features, canUse, navigation, availability],
  );
  const expand = useCallback(
    (target: NavigationPage) => {
      if (!canOpenPage(target) || (relatedPage === target && page !== target)) {
        return;
      }
      if (!relatedPage) {
        setChatLocation(undefined);
        setReturnUrl(getChatReturnUrl(location.pathname + location.search + location.hash));
      }
      focusTarget.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      revealPage(() => navigate(pageRegistry[target].path));
    },
    [
      canOpenPage,
      relatedPage,
      page,
      location.pathname,
      location.search,
      location.hash,
      navigate,
      setReturnUrl,
      setChatLocation,
      revealPage,
    ],
  );
  const minimize = useCallback(
    (target: NavigationPage) => {
      if (!canUse(target)) {
        return;
      }
      focusTarget.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      onPanelOpen(pageRegistry[target].navId);
      navigate(getChatReturnUrl(returnUrl));
    },
    [canUse, onPanelOpen, navigate, returnUrl],
  );
  const openPanel = useCallback(
    (navId: string) => {
      if (!links.some((link) => link.id === navId && !link.disabled)) {
        return;
      }
      onPanelOpen(navId);
      if (relatedPage) {
        navigate(getChatReturnUrl(returnUrl));
      }
    },
    [links, onPanelOpen, relatedPage, navigate, returnUrl],
  );
  const open = useCallback(
    (target: NavigationPage) => {
      if (!canUse(target)) {
        return;
      }
      if (relatedPage === target && page !== target) {
        onPanelOpen(pageRegistry[target].navId);
        return;
      }
      if (canOpenPage(target) && getPageSettings(navigation, target).defaultView === 'page') {
        expand(target);
        return;
      }
      openPanel(pageRegistry[target].navId);
    },
    [canUse, relatedPage, page, onPanelOpen, canOpenPage, navigation, expand, openPanel],
  );
  const register = useCallback(
    (slot: Slot) => {
      setSlots((previous) => [...previous, slot]);
      setMounted((previous) =>
        previous[slot.page] ? previous : { ...previous, [slot.page]: true },
      );
      return () => setSlots((previous) => previous.filter((entry) => entry !== slot));
    },
    [setSlots, setMounted],
  );
  const value = useMemo<Presentation>(
    () => ({
      ready,
      startupError,
      availability,
      chatLocation,
      updateChatLocation,
      links,
      openPanel,
      page,
      relatedPage,
      view: page ? 'page' : 'panel',
      expand,
      minimize,
      open,
      canOpenPage,
      register,
    }),
    [
      ready,
      startupError,
      availability,
      chatLocation,
      updateChatLocation,
      links,
      openPanel,
      page,
      relatedPage,
      expand,
      minimize,
      open,
      canOpenPage,
      register,
    ],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {(Object.keys(features) as NavigationPage[]).map((target) => {
        const Feature = features[target];
        if (!ready || !Feature || !canUse(target) || (!mounted[target] && page !== target)) {
          return null;
        }
        if (
          (availability[target]?.status ?? 'ready') !== 'ready' ||
          (page === target && !canOpenPage(target))
        ) {
          return null;
        }
        const view = page === target ? 'page' : 'panel';
        const slot = slots.find((entry) => entry.page === target && entry.view === view);
        return <Session key={target} Feature={Feature} slot={slot} focusTarget={focusTarget} />;
      })}
    </Context.Provider>
  );
}

export function FeatureSlot({
  page,
  view,
  visible,
}: {
  page: NavigationPage;
  view: NavigationView;
  visible: boolean;
}) {
  const register = useFeaturePresentation()?.register;
  const nodeAtom = useMemo(() => atom<HTMLDivElement | null>(null), []);
  const [node, setNode] = useAtom(nodeAtom);
  useLayoutEffect(() => {
    if (node && register) {
      return register({ node, page, view, visible });
    }
  }, [node, register, page, view, visible]);
  return <div ref={setNode} className="flex min-h-0 flex-1 flex-col" />;
}
