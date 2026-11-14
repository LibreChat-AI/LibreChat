import { isAIMessage } from '@langchain/core/messages';
import {
  Providers,
  GEMINI_PARTS,
  isGeminiReplayParts,
  restoreGeminiReplayParts,
} from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';
import type { GeminiReplayPart } from '@librechat/agents';
import type { TMessage } from 'librechat-data-provider';

const functionSignaturesKey = '__gemini_function_call_thought_signatures__';

export type GoogleThoughtSignatures = {
  turns?: GeminiReplayPart[][];
  calls?: Record<string, string>;
};

type ModelOutput = {
  content?: unknown;
  additional_kwargs?: Record<string, unknown>;
  tool_calls?: ReadonlyArray<{ id?: string }>;
};

/** Keep the formatter from inserting whitespace into signed native Google text. */
export function getGoogleHistoryFormatOptions(agents: readonly { provider?: string | null }[]): {
  preserveTextContent?: boolean;
} {
  return agents.some(
    ({ provider }) => provider === Providers.GOOGLE || provider === Providers.VERTEXAI,
  )
    ? { preserveTextContent: true }
    : {};
}

/** Capture opaque replay metadata even when the provider omits usage. */
export function collectGoogleThoughtSignatures(
  collected: GoogleThoughtSignatures | null,
  output?: ModelOutput,
): void {
  if (!collected || !output) return;
  const parts = output.additional_kwargs?.[GEMINI_PARTS];
  if (isGeminiReplayParts(parts) && parts.some((part) => !!part.thoughtSignature)) {
    (collected.turns ??= []).push(parts.map((part) => ({ ...part })));
    return;
  }
  const byId = output.additional_kwargs?.[functionSignaturesKey];
  if (byId == null || typeof byId !== 'object') return;
  for (const call of output.tool_calls ?? []) {
    if (!call.id || !Object.prototype.hasOwnProperty.call(byId, call.id)) continue;
    const signature = (byId as Record<string, unknown>)[call.id];
    if (typeof signature === 'string' && signature !== '') {
      (collected.calls ??= Object.create(null))[call.id] = signature;
    }
  }
}

/** Reattach only unchanged provider parts from this assistant's persisted history row. */
export function restoreGoogleThoughtSignatures(
  messages: readonly BaseMessage[],
  history: readonly Pick<TMessage, 'messageId' | 'isCreatedByUser' | 'metadata'>[],
  provider: string,
): void {
  if (provider !== Providers.GOOGLE && provider !== Providers.VERTEXAI) return;
  const byMessage = new Map<string, Record<string, unknown>>();
  for (const row of history) {
    const saved = row.metadata?.thoughtSignatures;
    if (
      row.isCreatedByUser === false &&
      saved &&
      typeof saved === 'object' &&
      !Array.isArray(saved)
    ) {
      byMessage.set(row.messageId, saved as Record<string, unknown>);
    }
  }
  for (const message of messages) {
    if (!isAIMessage(message)) continue;
    const sourceId = message.additional_kwargs.sourceMessageId;
    const saved = typeof sourceId === 'string' ? byMessage.get(sourceId) : undefined;
    if (!saved) continue;
    if (Array.isArray(saved.turns)) {
      const matches = saved.turns.filter((turn) => restoreGeminiReplayParts(message, turn) != null);
      if (matches.length === 1) message.additional_kwargs[GEMINI_PARTS] = matches[0];
      // Never fall back to call-only signatures for edited or partially pruned native turns.
      continue;
    }
    // Older history stored a flat call-id map. The source row still owns every lookup.
    const calls =
      saved.calls != null && typeof saved.calls === 'object'
        ? (saved.calls as Record<string, unknown>)
        : saved;
    const byId: Record<string, string> = Object.create(null);
    const positional = (message.tool_calls ?? []).map(({ id }) => {
      const signature =
        id && Object.prototype.hasOwnProperty.call(calls, id) ? calls[id] : undefined;
      if (!id || typeof signature !== 'string') return '';
      byId[id] = signature;
      return signature;
    });
    if (provider === Providers.VERTEXAI) message.additional_kwargs.signatures = positional;
    message.additional_kwargs[functionSignaturesKey] = byId;
  }
}
