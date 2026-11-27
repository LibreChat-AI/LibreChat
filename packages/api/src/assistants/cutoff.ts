import { logger } from '@librechat/data-schemas';
import { ContentTypes } from 'librechat-data-provider';
import type { ThreadContentPart, ThreadSyncClient, ThreadSyncDeps } from './threads';
import type { AssistantRunHandle } from './run';
import { getSafeErrorMetadata } from '~/utils/errors';
import { threadWriteContext } from './threads';
import { getAssistantRun } from './run';

/** A run step, as far as it names the provider message it created. */
export interface CutOffStep {
  step_details?: { message_creation?: { message_id?: string } | null } | null;
}

/** What the controller of a cancelled run holds once its stream ends. */
export interface CutOffRun {
  /** Content parts by step index; a message cut off mid-stream has no part yet. */
  finalMessage?: { content?: (ThreadContentPart | null | undefined)[] } | null;
  /** Every text delta the run streamed, in order. */
  intermediateText?: string;
  /** The messages the run finished, as the provider sent them. */
  messages?: { content?: ThreadContentPart[] | null }[];
  /** The step index of each provider message. */
  mappedOrder?: Map<string, number>;
  /** The run's steps, which name its provider messages. */
  steps?: Map<string, CutOffStep> | CutOffStep[];
}

export interface CutOffParams {
  openai: ThreadSyncClient & { req: { assistantRun?: AssistantRunHandle } };
  run: CutOffRun;
  thread_id: string;
  conversationId: string;
  /** The id the client shows the reply under. */
  messageId: string;
  /** The prompt the reply answers. */
  parentMessageId: string;
  /** The save of that prompt, which the reply waits for. */
  userMessage?: Promise<unknown>;
  assistant_id: string;
  endpoint: string;
  spec?: string;
  iconURL?: string;
}

/** The provider messages a run created, as its message steps name them. */
function runMessages(steps: CutOffRun['steps']): { id: string }[] {
  const ids = new Set<string>();
  for (const step of steps instanceof Map ? steps.values() : (steps ?? [])) {
    const id = step.step_details?.message_creation?.message_id;
    if (id) {
      ids.add(id);
    }
  }
  return [...ids].map((id) => ({ id }));
}

function textLength(message: { content?: ThreadContentPart[] | null }): number {
  let length = 0;
  for (const part of message.content ?? []) {
    const text = part.type === ContentTypes.TEXT ? (part.text as { value?: string }) : undefined;
    length += text?.value?.length ?? 0;
  }
  return length;
}

/**
 * The parts a cancelled run showed: every part it finished, and the text of the message it cut.
 * A run streams its messages one after another, so the text it streamed past what its finished
 * messages hold belongs to the message that has no finished part.
 */
export function cutOffContent(run: CutOffRun): ThreadContentPart[] {
  const content = [...(run.finalMessage?.content ?? [])];
  const finished = (run.messages ?? []).reduce(
    (length, message) => length + textLength(message),
    0,
  );
  const value = run.intermediateText?.slice(finished) ?? '';
  if (value) {
    const cut = runMessages(run.steps)
      .map(({ id }) => run.mappedOrder?.get(id))
      .filter((index): index is number => index != null && content[index] == null)
      .pop();
    content[cut ?? content.length] = { type: ContentTypes.TEXT, text: { value } };
  }
  return content.filter((part): part is ThreadContentPart => part != null);
}

/**
 * Keeps the reply of a run cancelled mid-stream: saves what it streamed under the id the client
 * shows, and tags its provider messages with that id so a later read-back of the thread finds it.
 * The stop's read-back replaces this copy (`unfinished`) with the provider's, whichever lands first;
 * when that read fails, this copy is what the history keeps. A reply the read-back already saved
 * is left alone, and a run stopped for account deletion writes nothing.
 */
export async function saveCutOffReply(
  deps: Pick<ThreadSyncDeps, 'saveMessage' | 'addThreadMetadata'>,
  params: CutOffParams,
): Promise<void> {
  const { openai, run, thread_id, conversationId, messageId, spec, iconURL } = params;
  await params.userMessage;
  if (getAssistantRun(openai.req).stopped) {
    return;
  }
  const content = cutOffContent(run);
  if (content.length === 0) {
    return;
  }
  const saved = await deps.saveMessage(
    threadWriteContext(openai.req),
    {
      user: openai.req.user.id,
      messageId,
      conversationId,
      parentMessageId: params.parentMessageId,
      thread_id,
      endpoint: params.endpoint,
      /* For messages, use the assistant_id instead of model */
      model: params.assistant_id,
      sender: 'Assistant',
      isCreatedByUser: false,
      isUserSubmitted: false,
      content,
      unfinished: true,
      ...(spec != null && { spec }),
      ...(iconURL != null && { iconURL }),
    },
    { context: 'packages/api/src/assistants/cutoff.ts #saveCutOffReply', insertOnly: true },
  );
  /* Nothing was written, or the read-back saved and tagged the reply first */
  if (saved?.unfinished !== true || saved.conversationId !== conversationId) {
    return;
  }
  const messages = runMessages(run.steps);
  if (messages.length === 0) {
    return;
  }
  try {
    await deps.addThreadMetadata({ openai, thread_id, messageId, messages });
  } catch (error) {
    logger.warn(
      '[saveCutOffReply] Could not tag the cut-off reply on its thread',
      getSafeErrorMetadata(error),
    );
  }
}
