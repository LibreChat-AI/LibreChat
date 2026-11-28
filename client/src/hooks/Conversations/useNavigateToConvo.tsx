import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSetAtom, getDefaultStore } from 'jotai';
import { submissionByIndex } from '@librechat/chat/react';
import { useQueryClient, isCancelledError } from '@tanstack/react-query';
import {
  QueryKeys,
  Constants,
  dataService,
  getEndpointField,
  getDefaultParamsEndpoint,
} from 'librechat-data-provider';
import type {
  TEndpointsConfig,
  TStartupConfig,
  TModelsConfig,
  TConversation,
  TMessage,
} from 'librechat-data-provider';
import {
  clearModelForNonEphemeralAgent,
  getDefaultEndpoint,
  buildDefaultConvo,
  requestChatFocus,
  conversationTarget,
  hasRetiredSavedSpec,
  isNotFoundError,
  updateConvoInAllQueries,
  logger,
} from '~/utils';
import { navigationGenerationAtom } from '~/store/navigation';
import { useApplyModelSpecEffects } from '~/hooks/Agents';
import { startupConfigKey } from '~/data-provider';
import store from '~/store';

/**
 * The route the browser is actually showing, as the browser reports it.
 *
 * Only `navigateWithRecord` needs this, and only because it is the one path
 * that still calls `navigate()` after an await: it captures the route before
 * its request and re-reads it before moving the user, so a record that lands
 * for a conversation the user has already left cannot pull them back. The
 * browser's own location is the only thing that sees EVERY way they can leave
 * — a different sidebar row, "New chat", a link, a redirect, or the back
 * button — where any bookkeeping this hook maintained itself would only cover
 * the navigations that happen to route through it.
 *
 * The query string counts: `/c/new?projectId=A` is a different conversation
 * scope than `/c/new`, and the chip that changes it writes the draft in place
 * without ever going through a conversation hook — so a pathname-only
 * comparison would let a pending record land on a draft the user had just
 * re-scoped.
 *
 * Read directly rather than through `useLocation` because each sidebar row
 * mounts its own `useNavigateToConvo`: subscribing would re-render every row on
 * every navigation, which is the cost this hook exists to avoid. Comparing a
 * location against a location also makes the router basename cancel out.
 */
const currentRoute = () => window.location.pathname + window.location.search;

/**
 * Counts navigations this hook starts, so the user's LAST click is the one
 * that lands.
 *
 * The route check alone cannot separate two first-visit clicks from each
 * other: that path deliberately leaves the route where it is until the record
 * arrives, so both captures read the same pathname and whichever request the
 * network answered first would win. The two guards are orthogonal and neither
 * subsumes the other — the generation says "a newer intent replaced this one",
 * the route says "the user left by some means this hook never saw".
 *
 * Lives in `navigationGenerationAtom` (`~/store/navigation`), not a hook-local
 * ref, for the same reason the route is read from the browser: every sidebar
 * row mounts its own `useNavigateToConvo`, so a ref would be private to the
 * row that was clicked and blind to the click that superseded it. The same
 * atom lets a component outside this hook — a prompt card or the slash
 * command, cancelling its own pending Langfuse resolve — treat a navigation
 * that has only just started as supersession too, before the target
 * conversation commits and its own identity changes.
 */
const bumpNavigationGeneration = () => {
  const defaultStore = getDefaultStore();
  const generation = defaultStore.get(navigationGenerationAtom) + 1;
  defaultStore.set(navigationGenerationAtom, generation);
  return generation;
};

/**
 * Records that the user has asked for a different conversation, so a first
 * visit still waiting on its record abandons instead of landing.
 *
 * Called by `useNewConvo`, which is the only other place a user action decides
 * WHICH conversation they want. Starting a new chat from `/c/new` leaves the
 * pathname exactly where it was, so the route check cannot see it — the same
 * blind spot two first-visit clicks have, and for the same reason.
 *
 * Deliberately not called from every `navigate()` that touches `/c/*`. The
 * recoveries in `useEventHandlers` and `useChatFunctions` are the app reacting
 * to a stream, not the user changing their mind, and they should not cancel a
 * conversation the user deliberately opened. Intent is a closed set; navigation
 * is not.
 */
export const supersedeNavigation = () => {
  bumpNavigationGeneration();
};

const useNavigateToConvo = (index = 0) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const clearAllConversations = store.useClearConvoState();
  const applyModelSpecEffects = useApplyModelSpecEffects();
  const setSubmission = useSetAtom(submissionByIndex(index));
  const { hasSetConversation, setConversation: setConvo } = store.useSetConversationAtom(index);

  const setConversation = useCallback(
    (conversation: TConversation) => {
      setConvo(conversation);
      if (!conversation.spec) {
        return;
      }

      const startupConfig = queryClient.getQueryData<TStartupConfig>(startupConfigKey(true));
      applyModelSpecEffects({
        startupConfig,
        specName: conversation?.spec,
        convoId: conversation.conversationId,
      });
    },
    [setConvo, queryClient, applyModelSpecEffects],
  );

  const applyConversation = (conversation: TConversation) => {
    const target = { ...conversation };
    clearModelForNonEphemeralAgent(target);
    setConversation(target);
    requestChatFocus();
  };

  const fetchConversationRecord = (conversationId: string) =>
    queryClient.fetchQuery([QueryKeys.conversation, conversationId], () =>
      dataService.getConversationById(conversationId),
    );

  /**
   * Refreshes the cached record AFTER the route has already changed, for a
   * conversation whose full record was already cached. The cache already
   * carries everything the sidebar projection omits, so this exists only to
   * pick up edits made elsewhere — awaiting it before navigating would spend a
   * round trip with the DEPARTING conversation still on screen.
   *
   * It refreshes the CACHE and deliberately writes nothing into conversation
   * state. That state is the user's: model, endpoint, prompt prefix, sampling
   * params, and the target is interactive from the moment the route changes,
   * so writing a server snapshot into it once the response lands races the
   * user's own selections and every other writer — streamed updates, presets,
   * mention select. No predicate closes that: "is this still wanted?" gains one
   * more answer per writer, and a route or ordering guard cannot see a user who
   * never left. The refreshed record is read by the next switch to this
   * conversation, which is where a cached record is consumed.
   */
  const refreshConversationRecord = async (conversationId: string, cached: TConversation) => {
    const key = [QueryKeys.conversation, conversationId];
    try {
      // Fetch without publishing first. A turn can commit a different target
      // into the detail cache while this request is in flight.
      const response = await dataService.getConversationById(conversationId);
      if (queryClient.getQueryData<TConversation>(key) !== cached) {
        return;
      }
      let data: TConversation = response;
      if (response.targetResolutionFailed) {
        const { targetResolutionFailed: _, ...stored } = response;
        const endpoints = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
        const keepTarget =
          stored.spec &&
          stored.spec === cached.spec &&
          stored.endpoint &&
          cached.endpoint &&
          endpoints?.[cached.endpoint] &&
          !endpoints[stored.endpoint];
        data = keepTarget ? { ...stored, ...conversationTarget(cached) } : stored;
      }
      queryClient.setQueryData(key, data);
      logger.log('conversation', 'Refreshed cached conversation record', data);
      // Refresh only the routing fields so a stale row cannot undo a target change
      // on the next switch or overwrite a concurrent rename or pin.
      updateConvoInAllQueries(queryClient, conversationId, (row) => ({
        ...row,
        ...conversationTarget(data),
      }));
    } catch (error) {
      if (isCancelledError(error)) {
        return;
      }
      logger.error('conversation', 'Error refreshing conversation record on navigation', error);
      /** Only a conversation that is confirmed GONE invalidates what is on
       * screen. The messages query is already mounted by now, so dropping its
       * cache on a transient failure would cancel an in-flight history fetch
       * (or discard one that already succeeded) with no route change left to
       * remount it, blanking a transcript that was fine. */
      if (isNotFoundError(error) && queryClient.getQueryData<TConversation>(key) === cached) {
        queryClient.removeQueries([QueryKeys.messages, conversationId]);
      }
    }
  };

  /**
   * First visit to a conversation in this session: nothing has its full record
   * yet, and the sidebar row is a PROJECTION (see `getConvosByCursor`) without
   * prompt prefix, sampling params, tools or files. Landing the route on that
   * would expose a usable composer whose sends silently carry default
   * settings, so this path keeps the pre-existing behavior and moves the route
   * once the real record is in hand. A retired sidebar target can also need
   * a refresh before opening when the cache has no usable replacement.
   */
  const navigateWithRecord = async (
    conversation: TConversation,
    generation: number,
    cachedConvo?: TConversation,
  ) => {
    const conversationId = conversation.conversationId;
    if (!conversationId) {
      return;
    }
    /** The route the user was on when they asked for this one. The route has
     * NOT moved yet on this path, so "still here" is what makes finishing the
     * navigation legitimate — leaving it would mean pulling the user back to a
     * conversation they already navigated away from. Two first-visit clicks in
     * a row both capture THIS route, which is why the generation is what keeps
     * them in click order rather than in response order. */
    const routeAtStart = currentRoute();
    let record = conversation;
    try {
      record = await fetchConversationRecord(conversationId);
      logger.log('conversation', 'Fetched fresh conversation data', record);
    } catch (error) {
      if (isCancelledError(error)) {
        const committed = queryClient.getQueryData<TConversation>([
          QueryKeys.conversation,
          conversationId,
        ]);
        if (!committed) {
          return;
        }
        record = committed;
      } else {
        logger.error('conversation', 'Error fetching conversation data on navigation', error);
        if (cachedConvo && !isNotFoundError(error)) {
          record = { ...cachedConvo, ...conversation };
        } else {
          queryClient.removeQueries([QueryKeys.messages, conversationId]);
        }
      }
    }
    const isSuperseded = generation !== getDefaultStore().get(navigationGenerationAtom);
    if (isSuperseded || currentRoute() !== routeAtStart) {
      logger.log('conversation', 'Discarding superseded navigation', conversationId);
      return;
    }
    applyConversation(record);
    navigate(`/c/${conversationId}`);
  };

  const navigateToConvo = (
    conversation?: TConversation | null,
    options?: {
      currentConvoId?: string;
    },
  ) => {
    if (!conversation) {
      logger.warn('conversation', 'Conversation not provided to `navigateToConvo`');
      return;
    }
    const { currentConvoId } = options || {};
    logger.log('conversation', 'Navigating to conversation', conversation);
    hasSetConversation.current = true;
    /** Claim this click's place in the order before any await, so a request
     * still in flight for an earlier one cannot land on top of it. */
    const generation = bumpNavigationGeneration();
    setSubmission(null);

    let convo = { ...conversation };
    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
    const retiredSpec = hasRetiredSavedSpec(convo, endpointsConfig);
    if (!retiredSpec && (!convo.endpoint || !endpointsConfig?.[convo.endpoint])) {
      /* undefined/removed endpoint edge case */
      const defaultEndpoint = getDefaultEndpoint({
        convoSetup: conversation,
        endpointsConfig,
      });

      const endpointType = getEndpointField(endpointsConfig, defaultEndpoint, 'type');
      if (!conversation.endpointType && endpointType) {
        conversation.endpointType = endpointType;
      }

      const models = queryClient.getQueryData<TModelsConfig>([QueryKeys.models, defaultEndpoint])?.[
        defaultEndpoint ?? ''
      ];

      const defaultParamsEndpoint = getDefaultParamsEndpoint(endpointsConfig, defaultEndpoint);
      convo = buildDefaultConvo({
        models,
        conversation,
        endpoint: defaultEndpoint,
        lastConversationSetup: conversation,
        defaultParamsEndpoint,
      });
    }
    clearAllConversations(true);
    /**
     * Invalidate (not remove) the departing conversation's messages so
     * switching back renders the warm cache instantly while a background
     * refetch reconciles; the NEW_CONVO cache still resets for immediate
     * optimistic messages. `refetchType: 'none'` because this observer is
     * still mounted mid-switch — the default would immediately refetch the
     * chat being LEFT; marking stale defers the fetch to the next mount.
     */
    if (currentConvoId != null && currentConvoId !== Constants.NEW_CONVO) {
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.messages, currentConvoId],
        exact: true,
        refetchType: 'none',
      });
    }
    queryClient.setQueryData<TMessage[]>([QueryKeys.messages, Constants.NEW_CONVO], []);
    if (convo.conversationId !== Constants.NEW_CONVO && convo.conversationId) {
      /**
       * Invalidate the target's messages: ChatView's query mounts with
       * `refetchOnMount: true`, so a cached conversation renders immediately
       * and revalidates in the background instead of unmounting into a
       * spinner (the old removeQueries path), including when navigating in
       * from a non-chat route (e.g. /projects).
       */
      queryClient.invalidateQueries([QueryKeys.messages, convo.conversationId]);
      const cachedConvo = queryClient.getQueryData<TConversation>([
        QueryKeys.conversation,
        convo.conversationId,
      ]);
      queryClient.invalidateQueries({
        queryKey: [QueryKeys.conversation, convo.conversationId],
        exact: true,
        refetchType: 'none',
      });
      // A retired row cannot supply the target, but a compatible cached detail
      // can still open immediately and revalidate in the background.
      const recoveredTarget =
        retiredSpec &&
        cachedConvo?.spec === convo.spec &&
        cachedConvo?.endpoint &&
        endpointsConfig?.[cachedConvo.endpoint]
          ? conversationTarget(cachedConvo)
          : undefined;
      if (!cachedConvo || (retiredSpec && !recoveredTarget)) {
        navigateWithRecord(convo, generation, cachedConvo);
        return;
      }
      /** Route and conversation state change together, in the click's own
       * task, so the switch commits once instead of straddling a round trip.
       * The cached record underlays the row, which is a list PROJECTION: the
       * row's fields are the fresher ones, everything the projection drops
       * (prompt prefix, sampling params, files) survives, and this is the last
       * write this navigation makes — what the user sees now is what a send
       * will carry until they change it themselves. */
      applyConversation({ ...cachedConvo, ...convo, ...recoveredTarget });
      navigate(`/c/${convo.conversationId}`);
      refreshConversationRecord(convo.conversationId, cachedConvo);
    } else {
      setConversation(convo);
      requestChatFocus();
      navigate(`/c/${convo.conversationId ?? Constants.NEW_CONVO}`);
    }
  };

  return {
    navigateToConvo,
  };
};

export default useNavigateToConvo;
