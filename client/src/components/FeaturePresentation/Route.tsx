import { useCallback, useContext, useLayoutEffect, useMemo, useRef } from 'react';
import { v4 } from 'uuid';
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
import { getNewConversationDraftToken, renewNewConversationDraftToken } from '~/utils/drafts';
import { ConversationAssignmentContext } from '~/Providers/ConversationAssignmentContext';
import { ComposerRouteContext } from '~/Providers/ComposerRouteContext';
import { readBrowserComposerRoute } from '~/common/composerRoute';
import { chatJourney, chatJourneyState } from './journey';
import { useFeaturePresentation } from './Context';
import { getRelatedPage } from './registry';

type DataContext = NonNullable<React.ContextType<typeof UNSAFE_DataRouterContext>>;
type Navigate = DataContext['router']['navigate'];
type Assignment = {
  source: Location;
  target: Location;
  journey: string;
  generation: symbol;
  settling?: Location;
};
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
      if (!data || value.generation !== getNewConversationDraftToken(0)) return false;
      const actual = data.router.state.navigation.location ?? data.router.state.location;
      const same = (expected: Location) =>
        actual.pathname === base + expected.pathname &&
        actual.search === expected.search &&
        actual.hash === expected.hash;
      return (
        getRelatedPage(actual.pathname.slice(base.length) || '/') != null ||
        (chatJourney(actual) === value.journey && (same(value.source) || same(value.target))) ||
        (value.settling != null && same(value.settling))
      );
    },
    [data, base],
  );
  const activeAssignment = assignment && isCurrentAssignment(assignment) ? assignment : null;
  const renderedLocation = activeAssignment?.source ?? location;
  const journey = chatJourney(renderedLocation);
  const started = useRef<{ journey: string; generation: symbol } | null>(null);
  const current = useRef({
    location: renderedLocation,
    presentation,
    assignment: activeAssignment,
    journey,
  });
  current.current = {
    location: renderedLocation,
    presentation,
    assignment: activeAssignment,
    journey,
  };
  useLayoutEffect(() => {
    if (assignment && !activeAssignment) setAssignment(null);
  }, [assignment, activeAssignment, setAssignment]);
  const assignmentHost = useMemo(
    () => ({
      begin: (conversationId: string) => {
        const owner = current.current;
        if (mounted.current && owner.journey === journey && conversationId === 'new') {
          started.current = { journey, generation: getNewConversationDraftToken(0) };
        }
      },
      acknowledge: (conversationId: string) => {
        const owner = current.current;
        const start = started.current;
        if (
          !mounted.current ||
          !data ||
          !owner.presentation ||
          owner.journey !== journey ||
          !start ||
          start.journey !== journey ||
          start.generation !== getNewConversationDraftToken(0) ||
          owner.location.pathname !== '/c/new' ||
          owner.assignment?.settling ||
          !conversationId ||
          conversationId === 'new'
        )
          return;
        const source = owner.assignment?.source ?? owner.location;
        const target = { ...source, pathname: '/c/' + encodeURIComponent(conversationId) };
        const next: Assignment = { source, target, journey, generation: start.generation };
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
          !data ||
          !pending ||
          pending.settling ||
          owner.journey !== journey ||
          !isCurrentAssignment(pending)
        )
          return;
        if (
          conversationId !== 'new' &&
          '/c/' + encodeURIComponent(conversationId ?? '') !== pending.target.pathname
        )
          return;
        const reset = conversationId === 'new';
        // A discarded server conversation cannot keep uploads owned by its abandoned generation.
        if (reset) renewNewConversationDraftToken(0);
        const destination = reset ? { ...pending.source, key: v4(), state: null } : pending.target;
        const settling: Assignment = {
          ...pending,
          generation: getNewConversationDraftToken(0),
          settling: destination,
        };
        current.current = { ...owner, assignment: settling };
        setAssignment(settling);
        const commit = () => {
          const latest = current.current;
          if (!mounted.current || latest.assignment !== settling || !isCurrentAssignment(settling))
            return;
          const actual = data.router.state.navigation.location ?? data.router.state.location;
          const hidden = getRelatedPage(actual.pathname.slice(base.length) || '/') != null;
          if (
            !hidden &&
            (actual.pathname !== base + destination.pathname ||
              actual.search !== destination.search ||
              actual.hash !== destination.hash)
          )
            return;
          // The rendered identity and imperative upload reader move together, never through /new.
          current.current = {
            ...latest,
            location: destination,
            assignment: null,
            journey: chatJourney(destination),
          };
          latest.presentation?.updateChatLocation(destination);
          setAssignment(null);
        };
        const actual = data.router.state.navigation.location ?? data.router.state.location;
        if (
          getRelatedPage(actual.pathname.slice(base.length) || '/') != null ||
          (actual.pathname === base + destination.pathname &&
            actual.search === destination.search &&
            actual.hash === destination.hash)
        ) {
          commit();
        } else {
          void data.router
            .navigate(routeUrl(destination), {
              replace: true,
              state: chatJourneyState(chatJourney(destination)),
            })
            .then(commit, commit);
        }
      },
    }),
    [data, base, journey, isCurrentAssignment, setAssignment],
  );
  const readComposerRoute = useMemo(
    () => () => {
      if (!data) return readBrowserComposerRoute();
      // Navigation must fence old uploads before React commits the destination.
      const actual = data.router.state.navigation.location ?? data.router.state.location;
      const pending = current.current.assignment;
      if (pending && isCurrentAssignment(pending)) {
        const canonical = pending.settling ?? pending.target;
        return base + canonical.pathname + canonical.search;
      }
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
