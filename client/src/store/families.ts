import { useEffect } from 'react';
import { createSearchParams } from 'react-router-dom';
import { LocalStorageKeys, isEphemeralAgentId, Constants } from 'librechat-data-provider';
import {
  atom,
  selector,
  atomFamily,
  DefaultValue,
  selectorFamily,
  useRecoilValue,
  useSetRecoilState,
  useRecoilCallback,
} from 'recoil';
import type {
  EModelEndpoint,
  TConversation,
  TSubmission,
  TMessage,
  TPreset,
} from 'librechat-data-provider';
import type { GenerationProtocolVersion } from '~/data-provider/SSE/protocol';
import type { TOptionSettings, ExtendedFile } from '~/common';
import {
  clearModelForNonEphemeralAgent,
  createChatSearchParams,
  storeEndpointSettings,
  logger,
} from '~/utils';
import { useSetConvoContext } from '~/Providers/SetConvoContext';

const submissionKeysAtom = atom<(string | number)[]>({
  key: 'submissionKeys',
  default: [],
});

const submissionByIndex = atomFamily<TSubmission | null, string | number>({
  key: 'submissionByIndex',
  default: null,
});

/**
 * Epoch ms baseline for the streaming elapsed indicator at this chat index.
 * Stamped when this session submits a generation (every path through `ask`),
 * cleared by the terminal handlers when that generation ends, and only FILLED
 * — never overwritten — when resume-on-load attaches a run, preferring the
 * server-recorded generation start so a reload reports real elapsed time.
 * The reading therefore survives mid-stream remounts (new-conversation id
 * hydration, navigating away from a still-live run and back) without a later,
 * externally-started generation inheriting a stale baseline. Known residual:
 * a run whose end this pane never observed (left mid-stream, finished
 * elsewhere) leaves its stamp for the next attach at this index to inherit.
 */
const submissionStartFamily = atomFamily<number | null, string | number>({
  key: 'submissionStartByIndex',
  default: null,
});

const submissionKeysSelector = selector<(string | number)[]>({
  key: 'submissionKeysSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.filter((key) => get(submissionByIndex(key)) !== null);
  },
  set: ({ set }, newKeys) => {
    logger.log('setting submissionKeysAtom', newKeys);
    set(submissionKeysAtom, newKeys);
  },
});

const conversationByIndex = atomFamily<TConversation | null, string | number>({
  key: 'conversationByIndex',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue, oldValue) => {
        const index = Number(node.key.split('__')[1]);
        logger.log('conversation', 'Setting conversation:', {
          index,
          newValue,
          oldValue,
        });
        if (newValue?.assistant_id != null && newValue.assistant_id) {
          localStorage.setItem(
            `${LocalStorageKeys.ASST_ID_PREFIX}${index}${newValue.endpoint}`,
            newValue.assistant_id,
          );
        }
        if (newValue?.agent_id != null && !isEphemeralAgentId(newValue.agent_id)) {
          localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`, newValue.agent_id);
        }
        if (newValue?.spec != null && newValue.spec) {
          localStorage.setItem(LocalStorageKeys.LAST_SPEC, newValue.spec);
        }
        if (newValue?.tools && Array.isArray(newValue.tools)) {
          localStorage.setItem(
            LocalStorageKeys.LAST_TOOLS,
            JSON.stringify(newValue.tools.filter((el) => !!el)),
          );
        }

        if (!newValue) {
          return;
        }

        storeEndpointSettings(newValue);

        const convoToStore = { ...newValue };
        clearModelForNonEphemeralAgent(convoToStore);
        localStorage.setItem(
          `${LocalStorageKeys.LAST_CONVO_SETUP}_${index}`,
          JSON.stringify(convoToStore),
        );

        const disableParams = newValue.disableParams === true;
        const shouldUpdateParams =
          index === 0 &&
          !disableParams &&
          newValue.createdAt === '' &&
          JSON.stringify(newValue) !== JSON.stringify(oldValue) &&
          (oldValue as TConversation)?.conversationId === Constants.NEW_CONVO;

        if (shouldUpdateParams) {
          const newParams = createChatSearchParams(newValue);
          if (newValue.chatProjectId) {
            newParams.set('projectId', newValue.chatProjectId);
          }
          const searchParams = createSearchParams(newParams);
          const url = `${window.location.pathname}?${searchParams.toString()}`;
          /** Mirror, not navigation: Back-worthy entries are minted by real
           * `navigate()` calls (useNewConvo), and in-place writers like
           * ProjectLandingChip deliberately replace. Pushing here buried the
           * Back target under one inert entry per draft edit. */
          window.history.replaceState({}, '', url);
        }
      });
    },
  ] as const,
});

const filesByIndex = atomFamily<Map<string, ExtendedFile>, string | number>({
  key: 'filesByIndex',
  default: new Map(),
});

const conversationKeysAtom = atom<(string | number)[]>({
  key: 'conversationKeys',
  default: [],
});

const allConversationsSelector = selector({
  key: 'allConversationsSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.map((key) => get(conversationByIndex(key))).map((convo) => convo?.conversationId);
  },
});

const conversationIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.conversationId ?? null,
});

const conversationEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'conversationEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.endpoint ?? null,
});

/** Returns `endpointType ?? endpoint`, matching the effective endpoint used for feature gating. */
const effectiveEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'effectiveEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) => {
      const convo = get(conversationByIndex(index));
      return convo?.endpointType ?? convo?.endpoint ?? null;
    },
});

const conversationModelByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationModelByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.model ?? null,
});

const conversationSpecByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationSpecByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.spec ?? null,
});

const conversationAgentIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAgentIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.agent_id ?? null,
});

const conversationAssistantIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAssistantIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.assistant_id ?? null,
});

const presetByIndex = atomFamily<TPreset | null, string | number>({
  key: 'presetByIndex',
  default: null,
});

const textByIndex = atomFamily<string, string | number>({
  key: 'textByIndex',
  default: '',
});

const showStopButtonByIndex = atomFamily<boolean, string | number>({
  key: 'showStopButtonByIndex',
  default: false,
});

const abortScrollFamily = atomFamily<boolean, string | number>({
  key: 'abortScrollByIndex',
  default: false,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        const key = Number(node.key.split(Constants.COMMON_DIVIDER)[1]);
        logger.log('message_scrolling', 'Recoil Effect: Setting abortScrollByIndex', {
          key,
          newValue,
        });
      });
    },
  ] as const,
});

const isSubmittingFamily = atomFamily({
  key: 'isSubmittingByIndex',
  default: false,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        const key = Number(node.key.split(Constants.COMMON_DIVIDER)[1]);
        logger.log('message_stream', 'Recoil Effect: Setting isSubmittingByIndex', {
          key,
          newValue,
        });
      });
    },
  ],
});

const anySubmittingSelector = selector<boolean>({
  key: 'anySubmittingSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.some((key) => get(isSubmittingFamily(key)) === true);
  },
});

const optionSettingsFamily = atomFamily<TOptionSettings, string | number>({
  key: 'optionSettingsByIndex',
  default: {},
});

const showPopoverFamily = atomFamily({
  key: 'showPopoverByIndex',
  default: false,
});

const activePromptByIndex = atomFamily<string | undefined, string | number | null>({
  key: 'activePromptByIndex',
  default: undefined,
});

const showMentionPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showMentionPopoverByIndex',
  default: false,
});

const showPlusPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPlusPopoverByIndex',
  default: false,
});

const showPromptsPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPromptsPopoverByIndex',
  default: false,
});

/**
 * Per-conversation queue of skill names the user invoked manually via the
 * `$` popover for the next submission. Structured channel that the submit
 * pipeline (`useChatFunctions.ask`) drains and pins onto the user message's
 * `manualSkills` field (also echoed at the top of the payload for the
 * runtime resolver), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users see (and can dismiss) their
 * current selection before hitting send.
 */
const pendingManualSkillsByConvoId = atomFamily<string[], string>({
  key: 'pendingManualSkillsByConvoId',
  default: [],
});

/**
 * Per-conversation queue of verbatim excerpts the user quoted via the
 * "Add to chat" selection popup for the next submission. The submit pipeline
 * (`useChatFunctions.ask`) drains this onto the user message's `quotes` field
 * (which the backend merges into the model-facing text and persists for the
 * `MessageQuotes` UI), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users can see and dismiss each quote
 * before sending.
 */
const pendingQuotesByConvoId = atomFamily<string[], string>({
  key: 'pendingQuotesByConvoId',
  default: [],
});

/**
 * Text handed to a conversation's composer by a surface the user is leaving —
 * today, a subagent thread continued into a chat of its own, where the panel
 * and its composer unmount as the destination opens.
 *
 * Keyed by conversation rather than by composer index because the handoff
 * outlives the navigation that carries it: a first visit resolves its record
 * before the route moves, so the destination's composer mounts commits later.
 * `useTextarea` drains it when that conversation's composer is on screen.
 *
 * Deliberately in memory rather than in the composer draft store: nothing the
 * user has not sent should be written to storage they asked not to use, and
 * draft restoration is itself gated on the Save Drafts preference.
 */
const pendingComposerTextByConvoId = atomFamily<string | undefined, string>({
  key: 'pendingComposerTextByConvoId',
  default: undefined,
});

/**
 * A steer message submitted mid-run. Server truth: `sending` covers the POST
 * in flight, `pending` means the server queued it (awaiting its injection
 * boundary — the next tool batch, or the next safe token boundary when
 * `preempt` was armed), `failed` keeps the text recoverable after a rejected
 * POST. The chip disappears when `on_steer_applied` lands (the inline content
 * part becomes the durable record).
 */
export type PendingSteer = {
  steerId: string;
  /** Optimistic id echoed by server state when SYNC beats the POST callback. */
  clientSteerId?: string;
  text: string;
  status: 'sending' | 'pending' | 'failed';
  /** The transport failed without a definitive server rejection. The durable
   * enqueue may have committed. Same-id Retry is safe only under protocol v2;
   * edit/queue/remove stay hidden until ownership is resolved. */
  deliveryUncertain?: boolean;
  /** Protocol selected for the generation that owns this attempt. */
  generationProtocolVersion?: GenerationProtocolVersion;
  createdAt: number;
  /** Attachments steered with the message (refs; already uploaded). */
  files?: TMessage['files'];
  /** Quoted excerpts riding this steer (also sent on the POST — the server
   *  merges them into the injected turn); kept on the chip so a steer that
   *  never injects restores onto the queued item with them intact. */
  quotes?: string[];
  /** Manual skill picks, carried for restoration only (a skill pick
   *  configures a NEW turn's run, so it never rides the steer POST). */
  manualSkills?: string[];
  /** Asked the run to seal generation at the next safe boundary rather than
   *  wait for a tool step. Labelling only — the server owns the behaviour and
   *  echoes what it actually armed. */
  preempt?: boolean;
  /** Monotonic server revision; delayed ACKs cannot undo SSE corrections. */
  preemptRevision?: number;
  /** Exact server generation this steer belongs to. Conversation ids are
   * reused by later turns, so retries/arm/cancel must retain this epoch rather
   * than mutating whatever generation currently occupies the conversation. */
  generationCreatedAt?: number;
  /** Exact client queue identity/order to restore if this accepted steer is
   *  returned as a terminal leftover before injection. */
  queuedOrigin?: QueuedMessageOrigin;
};

/**
 * Per-conversation steers awaiting injection. Reconciled against the server:
 * `on_steer_applied` removes its chip; `sync`/`resumeState.pendingSteers`
 * replaces the list on reconnect; run-end reports convert leftovers into
 * `queuedMessagesByConvoId` entries.
 */
const pendingSteersByConvoId = atomFamily<PendingSteer[], string>({
  key: 'pendingSteersByConvoId',
  default: [],
  effects: [
    ({ onSet, node }) => {
      onSet((steers) => {
        if (!(steers instanceof DefaultValue) && steers.length > 0) {
          pendingQueueKeys.add(node.key);
        } else {
          pendingQueueKeys.delete(node.key);
        }
      });
    },
  ],
});

/** Queued turns and pending steers can outlive their mounted composer. Track
 * non-empty queues at the state owner so a release cannot discard an offscreen turn. */
const pendingQueueKeys = new Set<string>();
const hasInMemoryQueuedTurns = (): boolean => pendingQueueKeys.size > 0;

/** A message composed during a run, queued to send after it finishes.
 *  Attachments ride the queued item (already uploaded at attach time) and are
 *  passed to `ask` as `overrideFiles` on drain — steering itself is text-only,
 *  so any during-run submit with media routes here as one unit. */
export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  /** Server authority for an Agent queued turn. Absence means the row remains
   * on the legacy mounted-client drain path (including a definite old-server
   * fallback). `uncertain` is deliberately still server-owned: falling back
   * after an ambiguous POST could submit the same words twice. */
  server?: {
    id?: string;
    status: 'sending' | 'uncertain' | 'indeterminate' | 'rejected' | 'queued' | 'claimed';
    errorCode?: string;
    errorMessage?: string;
    /** Observation time for a transport-ambiguous enqueue. The logical item
     * may be much older than the request that just became uncertain. */
    uncertainSince?: number;
    /** The bounded reconciliation window elapsed without authoritative
     * evidence. The outcome remains ambiguous and must never become resendable. */
    reconciliationExpired?: boolean;
    /** Current one-based projection; server sequence remains the stable
     * fallback when predecessors settle and positions close up. */
    position?: number;
    revision?: number;
  };
  /** Stable identity for server enqueue/retry. Recovered steer rows also use
   * it to dismiss their parked source; a later recovery attempt gets a fresh
   * identity. */
  clientRequestId?: string;
  /** Exact visible branch leaf captured when this turn entered the server
   * queue. The server revalidates it before admitting the fresh successor. */
  parentMessageId?: string;
  /** Correlation used only to durably dismiss/reclaim the parked source. */
  recoveryClientSteerId?: string;
  recoverySteerId?: string;
  /** Generation observed before this queued follow-up became eligible. */
  expectedPredecessorCreatedAt?: number;
  files?: TMessage['files'];
  /** Quote chips consumed from the composer at enqueue time; passed to `ask`
   *  as `overrideQuotes` on drain so they pair with THIS message. */
  quotes?: string[];
  /** Manual skill picks consumed from the composer at enqueue time; passed
   *  to `ask` as `overrideManualSkills` on drain. */
  manualSkills?: string[];
  /** Front-inserted by "Interrupt & send": stays ahead of chronologically
   *  older items when leftover steers are merged back into the queue. */
  priority?: boolean;
};

/** Snapshot of a queued item's logical position while it is temporarily sent
 * into a live run. Neighbour ids make restoration resilient to concurrent
 * drains and sends without minting a replacement item. */
export type QueuedMessageOrigin = {
  item: QueuedMessage;
  beforeIds: string[];
  afterIds: string[];
};

/**
 * Per-conversation client-side queue of follow-up messages. Drained one per
 * run completion by `useQueueDrain` (each dequeued message starts a normal
 * turn whose own final event drains the next).
 */
const queuedMessagesByConvoId = atomFamily<QueuedMessage[], string>({
  key: 'queuedMessagesByConvoId',
  default: [],
  effects: [
    ({ onSet, node }) => {
      onSet((messages) => {
        if (!(messages instanceof DefaultValue) && messages.length > 0) {
          pendingQueueKeys.add(node.key);
        } else {
          pendingQueueKeys.delete(node.key);
        }
      });
    },
  ],
});

export type SettledQueuedTurnReceipt = {
  clientRequestId: string;
  status: 'admitted' | 'admitted_pending_boundary' | 'indeterminate' | 'cancelled' | 'dead';
  effectivePredecessorCreatedAt?: number;
  rootPredecessor?: true;
  boundaryConsumed?: boolean;
};

/** Monotonic client knowledge of terminal server queue receipts. Admission
 * records preserve boundary multiplicity by request identity. Other terminal
 * records exist only while their original enqueue callback is outstanding. */
const settledQueuedTurnReceiptsByConvoId = atomFamily<SettledQueuedTurnReceipt[], string>({
  key: 'settledQueuedTurnReceiptsByConvoId',
  default: [],
});

/** Enqueue callbacks that can still race newer GET/cancellation evidence.
 * Entries retire as soon as that one callback settles. */
const pendingQueuedTurnEnqueueIdsByConvoId = atomFamily<string[], string>({
  key: 'pendingQueuedTurnEnqueueIdsByConvoId',
  default: [],
  effects: [
    ({ onSet, node }) => {
      onSet((ids) => {
        if (!(ids instanceof DefaultValue) && ids.length > 0) {
          pendingQueueKeys.add(node.key);
        } else {
          pendingQueueKeys.delete(node.key);
        }
      });
    },
  ],
});

/**
 * One-shot run-termination signal written by the SSE final/error handlers and
 * consumed (reset to null) by `useQueueDrain`. Keyed by chat index like
 * `isSubmittingFamily`. Carrying the outcome lets the drain skip auto-send on
 * user aborts/errors while `startedAsNewConvo` migrates a queue keyed under
 * `Constants.NEW_CONVO` to the real conversation id.
 */
export type RunEnd = {
  conversationId: string | null;
  outcome: 'completed' | 'aborted' | 'error';
  startedAsNewConvo?: boolean;
  endedAt: number;
  /** Exact terminal epoch whose idle transition may release one queued start. */
  generationCreatedAt?: number;
  /** The completed run's response, which a revealed queued follow-up parents to. */
  responseMessageId?: string;
  /** Armed "Interrupt & send" flag traveling with a PARKED signal, so
   *  another run on the same pane can neither consume nor clear it. */
  interruptArmed?: boolean;
};

/** A pane can receive A's terminal frame after the user has navigated to and
 * started B. Keep each terminal epoch until the queue drain has either parked
 * or consumed it; a single replaceable slot loses A when B finishes first. */
const runEndsByIndex = atomFamily<RunEnd[], string | number>({
  key: 'runEndsByIndex',
  default: [],
});

/** Preserve the original nullable one-shot API for stream writers while the
 * backing state retains every not-yet-consumed terminal epoch. Writing null
 * consumes only the visible (oldest) signal. */
const runEndByIndex = selectorFamily<RunEnd | null, string | number>({
  key: 'runEndByIndex',
  get:
    (index) =>
    ({ get }) =>
      get(runEndsByIndex(index))[0] ?? null,
  set:
    (index) =>
    ({ set }, value) => {
      if (value instanceof DefaultValue) {
        set(runEndsByIndex(index), []);
        return;
      }
      if (value == null) {
        set(runEndsByIndex(index), (prev) => prev.slice(1));
        return;
      }
      set(runEndsByIndex(index), (prev) => [...prev, value]);
    },
});

/** Foreign terminal epochs are moved off the shared pane immediately. This
 * per-conversation carrier is queued for the same reason as the pane carrier:
 * successive epochs cannot overwrite one another while the chat is hidden. */
const pendingRunEndsByConvoId = atomFamily<RunEnd[], string>({
  key: 'pendingRunEndsByConvoId',
  default: [],
});

const pendingRunEndByConvoId = selectorFamily<RunEnd | null, string>({
  key: 'pendingRunEndByConvoId',
  get:
    (conversationId) =>
    ({ get }) =>
      get(pendingRunEndsByConvoId(conversationId))[0] ?? null,
  set:
    (conversationId) =>
    ({ set }, value) => {
      if (value instanceof DefaultValue) {
        set(pendingRunEndsByConvoId(conversationId), []);
        return;
      }
      if (value == null) {
        set(pendingRunEndsByConvoId(conversationId), (prev) => prev.slice(1));
        return;
      }
      set(pendingRunEndsByConvoId(conversationId), (prev) => [...prev, value]);
    },
});

export type DrainAfterAbort = {
  conversationId: string;
  generationCreatedAt: number;
};

/**
 * One-shot override armed by "interrupt & send": the next `aborted` run-end
 * for the exact conversation generation drains the queue exactly once (a
 * plain Stop press leaves queued chips for manual send). `false` remains the
 * clear value used by stream reconciliation paths.
 */
const drainAfterAbortByIndex = atomFamily<DrainAfterAbort | false, string | number>({
  key: 'drainAfterAbortByIndex',
  default: false,
});

/**
 * Server steer ids whose `on_steer_applied` event already landed. The 202 ACK
 * and the SSE ride different connections, so the applied event can arrive
 * FIRST — the ACK handler checks this set and drops its local chip instead of
 * minting a `pending` chip whose only removal event has already passed. A late
 * ACK can land after the run's final event, so the set is capped
 * (`appendAppliedSteerIds`), never cleared.
 */
const appliedSteerIdsByConvoId = atomFamily<string[], string>({
  key: 'appliedSteerIdsByConvoId',
  default: [],
});

/**
 * Steer ids whose applied event landed in THIS session, pending their one-shot
 * receipt draw-in. `SteerPart` consumes its id on mount so the animation plays
 * exactly once, at the live chip→inline hand-off — never on reload, share, or
 * a later revisit. Global rather than per-conversation: steer ids are unique,
 * and the applied part renders in surfaces that don't know their convo id. */
const liveAppliedSteerIds = atom<string[]>({
  key: 'liveAppliedSteerIds',
  default: [],
});

/** Membership view of `liveAppliedSteerIds` so each `SteerPart` subscribes to
 *  its own id only: stamping/consuming one steer re-renders that part, not
 *  every mounted historical part in a long conversation. */
const liveAppliedSteerFamily = selectorFamily<boolean, string>({
  key: 'liveAppliedSteerFamily',
  get:
    (steerId) =>
    ({ get }) =>
      steerId.length > 0 && get(liveAppliedSteerIds).includes(steerId),
});

/** Optimistic ids the server has proven accepted via ACK or SYNC. Separate
 * from `appliedSteerIdsByConvoId`: accepted-but-still-queued steers must not
 * be suppressed by terminal conversion, but a late POST error must not
 * resurrect them after Cancel/Edit/Convert removes the visible chip. */
const acceptedSteerClientIdsByConvoId = atomFamily<string[], string>({
  key: 'acceptedSteerClientIdsByConvoId',
  default: [],
});

/** Server generation epoch currently attached for each conversation. Stream
 * ids are conversation-scoped and reused by later turns; every mutation that
 * can affect a live run carries this value as an optimistic concurrency fence. */
const activeGenerationCreatedAtByConvoId = atomFamily<number | null, string>({
  key: 'activeGenerationCreatedAtByConvoId',
  default: null,
});

/** Negotiated behavior contract for the active generation. Missing echoes are
 * legacy by definition, so the safe default is always v1. */
const activeGenerationProtocolVersionByConvoId = atomFamily<GenerationProtocolVersion, string>({
  key: 'activeGenerationProtocolVersionByConvoId',
  default: 1,
});

const globalAudioURLFamily = atomFamily<string | null, string | number | null>({
  key: 'globalAudioURLByIndex',
  default: null,
});

const globalAudioFetchingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisFetchingByIndex',
  default: false,
});

const globalAudioPlayingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisPlayingByIndex',
  default: false,
});

const activeRunFamily = atomFamily<string | null, string | number | null>({
  key: 'activeRunByIndex',
  default: null,
});

const audioRunFamily = atomFamily<string | null, string | number | null>({
  key: 'audioRunByIndex',
  default: null,
});

/** Setter-only access to the conversation atom: registers the key like
 * `useCreateConversationAtom` but never subscribes to the value, so callers
 * that only write (navigation, per-row actions) don't re-render on every
 * conversation update. */
function useSetConversationAtom(key: string | number) {
  const hasSetConversation = useSetConvoContext();
  const setKeys = useSetRecoilState(conversationKeysAtom);
  const setConversation = useSetRecoilState(conversationByIndex(key));

  useEffect(() => {
    setKeys((prevKeys) => {
      if (prevKeys.includes(key)) {
        return prevKeys;
      }
      return [...prevKeys, key];
    });
  }, [key, setKeys]);

  return { hasSetConversation, setConversation };
}

function useCreateConversationAtom(key: string | number) {
  const { hasSetConversation, setConversation } = useSetConversationAtom(key);
  const conversation = useRecoilValue(conversationByIndex(key));

  return { hasSetConversation, conversation, setConversation };
}

function useClearConvoState() {
  /** Clears all active conversations. Pass `true` to skip the first or root conversation */
  const clearAllConversations = useRecoilCallback(
    ({ reset, snapshot }) =>
      async (skipFirst?: boolean) => {
        const conversationKeys = await snapshot.getPromise(conversationKeysAtom);

        for (const conversationKey of conversationKeys) {
          if (skipFirst === true && conversationKey == 0) {
            continue;
          }

          reset(conversationByIndex(conversationKey));
        }

        reset(conversationKeysAtom);
      },
    [],
  );

  return clearAllConversations;
}

const conversationByKeySelector = conversationByIndex;

function useClearSubmissionState() {
  const clearAllSubmissions = useRecoilCallback(
    ({ reset, set, snapshot }) =>
      async (skipFirst?: boolean) => {
        const submissionKeys = await snapshot.getPromise(submissionKeysSelector);
        logger.log('submissionKeys', submissionKeys);

        for (const key of submissionKeys) {
          if (skipFirst === true && key == 0) {
            continue;
          }

          logger.log('resetting submission', key);
          reset(submissionByIndex(key));
        }

        set(submissionKeysSelector, []);
      },
    [],
  );

  return clearAllSubmissions;
}

const updateConversationSelector = selectorFamily({
  key: 'updateConversationSelector',
  get: () => () => null as Partial<TConversation> | null,
  set:
    (conversationId: string) =>
    ({ set, get }, newPartialConversation) => {
      if (newPartialConversation instanceof DefaultValue) {
        return;
      }

      const keys = get(conversationKeysAtom);
      keys.forEach((key) => {
        set(conversationByIndex(key), (prevConversation) => {
          if (prevConversation && prevConversation.conversationId === conversationId) {
            return {
              ...prevConversation,
              ...newPartialConversation,
            };
          }
          return prevConversation;
        });
      });
    },
});

export default {
  conversationKeysAtom,
  conversationByIndex,
  filesByIndex,
  presetByIndex,
  submissionByIndex,
  submissionStartFamily,
  textByIndex,
  showStopButtonByIndex,
  abortScrollFamily,
  isSubmittingFamily,
  optionSettingsFamily,
  showPopoverFamily,
  anySubmittingSelector,
  allConversationsSelector,
  conversationIdByIndex,
  conversationEndpointByIndex,
  effectiveEndpointByIndex,
  conversationModelByIndex,
  conversationSpecByIndex,
  conversationAgentIdByIndex,
  conversationAssistantIdByIndex,
  conversationByKeySelector,
  useClearConvoState,
  useCreateConversationAtom,
  useSetConversationAtom,
  showMentionPopoverFamily,
  globalAudioURLFamily,
  activeRunFamily,
  audioRunFamily,
  globalAudioPlayingFamily,
  globalAudioFetchingFamily,
  showPlusPopoverFamily,
  activePromptByIndex,
  useClearSubmissionState,
  showPromptsPopoverFamily,
  pendingComposerTextByConvoId,
  pendingManualSkillsByConvoId,
  pendingQuotesByConvoId,
  pendingSteersByConvoId,
  queuedMessagesByConvoId,
  hasInMemoryQueuedTurns,
  settledQueuedTurnReceiptsByConvoId,
  pendingQueuedTurnEnqueueIdsByConvoId,
  runEndByIndex,
  pendingRunEndByConvoId,
  drainAfterAbortByIndex,
  appliedSteerIdsByConvoId,
  liveAppliedSteerIds,
  liveAppliedSteerFamily,
  acceptedSteerClientIdsByConvoId,
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
  updateConversationSelector,
};
