import { createContext, useCallback, useContext, useLayoutEffect, useMemo } from 'react';
import { atom, useAtom } from 'jotai';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { NavigationPage, NavigationView, NavigationConfig } from 'librechat-data-provider';
import type { ComponentType, ReactNode } from 'react';
import type { NavLink } from '~/common';
import { getChatReturnUrl, getPageForPath, getPageSettings, pageRegistry } from './registry';

type Feature = ComponentType<{ visible: boolean }>;
type Slot = { node: HTMLDivElement; page: NavigationPage; view: NavigationView; visible: boolean };
type Presentation = {
  ready: boolean;
  page?: NavigationPage;
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

function Session({ Feature, slot }: { Feature: Feature; slot?: Slot }) {
  const container = useMemo(() => document.createElement('div'), []);
  container.className = 'flex min-h-0 flex-1 flex-col';
  useLayoutEffect(() => {
    slot?.node.appendChild(container);
    return () => container.remove();
  }, [container, slot?.node]);
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
}: {
  ready?: boolean;
  children: ReactNode;
  links: NavLink[];
  features: Partial<Record<NavigationPage, Feature>>;
  navigation?: NavigationConfig;
  onPanelOpen: (navId: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(
    () => ({
      slots: atom<Slot[]>([]),
      mounted: atom<Partial<Record<NavigationPage, boolean>>>({}),
      returnUrl: atom('/c/new'),
    }),
    [],
  );
  const [slots, setSlots] = useAtom(state.slots);
  const [mounted, setMounted] = useAtom(state.mounted);
  const [returnUrl, setReturnUrl] = useAtom(state.returnUrl);
  const routePage = getPageForPath(location.pathname);
  const page = routePage && features[routePage] ? routePage : undefined;
  const canUse = useCallback(
    (target: NavigationPage) => links.some((link) => link.id === pageRegistry[target].navId),
    [links],
  );
  const canOpenPage = useCallback(
    (target: NavigationPage) =>
      ready &&
      features[target] != null &&
      canUse(target) &&
      getPageSettings(navigation, target).enabled,
    [ready, features, canUse, navigation],
  );
  const expand = useCallback(
    (target: NavigationPage) => {
      if (!canOpenPage(target)) {
        return;
      }
      if (!page) {
        setReturnUrl(getChatReturnUrl(location.pathname + location.search + location.hash));
      }
      navigate(pageRegistry[target].path);
    },
    [canOpenPage, page, location.pathname, location.search, location.hash, navigate, setReturnUrl],
  );
  const minimize = useCallback(
    (target: NavigationPage) => {
      if (!canUse(target)) {
        return;
      }
      onPanelOpen(pageRegistry[target].navId);
      navigate(getChatReturnUrl(returnUrl));
    },
    [canUse, onPanelOpen, navigate, returnUrl],
  );
  const open = useCallback(
    (target: NavigationPage) => {
      if (!canUse(target)) {
        return;
      }
      if (canOpenPage(target) && getPageSettings(navigation, target).defaultView === 'page') {
        expand(target);
        return;
      }
      onPanelOpen(pageRegistry[target].navId);
      if (page) {
        navigate(getChatReturnUrl(returnUrl));
      }
    },
    [canUse, canOpenPage, navigation, expand, onPanelOpen, page, navigate, returnUrl],
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
      page,
      view: page ? 'page' : 'panel',
      expand,
      minimize,
      open,
      canOpenPage,
      register,
    }),
    [ready, page, expand, minimize, open, canOpenPage, register],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {(Object.keys(features) as NavigationPage[]).map((target) => {
        const Feature = features[target];
        if (!ready || !Feature || !canUse(target) || (!mounted[target] && page !== target)) {
          return null;
        }
        if (page === target && !canOpenPage(target)) {
          return null;
        }
        const view = page === target ? 'page' : 'panel';
        const slot = slots.find((entry) => entry.page === target && entry.view === view);
        return <Session key={target} Feature={Feature} slot={slot} />;
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
