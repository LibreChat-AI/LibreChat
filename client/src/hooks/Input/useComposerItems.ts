import { useMemo, useCallback } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import store from '~/store';

export type ComposerItemKind = 'quote' | 'skill';

/**
 * One piece of context staged for the next submission.
 *
 * Files are deliberately not here: they carry upload progress, previews and
 * their own delete-or-abort semantics, and `FileRow` already renders them as
 * cards. This covers the sources whose whole content is a line of text.
 */
export interface ComposerItem {
  id: string;
  kind: ComposerItemKind;
  label: string;
  /** Full text for the tooltip when `label` is truncated in the chip. */
  title: string;
  remove: () => void;
}

/**
 * Merges the staged-text sources into a single ordered list in one pass each,
 * so the tray renders one homogeneous list instead of a row per source.
 *
 * `includeQuotes` is false on the endpoints whose client path cannot transmit
 * an excerpt: showing a quote as staged there promises something the send
 * would silently drop.
 */
export default function useComposerItems(
  conversationId: string,
  includeQuotes = true,
): ComposerItem[] {
  const quotes = useRecoilValue(store.pendingQuotesByConvoId(conversationId));
  const skills = useRecoilValue(store.pendingManualSkillsByConvoId(conversationId));
  const setQuotes = useSetRecoilState(store.pendingQuotesByConvoId(conversationId));
  const setSkills = useSetRecoilState(store.pendingManualSkillsByConvoId(conversationId));

  const removeQuoteAt = useCallback(
    (index: number) => setQuotes((prev) => prev.filter((_, i) => i !== index)),
    [setQuotes],
  );
  const removeSkill = useCallback(
    (name: string) => setSkills((prev) => prev.filter((skill) => skill !== name)),
    [setSkills],
  );

  return useMemo(() => {
    const items: ComposerItem[] = [];

    /* Keyed by content, with the index only breaking ties between two
       identical excerpts: an index in every id rewrote the ids of everything
       after a removal, remounting those chips and dropping focus. */
    const seen = new Map<string, number>();
    for (let i = 0; includeQuotes && i < quotes.length; i++) {
      const text = quotes[i];
      const repeat = seen.get(text) ?? 0;
      seen.set(text, repeat + 1);
      items.push({
        id: `quote:${JSON.stringify([text, repeat])}`,
        kind: 'quote',
        label: text,
        title: text,
        remove: () => removeQuoteAt(i),
      });
    }

    for (const name of skills) {
      items.push({
        id: `skill:${name}`,
        kind: 'skill',
        label: name,
        title: name,
        remove: () => removeSkill(name),
      });
    }

    return items;
  }, [quotes, skills, includeQuotes, removeQuoteAt, removeSkill]);
}
