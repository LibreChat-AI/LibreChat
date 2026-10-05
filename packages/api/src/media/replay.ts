import type { MessageContentComplex } from '@librechat/agents';

/** Keeps the existing tool-anchor whitespace exactly, while preserving native part ordering. */
export function prepareAssistantToolReplayContent(
  pending: MessageContentComplex[],
  anchor: MessageContentComplex,
): string | MessageContentComplex[] {
  const parts = [...pending, anchor];
  if (parts.some((part) => part.native_media != null)) return parts;
  const anchorText = anchor.type === 'text' && 'text' in anchor ? anchor.text : '';
  if (!pending.length) return anchorText || '';
  const text = pending.reduce(
    (value, part) => (part.type === 'text' && 'text' in part ? `${value}${part.text}\n` : value),
    '',
  );
  return `${text}\n${anchorText ?? ''}`.trim();
}

/**
 * Signed native parts must retain their exact ordering through reasoning/tool/steer flushes;
 * everything else folds to the text the providers expect alongside `tool_calls`.
 */
export function collapseAssistantReplayContent(
  parts: MessageContentComplex[],
): string | MessageContentComplex[] {
  if (parts.some((part) => part.native_media != null)) return parts;
  return parts
    .flatMap((part) =>
      part.type === 'text' && 'text' in part && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n')
    .trim();
}
