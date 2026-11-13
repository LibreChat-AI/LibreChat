import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { atom, useAtom } from 'jotai';
import {
  matchRoutes,
  resolvePath,
  useLocation,
  UNSAFE_DataRouterContext,
  UNSAFE_LocationContext,
  UNSAFE_RouteContext,
} from 'react-router-dom';
import type { Location } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ConversationAssignmentContext } from '~/Providers/ConversationAssignmentContext';
import { ComposerRouteContext } from '~/Providers/ComposerRouteContext';
import { readBrowserComposerRoute } from '~/common/composerRoute';
import { useFeaturePresentation } from './Context';
import { getRelatedPage } from './registry';

type DataContext = NonNullable<React.ContextType<typeof UNSAFE_DataRouterContext>>;
type Navigate = DataContext['router']['navigate'];
type Assignment = { source: Location; target: Location };
const routeUrl = (location: Location) => location.pathname + location.search + location.hash;

/** Installed before a turn starts, so callbacks already in flight keep the same route owner. */
export default function ChatRouteOwner({ children }: { children: ReactNode }) {
  const data = useContext(UNSAFE_DataRouterContext);
  const route = useContext(UNSAFE_RouteContext);
  const location = useLocation();
  const locationContext = useContext(UNSAFE_LocationContext);
  const presentation = useFeaturePresentation();
  const assignmentAtom = useMemo(() => atom<Assignment | null>(null), []);
  const [assignment, setAssignment] = useAtom(assignmentAtom);
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const base = !data || data.basename === '/' ? '' : data.basename.replace(/\/$/, '');
  const isCurrentAssignment = useCallback(
    (value: Assignment) => {
      if (!data) return false;
      const actual = data.router.state.navigation.location ?? data.router.state.location;
      const same = (expected: Location) =>
        actual.pathname === base + expected.pathname &&
        actual.search === expected.search &&
        actual.hash === expected.hash;
      return (
        getRelatedPage(actual.pathname.slice(base.length) || '/') != null ||
        (actual.key === value.source.key && same(value.source)) ||
        same(value.target)
      );
    },
    [data, base],
  );
  const activeAssignment = assignment && isCurrentAssignment(assignment) ? assignment : null;
  const renderedLocation = activeAssignment?.source ?? location;
  const current = useRef({
    location: renderedLocation,
    presentation,
    assignment: activeAssignment,
  });
  current.current = { location: renderedLocation, presentation, assignment: activeAssignment };
  useLayoutEffect(() => {
    if (assignment && !activeAssignment) setAssignment(null);
  }, [assignment, activeAssignment, setAssignment]);
  const assignmentHost = useMemo(
    () => ({
      acknowledge: (conversationId: string) => {
        const owner = current.current;
        if (
          !mounted.current ||
          !data ||
          !owner.presentation ||
          owner.location.key !== renderedLocation.key ||
          renderedLocation.pathname !== '/c/new' ||
          !conversationId ||
          conversationId === 'new'
        )
          return;
        const source = owner.assignment?.source ?? renderedLocation;
        const target = { ...source, pathname: '/c/' + encodeURIComponent(conversationId) };
        const next = { source, target };
        if (!isCurrentAssignment(next)) return;
        current.current = { ...owner, assignment: next };
        setAssignment(next);
        owner.presentation.updateChatLocation(target);
        if (
          window.location.pathname === base + source.pathname ||
          (owner.assignment && window.location.pathname === base + owner.assignment.target.pathname)
        ) {
          window.history.replaceState(window.history.state, '', base + routeUrl(target));
        }
      },
      settle: (conversationId: string | null) => {
        const owner = current.current;
        const pending = owner.assignment;
        if (
          !mounted.current ||
          !pending ||
          owner.location.key !== renderedLocation.key ||
          !isCurrentAssignment(pending)
        )
          return;
        if (
          conversationId !== 'new' &&
          '/c/' + encodeURIComponent(conversationId ?? '') !== pending.target.pathname
        )
          return;
        current.current = { ...owner, assignment: null };
        setAssignment(null);
        owner.presentation?.updateChatLocation(
          conversationId === 'new' ? pending.source : pending.target,
        );
      },
    }),
    [data, base, renderedLocation, isCurrentAssignment, setAssignment],
  );
  const readComposerRoute = useMemo(
    () => () => {
      if (!data) return readBrowserComposerRoute();
      // Navigation must fence old uploads before React commits the destination.
      const actual = data.router.state.navigation.location ?? data.router.state.location;
      const pending = current.current.assignment;
      if (pending && isCurrentAssignment(pending))
        return base + pending.target.pathname + pending.target.search;
      const pathname = actual.pathname.slice(base.length) || '/';
      if (current.current.presentation && getRelatedPage(pathname)) {
        const retained = current.current.location;
        return base + retained.pathname + retained.search;
      }
      return actual.pathname + actual.search;
    },
    [data, base, isCurrentAssignment],
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
    const resolved = data && matchRoutes(data.router.routes, renderedLocation);
    return route.matches.map((match, index) => ({
      ...match,
      params: resolved?.[index]?.params ?? match.params,
      pathname: resolved?.[index]?.pathname ?? match.pathname,
      pathnameBase: resolved?.[index]?.pathnameBase ?? match.pathnameBase,
    }));
  }, [data, renderedLocation, route.matches]);
  return (
    <UNSAFE_DataRouterContext.Provider value={context}>
      <UNSAFE_RouteContext.Provider value={{ ...route, matches }}>
        <UNSAFE_LocationContext.Provider value={{ ...locationContext, location: renderedLocation }}>
          <ConversationAssignmentContext.Provider
            value={data && presentation ? assignmentHost : undefined}
          >
            <ComposerRouteContext.Provider value={readComposerRoute}>
              {children}
            </ComposerRouteContext.Provider>
          </ConversationAssignmentContext.Provider>
        </UNSAFE_LocationContext.Provider>
      </UNSAFE_RouteContext.Provider>
    </UNSAFE_DataRouterContext.Provider>
  );
}
