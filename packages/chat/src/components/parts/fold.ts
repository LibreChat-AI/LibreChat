import { useEffect } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { RefObject } from 'react';

type Held = TMessageContentParts | { part: TMessageContentParts } | undefined;

/**
 * The parts each fold in the thread holds, by the fold's root element. A fold that is closed
 * has not drawn its rows, so nothing in the document says which calls are inside it; something
 * that wants to open the fold around one call asks here. Kept off the document and out of
 * render on purpose: a fold records the array it was already given, and the array is only read
 * when someone asks, so a thread pays nothing for this until a reader follows a call into it.
 */
const folds = new WeakMap<Element, ReadonlyArray<Held>>();

/** Records what the fold rooted at `root` holds. `parts` may be bare parts or indexed ones. */
export function recordFold(root: Element, parts: ReadonlyArray<Held>): void {
  folds.set(root, parts);
}

/** Keeps the record for a fold component's root current with the parts it was given. */
export function useFoldParts(
  root: RefObject<Element | null>,
  parts: ReadonlyArray<Held> | undefined,
): void {
  useEffect(() => {
    const node = root.current;
    if (node != null && parts != null) {
      recordFold(node, parts);
    }
  }, [root, parts]);
}

/** Whether the fold rooted at `root` holds the tool call `toolCallId`. */
export function foldHolds(root: Element, toolCallId: string): boolean {
  const parts = folds.get(root);
  if (parts == null) {
    return false;
  }
  for (const held of parts) {
    const part = held != null && 'part' in held ? held.part : held;
    if (part?.type === ContentTypes.TOOL_CALL && part[ContentTypes.TOOL_CALL]?.id === toolCallId) {
      return true;
    }
  }
  return false;
}
