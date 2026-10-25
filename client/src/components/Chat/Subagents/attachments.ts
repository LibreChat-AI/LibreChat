import { createContext, useEffect, useMemo, useRef } from 'react';
import { Constants } from 'librechat-data-provider';
import { atom, useStore, useAtomValue } from 'jotai';
import type {
  Agents,
  TAttachment,
  FullToolCall,
  TMessageContentParts,
  SubagentAttachmentFile,
  SubagentAttachmentCallsResponse,
} from 'librechat-data-provider';
import type { SubagentContentPart } from '~/utils/subagentContent';
import {
  nestedToolCallOf,
  collectNestedCalls,
  subagentProgressKey,
  retainSubagentProgress,
  rememberSubagentChildCalls,
  rememberedSubagentChildCalls,
  subagentProgressByToolCallId,
} from './state';
import { useSubagentAttachmentCallsQueries } from '~/data-provider';

export { collectNestedCalls };
import { getPartKeyIndex } from '~/utils/messages';

type NestedPart = TMessageContentParts | SubagentContentPart | undefined;
/** A tool call inside a subagent run, with the scope its files may carry. */
export type NestedCall = Agents.SubagentAttachmentCall;

const EMPTY: TAttachment[] = [];
const NO_LIVE_CALLS: ReadonlyMap<number, NestedCall[]> = new Map();
const NO_NESTED: ReadonlyMap<NestedPart, TAttachment[]> = new Map();

/**
 * The files each tool call part of the message owns through its subagent run,
 * keyed by the part. A tool run inside a subagent saves its files under the
 * child tool call id, which only appears inside the parent `subagent` call. The
 * message assigns them once, so every body it splits into reads one answer.
 */
export const SubagentAttachmentsContext =
  createContext<ReadonlyMap<NestedPart, TAttachment[]>>(NO_NESTED);

/**
 * The ownership rule top-level parts apply: a scope both sides carry must
 * agree. `exact` also requires the call to carry every scope the file does, so
 * a call whose scope is still unknown cannot take a file a scoped call owns.
 */
const ownsAttachment = (call: NestedCall, attachment: TAttachment, exact: boolean): boolean => {
  const { agentId, stepId } = attachment as { agentId?: string; stepId?: string };
  const agrees = (own: string | undefined, file: string | undefined) =>
    file == null || (own == null ? !exact : own === file);
  return (
    call.id === attachment.toolCallId &&
    agrees(call.agentId, agentId) &&
    agrees(call.stepId, stepId)
  );
};

/** Tool attachments that `claimed` (what the top-level parts accept) leaves out. */
export function selectUnclaimedAttachments(
  attachments: TAttachment[],
  claimed: ReadonlySet<TAttachment>,
): TAttachment[] {
  const unclaimed = attachments.filter(
    (attachment) => attachment.toolCallId != null && !claimed.has(attachment),
  );
  return unclaimed.length > 0 ? unclaimed : EMPTY;
}

/** Each tool call part of `content` with the child calls of its stored, previewed or live run. */
function collectNestedOwners(
  content: ReadonlyArray<NestedPart> | undefined,
  live: ReadonlyMap<number, NestedCall[]>,
): Array<[NestedPart, NestedCall[]]> {
  const owners: Array<[NestedPart, NestedCall[]]> = [];
  (content ?? []).forEach((part, index) => {
    const toolCall = nestedToolCallOf(part);
    if (toolCall == null) {
      return;
    }
    const calls = collectNestedCalls(
      toolCall.subagent_content,
      [],
      toolCall.subagentIdentity?.subagentAgentId,
    );
    calls.push(...(toolCall.subagentAttachmentCalls ?? []), ...(live.get(index) ?? []));
    if (calls.length > 0) {
      owners.push([part, calls]);
    }
  });
  return owners;
}

/**
 * Attachments a child call inside some subagent run owns under its full scope.
 * A top-level call that only matches them by id, without that scope, must not
 * take them first.
 */
export function selectExactlyNestedAttachments(
  content: ReadonlyArray<NestedPart> | undefined,
  attachments: TAttachment[],
  live: ReadonlyMap<number, NestedCall[]>,
): ReadonlySet<TAttachment> {
  const owners = collectNestedOwners(content, live);
  const reserved = new Set<TAttachment>();
  if (owners.length === 0) {
    return reserved;
  }
  for (const attachment of attachments) {
    if (owners.some(([, calls]) => calls.some((call) => ownsAttachment(call, attachment, true)))) {
      reserved.add(attachment);
    }
  }
  return reserved;
}

/**
 * Hands each unclaimed attachment to one tool call part of the message whose
 * transcript (stored, previewed, or streaming in `live`, keyed by content
 * index) holds the tool call it was saved under. A part whose call matches the
 * file's full scope is preferred over one whose scope is still unknown; within
 * each pass the first part in message order wins, so a child id two subagents
 * share renders the file once. The map is keyed by the part itself, so two
 * calls sharing an id keep their own files.
 */
export function assignNestedAttachments(
  content: ReadonlyArray<NestedPart> | undefined,
  unclaimed: TAttachment[],
  live: ReadonlyMap<number, NestedCall[]>,
): ReadonlyMap<NestedPart, TAttachment[]> {
  if (unclaimed.length === 0) {
    return NO_NESTED;
  }
  const owners = collectNestedOwners(content, live);
  const assigned = new Map<NestedPart, TAttachment[]>();
  for (const attachment of unclaimed) {
    const owner =
      owners.find(([, calls]) => calls.some((call) => ownsAttachment(call, attachment, true))) ??
      owners.find(([, calls]) => calls.some((call) => ownsAttachment(call, attachment, false)));
    if (owner == null) {
      continue;
    }
    const files = assigned.get(owner[0]) ?? [];
    files.push(attachment);
    assigned.set(owner[0], files);
  }
  return assigned.size > 0 ? assigned : NO_NESTED;
}

/**
 * Child tool calls the live progress of each subagent call in `content` holds,
 * keyed by the call's index in `content`. Until the run is saved, and for a
 * file a background task delivers after the message settled, those calls exist
 * only there. The atom yields a signature string so the caller re-renders when
 * a child call appears, not on every delta. Each member it reads is retained
 * like a card's, so one no update ever reached is freed on unmount. Calls
 * already seen are kept with the invocation (`rememberSubagentChildCalls`),
 * since the bounded live activity evicts early parts before the transcript is
 * saved.
 */
export function useLiveSubagentToolCalls(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
  attachments: ReadonlyArray<TAttachment> | undefined,
  messageId: string,
  contentIndices: ReadonlyArray<number> | undefined,
  contentIndexOffset: number,
): ReadonlyMap<number, NestedCall[]> {
  /** Only calls a file of this message names matter for routing, so the
   *  signature carries those rather than the invocation's whole history. */
  const idSignature = useMemo(
    () =>
      [...new Set((attachments ?? []).map((attachment) => attachment.toolCallId ?? ''))]
        .filter(Boolean)
        .sort()
        .join('\u0000'),
    [attachments],
  );
  /** A string, so the keys (and the atom reading them) survive the content
   *  array changing on every streamed delta. */
  const keySignature = useMemo(() => {
    const entries: Array<[number, string]> = [];
    (content ?? []).forEach((part, index) => {
      const toolCall = nestedToolCallOf(part);
      if (toolCall?.id && toolCall.name === Constants.SUBAGENT) {
        entries.push([
          index,
          subagentProgressKey(
            messageId,
            toolCall.id,
            getPartKeyIndex(part, contentIndices?.[index] ?? index + contentIndexOffset),
          ),
        ]);
      }
    });
    return entries.length === 0 ? '' : JSON.stringify(entries);
  }, [content, messageId, contentIndices, contentIndexOffset]);
  const keys = useMemo(
    () => (keySignature === '' ? [] : (JSON.parse(keySignature) as Array<[number, string]>)),
    [keySignature],
  );
  const store = useStore();
  /** Retained one key at a time: releasing a key that is still read would free
   *  the member under the atom subscribed to it. */
  const retained = useRef(new Map<string, () => void>());
  useEffect(() => {
    const next = new Set(keys.map(([, key]) => key));
    for (const [key, release] of retained.current) {
      if (!next.has(key)) {
        release();
        retained.current.delete(key);
      }
    }
    for (const key of next) {
      if (!retained.current.has(key)) {
        retained.current.set(key, retainSubagentProgress(store, key));
      }
    }
  }, [keys, store]);
  useEffect(() => {
    const held = retained.current;
    return () => {
      held.forEach((release) => release());
      held.clear();
    };
  }, []);
  /** Built from everything the invocation has shown, not only its current
   *  activity: a write the progress setter remembered and a later write that
   *  evicted the same call can land in one batch. */
  const signatureAtom = useMemo(
    () =>
      atom((get) => {
        const ids = new Set(idSignature === '' ? [] : idSignature.split('\u0000'));
        const live: Array<[number, NestedCall[]]> = [];
        for (const [index, key] of keys) {
          const progress = get(subagentProgressByToolCallId(key));
          const owners = rememberedSubagentChildCalls(key, ids);
          /** The owners of this message's files are refreshed as the newest
           *  entries, so the bounded history cannot age them out while it shows. */
          rememberSubagentChildCalls(key, owners, true);
          rememberSubagentChildCalls(
            key,
            collectNestedCalls(progress?.contentParts, [], progress?.subagentAgentId),
          );
          const calls = rememberedSubagentChildCalls(key, ids);
          if (calls.length > 0) {
            live.push([index, calls]);
          }
        }
        return live.length === 0 ? '' : JSON.stringify(live);
      }),
    [keys, idSignature],
  );
  const signature = useAtomValue(signatureAtom);
  return useMemo(
    () =>
      signature === ''
        ? NO_LIVE_CALLS
        : new Map(JSON.parse(signature) as Array<[number, NestedCall[]]>),
    [signature],
  );
}

/** The identity a stored part and its cached preview share. */
const identityOf = (toolCallId: string, stepId?: string, agentId?: string) =>
  [toolCallId, stepId ?? '', agentId ?? ''].join('\u0000');

/**
 * Child calls of the stored transcripts of the previewed subagent calls in `content`, for the
 * files whose owner is in doubt, keyed by the call's index in `content`. A file a background task
 * delivers after the message loaded names a child call the cached preview never hinted; while
 * `files` is not empty, the server is asked (in bounded batches) which transcript holds each.
 */
export function useStoredSubagentHints(
  content: ReadonlyArray<TMessageContentParts | undefined> | undefined,
  files: SubagentAttachmentFile[],
  conversationId: string | null | undefined,
  messageId: string,
): ReadonlyMap<number, NestedCall[]> {
  const previewed = useMemo(
    () =>
      (content ?? []).some(
        (part) =>
          (nestedToolCallOf(part) as FullToolCall | undefined)?.subagentContentOmitted === true,
      ),
    [content],
  );
  const results = useSubagentAttachmentCallsQueries(
    { conversationId: conversationId ?? '', messageId, files },
    previewed && files.length > 0 && !!conversationId && !!messageId,
  );
  /** A string, so the routing changes only when an answer does. */
  const answers = JSON.stringify(results.map((result) => result.data?.parts ?? null));
  return useMemo(() => {
    const parts = (
      JSON.parse(answers) as Array<SubagentAttachmentCallsResponse['parts'] | null>
    ).flatMap((batch) => batch ?? []);
    if (parts.length === 0 || !previewed) {
      return NO_LIVE_CALLS;
    }
    const byIdentity = new Map<string, NestedCall[]>();
    for (const entry of parts) {
      const identity = identityOf(entry.toolCallId, entry.stepId, entry.agentId);
      byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), ...entry.calls]);
    }
    const byIndex = new Map<number, NestedCall[]>();
    (content ?? []).forEach((part, index) => {
      const toolCall = nestedToolCallOf(part) as FullToolCall | undefined;
      if (toolCall?.subagentContentOmitted !== true || !toolCall.id) {
        return;
      }
      const calls = byIdentity.get(
        identityOf(toolCall.id, toolCall.stepId, (part as { agentId?: string }).agentId),
      );
      if (calls != null) {
        byIndex.set(index, calls);
      }
    });
    return byIndex.size > 0 ? byIndex : NO_LIVE_CALLS;
  }, [answers, previewed, content]);
}
