import type { TConversation } from 'librechat-data-provider';

/** The title fields a conversation carries and a stream reconciles. */
export type ConvoTitleState = Pick<TConversation, 'title' | 'titleSetByUser' | 'titleRevision'>;

export const hasRealTitle = (title?: string | null): title is string =>
  title != null && title !== '' && title !== 'New Chat';

/** Where a stream looks for a title the app already holds for the conversation. */
export type ConvoTitleSources = {
  /** The conversation's own cached entry. */
  cached?: ConvoTitleState | null;
  /** The newest title a user set, across the app's caches and the incoming one. */
  findManual: (incoming: ConvoTitleState) => ConvoTitleState | undefined;
  /** The conversation as the app's lists hold it; read only when no user title exists. */
  findListed: () => ConvoTitleState | undefined;
};

/**
 * Picks the title a stream frame settles on: a title the user set wins, then the incoming one when
 * it is authoritative, then the first real title among the cached entry, the listed entry and the
 * incoming one.
 */
export function selectConvoTitle({
  incoming,
  authoritative = false,
  cached,
  findManual,
  findListed,
}: ConvoTitleSources & { incoming: ConvoTitleState; authoritative?: boolean }): ConvoTitleState {
  const owned = findManual(incoming);
  const listed = owned ? undefined : findListed();
  let selected = owned;
  if (!selected) {
    if (authoritative && hasRealTitle(incoming.title)) {
      selected = incoming;
    } else if (hasRealTitle(cached?.title)) {
      selected = cached ?? undefined;
    } else if (hasRealTitle(listed?.title)) {
      selected = listed;
    } else {
      selected = incoming;
    }
  }
  return {
    title: selected?.title ?? null,
    titleSetByUser: selected?.titleSetByUser,
    titleRevision: selected?.titleRevision,
  };
}
