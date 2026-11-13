import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { atom, useAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { Spinner } from '@librechat/client';
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
import { chatJourney, chatJourneyState } from './journey';
import useLocalize from '~/hooks/useLocalize';

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
  setReturnTarget: (url: string) => void;
  ownsChatJourney: (entry: Pick<Location, 'key' | 'state'>) => boolean;
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
  return createPortal(
    <Suspense fallback={<SessionLoading />}>
      <Feature visible={slot?.visible ?? false} />
    </Suspense>,
    container,
  );
}

function SessionLoading() {
  const localize = useLocalize();
  return (
    <div
      role="status"
      aria-label={localize('com_ui_loading')}
      className="flex flex-1 items-center justify-center"
    >
      <Spinner />
      <span className="sr-only">{localize('com_ui_loading')}</span>
    </div>
  );
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
  const chatLocationRef = useRef(chatLocation);
  const journey = chatJourney(location);
  const journeyRef = useRef(journey);
  const ownsChatJourney = useCallback(
    (entry: Pick<Location, 'key' | 'state'>) => chatJourney(entry) === journeyRef.current,
    [],
  );
  const setReturnTarget = useCallback(
    (url: string) => setReturnUrl(getChatReturnUrl(url)),
    [setReturnUrl],
  );
  const updateChatLocation = useCallback(
    (next: Location) => {
      chatLocationRef.current = next;
      setChatLocation(next);
      setReturnUrl(getChatReturnUrl(next.pathname + next.search + next.hash));
    },
    [setChatLocation, setReturnUrl],
  );
  useLayoutEffect(() => {
    if (/^\/c(?:\/|$)/.test(location.pathname)) {
      journeyRef.current = journey;
      chatLocationRef.current = undefined;
      setChatLocation(undefined);
      setReturnUrl(getChatReturnUrl(location.pathname + location.search + location.hash));
    }
  }, [
    location.pathname,
    location.search,
    location.hash,
    location.key,
    journey,
    setChatLocation,
    setReturnUrl,
  ]);
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
      if (!relatedPage && !chatLocationRef.current) {
        setChatLocation(undefined);
        setReturnUrl(getChatReturnUrl(location.pathname + location.search + location.hash));
      }
      focusTarget.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const chatUrl = chatLocationRef.current;
      const currentUrl = location.pathname + location.search + location.hash;
      const originUrl = relatedPage ? returnUrl : currentUrl;
      const contextUrl = getChatReturnUrl(
        chatUrl ? chatUrl.pathname + chatUrl.search + chatUrl.hash : originUrl,
      );
      const path =
        target === 'parameters'
          ? pageRegistry[target].path + '?' + new URLSearchParams({ chat: contextUrl })
          : pageRegistry[target].path;
      revealPage(() =>
        navigate(path, {
          state: chatJourneyState(chatUrl ? chatJourney(chatUrl) : journeyRef.current),
        }),
      );
    },
    [
      canOpenPage,
      relatedPage,
      page,
      returnUrl,
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
      const destination = chatLocationRef.current;
      navigate(
        getChatReturnUrl(
          destination ? destination.pathname + destination.search + destination.hash : returnUrl,
        ),
        { state: chatJourneyState(destination ? chatJourney(destination) : journeyRef.current) },
      );
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
        const target = chatLocationRef.current;
        navigate(
          getChatReturnUrl(target ? target.pathname + target.search + target.hash : returnUrl),
          { state: chatJourneyState(target ? chatJourney(target) : journeyRef.current) },
        );
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
      setReturnTarget,
      ownsChatJourney,
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
      setReturnTarget,
      ownsChatJourney,
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
