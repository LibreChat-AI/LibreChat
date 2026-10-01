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
import type { QueuedMessageOrigin } from '~/hooks/Chat/queue';
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
  /** Full-generation setting carried for restoration only; it cannot alter a live steer. */
  reasoningOverride?: TMessage['reasoningOverride'];
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
  appliedSteerIdsByConvoId,
  acceptedSteerClientIdsByConvoId,
  activeGenerationCreatedAtByConvoId,
  activeGenerationProtocolVersionByConvoId,
  updateConversationSelector,
};
