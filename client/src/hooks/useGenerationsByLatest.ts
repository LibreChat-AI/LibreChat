import { Constants, EModelEndpoint, isAssistantsEndpoint } from 'librechat-data-provider';

type TUseGenerations = {
  error?: boolean;
  endpoint?: string;
  messageId?: string;
  isEditing?: boolean;
  isSubmitting: boolean;
  searchResult?: boolean;
  finish_reason?: string;
  latestMessageId?: string;
  isCreatedByUser?: boolean;
  /** Whether the editor would show a field for this message, resolved lazily: it
   *  parses markdown to spot a read-only artifact, and only a turn with nothing to
   *  replay needs the answer. */
  getHasEditablePart?: () => boolean;
  /** For a model turn: whether the message it hangs off is the user turn a rerun
   *  would replay, `false` when no such turn is in the thread. `undefined` when the
   *  thread is unavailable (a search or share row), which withholds nothing. */
  parentIsUserMessage?: boolean;
  /** The turn carries the server's manual-compaction marker. Compact runs on
   *  whatever leaf the branch ends with, so such a turn can hang off a user
   *  message; replaying that message would answer it again instead of redoing the
   *  compaction, which is the context indicator's Compact action. */
  isUserInitiatedCompaction?: boolean;
};

export default function useGenerationsByLatest({
  error = false,
  endpoint,
  messageId,
  isEditing = false,
  isSubmitting,
  searchResult = false,
  finish_reason = '',
  latestMessageId,
  isCreatedByUser = false,
  getHasEditablePart,
  parentIsUserMessage,
  isUserInitiatedCompaction = false,
}: TUseGenerations) {
  const isEditableEndpoint = Boolean(
    [
      EModelEndpoint.openAI,
      EModelEndpoint.custom,
      EModelEndpoint.google,
      EModelEndpoint.agents,
      EModelEndpoint.bedrock,
      EModelEndpoint.anthropic,
      EModelEndpoint.azureOpenAI,
    ].find((e) => e === endpoint),
  );

  /** Every rerun shape replays the message's parent as the turn's user message, so
   *  a model turn with no user turn behind it has none: the submission would mint a
   *  user message under an existing response's id and run on empty text. An imported
   *  or restored thread reaches that shape whenever a reply is chained onto a reply
   *  or left at the root, and a manual compaction reaches it whenever it summarized
   *  an answer. A marked compaction is excluded whatever it hangs off. Only a row
   *  that cannot see the thread at all withholds nothing. */
  const hasNoTurnToReplay =
    !isCreatedByUser && (parentIsUserMessage === false || isUserInitiatedCompaction);

  /** The tool-call-limit notice already offers Keep going / Answer now. The hover
   *  Continue would re-submit the parent user turn with `isContinued`, a different
   *  and weaker path sitting next to the intended one. */
  const continueSupported =
    latestMessageId === messageId &&
    Boolean(finish_reason) &&
    finish_reason !== 'stop' &&
    finish_reason !== Constants.TOOL_CALL_LIMIT_FINISH_REASON &&
    !isEditing &&
    !isSubmitting &&
    !searchResult &&
    !hasNoTurnToReplay &&
    isEditableEndpoint;

  const branchingSupported = Boolean(
    [
      EModelEndpoint.azureOpenAI,
      EModelEndpoint.openAI,
      EModelEndpoint.custom,
      EModelEndpoint.agents,
      EModelEndpoint.bedrock,
      EModelEndpoint.google,
      EModelEndpoint.anthropic,
    ].find((e) => e === endpoint),
  );

  const regenerateEnabled =
    !isCreatedByUser &&
    !searchResult &&
    !isEditing &&
    !isSubmitting &&
    !hasNoTurnToReplay &&
    branchingSupported;

  const isActiveStreamingMessage =
    isSubmitting && (latestMessageId == null || messageId === latestMessageId);

  /** The editor stays available on a model turn with nothing to replay as long as
   *  it has a part to edit — an imported chain's reply is still saved directly,
   *  which needs no rerun. A turn with neither, the compaction shape whether it
   *  finished or persisted an error part instead, would open an editor with no
   *  field and one inert Rerun. */
  const hideEditButton =
    isActiveStreamingMessage ||
    error ||
    searchResult ||
    (hasNoTurnToReplay && getHasEditablePart?.() === false) ||
    !branchingSupported ||
    (!isEditableEndpoint && !isCreatedByUser);

  const forkingSupported = !isAssistantsEndpoint(endpoint) && !searchResult;

  return {
    forkingSupported,
    continueSupported,
    regenerateEnabled,
    isActiveStreamingMessage,
    isEditableEndpoint,
    hideEditButton,
  };
}
