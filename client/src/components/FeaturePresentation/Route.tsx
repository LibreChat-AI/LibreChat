import { useContext, useMemo, useRef } from 'react';
import {
  matchRoutes,
  resolvePath,
  useLocation,
  UNSAFE_DataRouterContext,
  UNSAFE_RouteContext,
} from 'react-router-dom';
import type { ReactNode } from 'react';
import { ComposerRouteContext } from '~/Providers/ComposerRouteContext';
import { readBrowserComposerRoute } from '~/common/composerRoute';
import { useFeaturePresentation } from './Context';
import { getRelatedPage } from './registry';

type DataContext = NonNullable<React.ContextType<typeof UNSAFE_DataRouterContext>>;
type Navigate = DataContext['router']['navigate'];

/** Installed before a turn starts, so callbacks already in flight keep the same route owner. */
export default function ChatRouteOwner({ children }: { children: ReactNode }) {
  const data = useContext(UNSAFE_DataRouterContext);
  const route = useContext(UNSAFE_RouteContext);
  const location = useLocation();
  const presentation = useFeaturePresentation();
  const current = useRef({ location, presentation });
  current.current = { location, presentation };
  const readComposerRoute = useMemo(
    () => () => {
      if (!data) return readBrowserComposerRoute();
      // Navigation must fence old uploads before React commits the destination.
      const actual = data.router.state.navigation.location ?? data.router.state.location;
      const base = data.basename === '/' ? '' : data.basename.replace(/\/$/, '');
      const pathname = actual.pathname.slice(base.length) || '/';
      if (current.current.presentation && getRelatedPage(pathname)) {
        const retained = current.current.location;
        return base + retained.pathname + retained.search;
      }
      return actual.pathname + actual.search;
    },
    [data],
  );
  const context = useMemo(() => {
    if (!data) {
      return data;
    }
    const navigate: Navigate = async (
      to: Parameters<Navigate>[0] | number,
      options?: Parameters<Navigate>[1],
    ) => {
      if (typeof to === 'number') {
        return data.router.navigate(to);
      }
      const owner = current.current;
      const path = resolvePath(to ?? '.', owner.location.pathname);
      // Only chat-route transitions are background work. Auth and feature navigation stay global.
      if (owner.presentation?.relatedPage != null && /^\/c\/[\w-]+$/.test(path.pathname)) {
        const next = { ...owner.location, ...path, state: options?.state ?? null };
        current.current = { ...owner, location: next };
        owner.presentation.updateChatLocation(next);
        return;
      }
      return data.router.navigate(to, options);
    };
    const router = new Proxy(data.router, {
      get: (target, property, receiver) =>
        property === 'navigate' ? navigate : Reflect.get(target, property, receiver),
    });
    return { ...data, router };
  }, [data]);
  const matches = useMemo(() => {
    const resolved = data && matchRoutes(data.router.routes, location);
    return route.matches.map((match, index) => ({
      ...match,
      params: resolved?.[index]?.params ?? match.params,
      pathname: resolved?.[index]?.pathname ?? match.pathname,
      pathnameBase: resolved?.[index]?.pathnameBase ?? match.pathnameBase,
    }));
  }, [data, location, route.matches]);
  return (
    <UNSAFE_DataRouterContext.Provider value={context}>
      <UNSAFE_RouteContext.Provider value={{ ...route, matches }}>
        <ComposerRouteContext.Provider value={readComposerRoute}>
          {children}
        </ComposerRouteContext.Provider>
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_DataRouterContext.Provider>
  );
}
