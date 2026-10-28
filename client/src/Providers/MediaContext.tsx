import { createContext, useContext, useMemo, useRef } from 'react';
import type { TAttachment, TFile, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { buildConversationFilesByName } from '~/utils/media';

type MediaContext = {
  /**
   * The turn's attachments, addressable by the filename a markdown image
   * names them with. A model that writes `![DTI](5_dti.png)` is referring to
   * a file the run produced, not to a path the browser can fetch, so the
   * markdown renderer resolves the reference through this map.
   */
  attachmentsByName?: ReadonlyMap<string, TAttachment>;
  /**
   * Every attachment with a path, not just images, for resolving a markdown
   * link like `[deck.pptx](/mnt/data/deck.pptx)` to the file the run produced.
   * A name the turn produced more than once, as different files, maps to
   * `undefined`: present but unresolved.
   */
  filesByName?: ReadonlyMap<string, TAttachment | undefined>;
};

export const MediaContext = createContext<MediaContext>({});
export const useMediaContext = () => useContext(MediaContext);

/**
 * Files produced anywhere in the conversation, by basename, for a markdown
 * link that names a file an earlier turn made. Consulted only when the turn's
 * own `filesByName` misses.
 */
export const ConversationFilesContext = createContext<ReadonlyMap<string, TAttachment> | undefined>(
  undefined,
);

/**
 * By value on purpose. The messages cache gets a new array on every SSE tick
 * and attachment identity is not guaranteed, so a map that changes identity
 * would re-render every anchor on every token (see the memo note in
 * `ContentParts.tsx` near the `attachmentsByName` useMemo).
 */
function sameFiles(
  a: ReadonlyMap<string, TAttachment>,
  b: ReadonlyMap<string, TAttachment>,
): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [key, x] of a) {
    const y = b.get(key);
    if (!y) {
      return false;
    }
    const p = x as Partial<TFile>;
    const q = y as Partial<TFile>;
    if (
      x.filepath !== y.filepath ||
      x.filename !== y.filename ||
      p.file_id !== q.file_id ||
      p.user !== q.user ||
      p.source !== q.source
    ) {
      return false;
    }
  }
  return true;
}

export function ConversationFilesProvider({
  messages,
  children,
}: {
  messages: ReadonlyArray<TMessage> | null | undefined;
  children: ReactNode;
}) {
  const stable = useRef<ReadonlyMap<string, TAttachment> | null>(null);
  const value = useMemo(() => {
    const next = buildConversationFilesByName(messages);
    if (stable.current == null || !sameFiles(stable.current, next)) {
      stable.current = next;
    }
    return stable.current;
  }, [messages]);
  return (
    <ConversationFilesContext.Provider value={value}>{children}</ConversationFilesContext.Provider>
  );
}
