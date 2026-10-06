import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import { isPasteSubmitted } from './files';

export type PendingTextAttachmentDraft = {
  text: string;
  selectionStart: number;
  selectionEnd?: number;
  replacedText?: string;
  sequence?: number;
  /** True when TEXT_DRAFT was written after the selection was already removed. */
  replacedApplied?: boolean;
  anchorBefore?: string;
  anchorAfter?: string;
};

export type FilesDraft = {
  fileIds: string[];
  pendingPastes: Record<string, PendingTextAttachmentDraft>;
  /** Paste-generated attachment ids, kept after `pendingPastes` is consumed so provenance
   * survives reloads without holding the (much larger) paste text indefinitely. */
  pastedTextIds?: string[];
  /** The browser tab that first wrote the draft. Every draft key is reachable from more than
   * one tab (the unsaved-chat key by every default composer, a conversation key by every tab
   * viewing it), so destructive actions read this to leave other tabs' composers alone.
   * Later rewrites, including another tab restoring the same record, keep this owner rather
   * than restamping. Undefined on records older than the stamp. */
  tabId?: string;
};

type StoredPendingTextAttachmentDraft = {
  encodedText: string;
  selectionStart: number;
  selectionEnd?: number;
  encodedReplacedText?: string;
  sequence?: number;
  replacedApplied?: boolean;
  encodedAnchorBefore?: string;
  encodedAnchorAfter?: string;
};

type StoredFilesDraft = {
  fileIds: string[];
  pendingPastes: Record<string, StoredPendingTextAttachmentDraft>;
  pastedTextIds?: string[];
  tabId?: string;
};

const newConversationDraftTokens = new Map<number, symbol>();

/** Per-composer identity so a side-by-side new-chat reset cannot discard another pane's paste recovery. */
export const getNewConversationDraftToken = (index = 0): symbol => {
  const existing = newConversationDraftTokens.get(index);
  if (existing) {
    return existing;
  }
  const token = Symbol('new-conversation-draft');
  newConversationDraftTokens.set(index, token);
  return token;
};

export const renewNewConversationDraftToken = (index = 0): void => {
  newConversationDraftTokens.set(index, Symbol('new-conversation-draft'));
};

/** Draft key used while a run is in flight. Extra panes get a suffix so one run cannot migrate another pane's attachments. */
export const getPendingDraftId = (index = 0): string =>
  index === 0 ? Constants.PENDING_CONVO : `${Constants.PENDING_CONVO}:${index}`;

/** Draft key for an idle unsaved chat. Extra panes get a suffix so two new composers do not share FILES_DRAFT. */
export const getNewConversationDraftId = (index = 0): string =>
  index === 0 ? Constants.NEW_CONVO : `${Constants.NEW_CONVO}:${index}`;

export const isNewConversationDraftId = (id?: string | null): boolean =>
  typeof id === 'string' &&
  (id === Constants.NEW_CONVO || id.startsWith(`${Constants.NEW_CONVO}:`));

export const isPendingDraftId = (id?: string | null): boolean =>
  typeof id === 'string' &&
  (id === Constants.PENDING_CONVO || id.startsWith(`${Constants.PENDING_CONVO}:`));

/** Keys every tab's default composer reaches, rather than one conversation's own draft. These are
 * the records a destructive action has to check an owner for. */
export const isSharedComposerDraftId = (id?: string | null): boolean =>
  isNewConversationDraftId(id) || isPendingDraftId(id);

export const getConversationDraftId = (index = 0, conversationId?: string | null): string =>
  conversationId == null || conversationId === '' || conversationId === Constants.NEW_CONVO
    ? getNewConversationDraftId(index)
    : conversationId;

export const getComposerDraftId = (
  index = 0,
  conversationId?: string | null,
  isSubmitting = false,
): string =>
  isSubmitting ? getPendingDraftId(index) : getConversationDraftId(index, conversationId);

const getReplacedLength = (pendingPaste: PendingTextAttachmentDraft): number => {
  if (pendingPaste.replacedText != null && pendingPaste.replacedText.length > 0) {
    return pendingPaste.replacedText.length;
  }
  if (pendingPaste.selectionEnd != null) {
    return Math.max(0, pendingPaste.selectionEnd - pendingPaste.selectionStart);
  }
  return 0;
};

const findAnchoredInsertStart = (
  draftText: string,
  before: string,
  after: string,
): number | null => {
  if (before && after) {
    let insertStart: number | null = null;
    let searchFrom = 0;
    while (searchFrom <= draftText.length) {
      const beforeIndex = draftText.indexOf(before, searchFrom);
      if (beforeIndex < 0) {
        break;
      }
      const candidate = beforeIndex + before.length;
      if (draftText.indexOf(after, candidate) >= 0) {
        insertStart = candidate;
      }
      searchFrom = beforeIndex + 1;
    }
    if (insertStart != null) {
      return insertStart;
    }
  }
  if (before) {
    const beforeIndex = draftText.lastIndexOf(before);
    if (beforeIndex >= 0) {
      return beforeIndex + before.length;
    }
  }
  if (after) {
    const afterIndex = draftText.indexOf(after);
    if (afterIndex >= 0) {
      return afterIndex;
    }
  }
  return null;
};

/**
 * The offset closest to the original caret where both captured anchors survived the edit intact
 * and still meet. A repeated anchor leaves several such offsets, and the caret is the only
 * evidence left of which one the paste belongs to; the scan opens there, so the first hit is it.
 */
const findIntactAnchorJunction = (
  draftText: string,
  before: string,
  after: string,
): number | null => {
  if (before === '' && after === '') {
    return null;
  }
  const lastJunction = draftText.length - after.length;
  for (let start = before.length; start <= lastJunction; start++) {
    if (!draftText.startsWith(before, start - before.length)) {
      continue;
    }
    if (draftText.startsWith(after, start)) {
      return start;
    }
  }
  return null;
};

export const resolvePendingPasteInsertStart = (
  draftText: string,
  pendingPaste: PendingTextAttachmentDraft,
): number => {
  const prefix = pendingPaste.anchorBefore;
  const suffix = pendingPaste.anchorAfter;
  if (prefix == null && suffix == null) {
    return Math.min(pendingPaste.selectionStart, draftText.length);
  }
  const before = prefix ?? '';
  const after = suffix ?? '';
  if (draftText === `${before}${after}`) {
    return before.length;
  }
  const intactJunction = findIntactAnchorJunction(draftText, before, after);
  if (intactJunction != null) {
    return intactJunction;
  }
  if (before && draftText.startsWith(before)) {
    return before.length;
  }
  if (after !== '' && draftText.endsWith(after)) {
    return draftText.length - after.length;
  }
  if (after === '' && before && draftText.endsWith(before)) {
    return draftText.length;
  }
  return (
    findAnchoredInsertStart(draftText, before, after) ??
    Math.min(pendingPaste.selectionStart, draftText.length)
  );
};

export const applyPendingPasteToDraft = (
  draftText: string,
  pendingPaste: PendingTextAttachmentDraft,
): string => applyPendingPastesToDraft(draftText, [pendingPaste]);

/** Replay leftover pre-deletion ranges, then insert paste text at rebased or anchored offsets. */
export const applyPendingPastesToDraft = (
  draftText: string,
  pendingPastes: PendingTextAttachmentDraft[],
): string => {
  if (pendingPastes.length === 0) {
    return draftText;
  }

  const ordered = pendingPastes.map((pendingPaste, index) => ({ pendingPaste, index }));
  ordered.sort(
    (a, b) =>
      (a.pendingPaste.sequence ?? a.index) - (b.pendingPaste.sequence ?? b.index) ||
      a.index - b.index,
  );

  let text = draftText;
  for (const { pendingPaste } of ordered) {
    if (pendingPaste.replacedApplied) {
      continue;
    }
    const replacedText = pendingPaste.replacedText ?? '';
    const start = Math.min(pendingPaste.selectionStart, text.length);
    if (
      replacedText.length > 0 &&
      text.slice(start, start + replacedText.length) === replacedText
    ) {
      text = `${text.slice(0, start)}${text.slice(start + replacedText.length)}`;
    }
  }

  const insertions = ordered.map(({ pendingPaste }, index) => {
    if (pendingPaste.replacedApplied) {
      return {
        text: pendingPaste.text,
        start: resolvePendingPasteInsertStart(draftText, pendingPaste),
        index,
      };
    }
    let start = pendingPaste.selectionStart;
    for (const later of ordered.slice(index + 1)) {
      if (later.pendingPaste.selectionStart < start) {
        start -= getReplacedLength(later.pendingPaste);
      }
    }
    return { text: pendingPaste.text, start: Math.max(0, start), index };
  });
  insertions.sort((a, b) => b.start - a.start || b.index - a.index);

  for (const insertion of insertions) {
    const start = Math.min(insertion.start, text.length);
    text = `${text.slice(0, start)}${insertion.text}${text.slice(start)}`;
  }
  return text;
};

const getLocalStorageItem = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    // Privacy-blocked storage must not abort paste/upload recovery.
    return null;
  }
};

const setLocalStorageItem = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Quota or disabled storage must not abort paste/upload recovery.
  }
};

const removeLocalStorageItem = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures on cleanup.
  }
};

/** Navigation must clear before another visit can save replacement text under the same key. */
export const clearDraft = (id?: string | null) => {
  const key = id ?? '';
  if (!mayClearComposerDrafts(key)) {
    return;
  }
  removeLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${key}`);
};

/** Synchronously removes both text and file drafts for a conversation (or NEW_CONVO fallback).
 * A record another live tab owns is left alone, attachment or not: every key here is reachable
 * from more than one tab, and clearing one would take that tab's unsent text and its attachment
 * recovery with it. */
export const clearAllDrafts = (conversationId?: string | null) => {
  const key = conversationId || Constants.NEW_CONVO;
  if (!mayClearComposerDrafts(key)) {
    return;
  }
  removeLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${key}`);
  removeLocalStorageItem(`${LocalStorageKeys.FILES_DRAFT}${key}`);
};

/** Clears this pane's concrete conversation draft. The idle new-chat key is only removed when the finished run originated as an unsaved chat. Leaves PENDING so unsent during-run attachments can migrate. */
export const clearComposerDrafts = (
  index = 0,
  conversationId?: string | null,
  options?: { includeNewChatDraft?: boolean },
): void => {
  const originatedFromNewChat =
    options?.includeNewChatDraft ??
    (conversationId == null ||
      conversationId === '' ||
      conversationId === Constants.NEW_CONVO ||
      isNewConversationDraftId(conversationId));
  const keys = new Set<string>();
  if (originatedFromNewChat) {
    keys.add(getNewConversationDraftId(index));
  }
  if (conversationId != null && conversationId !== '') {
    keys.add(getConversationDraftId(index, conversationId));
    if (conversationId !== Constants.NEW_CONVO && conversationId !== Constants.PENDING_CONVO) {
      keys.add(conversationId);
    }
  }
  for (const key of keys) {
    clearAllDrafts(key);
  }
};

/** Spreading a whole paste into `String.fromCharCode` blows the argument limit, and the paste
 * sizes this recovery exists for are exactly the ones that reach it. */
const BINARY_STRING_CHUNK = 0x8000;

export const encodeBase64 = (plainText: string): string => {
  try {
    const textBytes = new TextEncoder().encode(plainText);
    let binary = '';
    for (let start = 0; start < textBytes.length; start += BINARY_STRING_CHUNK) {
      binary += String.fromCharCode(...textBytes.subarray(start, start + BINARY_STRING_CHUNK));
    }
    return btoa(binary);
  } catch {
    return '';
  }
};

export const decodeBase64 = (base64String: string): string => {
  try {
    const bytes = atob(base64String);
    const uint8Array = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      uint8Array[i] = bytes.charCodeAt(i);
    }
    return new TextDecoder().decode(uint8Array);
  } catch {
    return '';
  }
};

export const getFilesDraft = (id: string): FilesDraft => {
  const storedValue = getLocalStorageItem(`${LocalStorageKeys.FILES_DRAFT}${id}`);
  if (!storedValue) {
    return { fileIds: [], pendingPastes: {} };
  }

  try {
    const storedDraft = JSON.parse(storedValue) as string[] | StoredFilesDraft;
    if (Array.isArray(storedDraft)) {
      return { fileIds: storedDraft, pendingPastes: {} };
    }

    const pendingPastes = Object.fromEntries(
      Object.entries(storedDraft.pendingPastes ?? {}).map(
        ([fileId, pendingPaste]): [string, PendingTextAttachmentDraft] => [
          fileId,
          {
            text: decodeBase64(pendingPaste.encodedText),
            selectionStart: pendingPaste.selectionStart,
            ...(pendingPaste.selectionEnd != null
              ? { selectionEnd: pendingPaste.selectionEnd }
              : {}),
            ...(pendingPaste.encodedReplacedText
              ? { replacedText: decodeBase64(pendingPaste.encodedReplacedText) }
              : {}),
            ...(pendingPaste.sequence != null ? { sequence: pendingPaste.sequence } : {}),
            ...(pendingPaste.replacedApplied ? { replacedApplied: true } : {}),
            ...(pendingPaste.encodedAnchorBefore != null
              ? { anchorBefore: decodeBase64(pendingPaste.encodedAnchorBefore) }
              : {}),
            ...(pendingPaste.encodedAnchorAfter != null
              ? { anchorAfter: decodeBase64(pendingPaste.encodedAnchorAfter) }
              : {}),
          },
        ],
      ),
    );

    return {
      fileIds: Array.isArray(storedDraft.fileIds) ? storedDraft.fileIds : [],
      pendingPastes,
      pastedTextIds: Array.isArray(storedDraft.pastedTextIds) ? storedDraft.pastedTextIds : [],
      tabId: typeof storedDraft.tabId === 'string' ? storedDraft.tabId : undefined,
    };
  } catch {
    return { fileIds: [], pendingPastes: {} };
  }
};

const TAB_SESSION_STORAGE_KEY = 'librechat-tab-session';

let documentTabId: string | null = null;

/** Identifies this browser tab for the session. `sessionStorage` is per-tab and survives that
 * tab's reloads, which is exactly the ownership an unsaved-chat draft needs: the draft key is
 * shared through `localStorage` by every tab's default composer, while the composer that owns
 * the record stays identifiable.
 *
 * One caveat decides the shape below: duplicated and opener-created tabs start with a COPY of
 * the original's `sessionStorage`, so a stored id on its own proves nothing. Reload of the same
 * document legitimately keeps it, and so does Back/Forward after the document was evicted from
 * the back-forward cache (Navigation Timing reports `back_forward`, not `reload`). Every other
 * entry into a document mints a fresh id, because an inherited one would attribute another
 * tab's live drafts to this composer. */
/** `crypto.randomUUID` is missing on insecure origins and in older webviews, and letting that
 * throw would leave the tab with no identity at all: every draft would be written unowned and
 * every guard here would read another tab's record as its own. The id only has to tell tabs
 * apart, never resist guessing, so any unique-enough value serves. */
const mintTabId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // Fall through to the local mint.
    }
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};

const resolveBrowserTabId = (): string => {
  try {
    const stored = sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (documentTabId != null && stored === documentTabId) {
      return documentTabId;
    }
    const navigationType =
      typeof performance.getEntriesByType === 'function'
        ? performance.getEntriesByType('navigation')[0]?.type
        : undefined;
    if (
      stored != null &&
      stored !== '' &&
      (navigationType === 'reload' || navigationType === 'back_forward')
    ) {
      documentTabId = stored;
      return stored;
    }
    documentTabId = mintTabId();
    sessionStorage.setItem(TAB_SESSION_STORAGE_KEY, documentTabId);
    return documentTabId;
  } catch {
    /** Session storage can be blocked or full while `localStorage` still works. Returning '' here
     * gave the document no identity at all, and every ownership and liveness guard reads '' as
     * unattributed, so tabs would overwrite and destructively clear each other's attachment-backed
     * drafts. An id that lives only for this document still tells the open tabs apart; all that is
     * lost is recognising itself after a reload. */
    documentTabId = documentTabId ?? mintTabId();
    return documentTabId;
  }
};

/** `suspended` marks a document sitting in the back-forward cache: frozen rather than gone.
 * `attachments` is what that tab's composers currently hold, per pane, so cleanup running in one
 * tab can see what another has on screen even when nothing was written to a draft. */
type TabPresence = {
  seenAt: number;
  suspended?: boolean;
  attachments?: Record<string, string[]>;
  /** Ids this tab held recently, kept for a while after they leave the composer. Sending a
   * message empties the map and clears the draft, so without this a file reattached here and
   * then sent would go unprotected between another tab's retries and be deleted out of the
   * message that now references it. A retry that sees one cancels its record for good, so the
   * window only has to outlast that tab's backoff. */
  recent?: Record<string, number>;
};
type StoredTabPresence = {
  seenAt?: number;
  suspended?: boolean;
  attachments?: unknown;
  recent?: unknown;
};

const RECENT_ATTACHMENT_WINDOW_MS = 600_000;

/** One key per tab, never a shared map. Two tabs beating at the same time would otherwise read
 * the same registry and write back rival snapshots, and the loser of that race disappears until
 * its next beat, long enough for another tab to treat its live draft as abandoned. */
const TAB_PRESENCE_KEY_PREFIX = 'librechat-live-tab:';
const TAB_HEARTBEAT_MS = 10_000;
/** A hidden tab has its timers throttled to roughly one tick a minute, so the gap between two
 * heartbeats of a perfectly healthy background composer is far wider than the interval asks for.
 * The window has to clear that comfortably, or a backgrounded tab would have its own draft taken
 * away from it. Losing a closed tab's claim a couple of minutes late costs nothing; taking a live
 * tab's draft costs the text it was still writing. */
const TAB_LIVENESS_WINDOW_MS = 150_000;
/** A bfcached document's heartbeat is frozen, so the ordinary window would expire a tab that can
 * still be restored with those attachments on screen, and another tab could delete the files
 * underneath it. It gets a far longer grace, comfortably past the point where browsers evict a
 * bfcache entry, but still a bounded one: a claim that never expired is exactly what left drafts
 * stranded under owners that no longer existed. */
const TAB_SUSPENDED_WINDOW_MS = 1_800_000;

const isPresenceLive = (presence: TabPresence, now: number): boolean =>
  now - presence.seenAt <=
  (presence.suspended === true ? TAB_SUSPENDED_WINDOW_MS : TAB_LIVENESS_WINDOW_MS);

const toAttachments = (value: unknown): Record<string, string[]> | undefined => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const attachments: Record<string, string[]> = {};
  for (const [pane, ids] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(ids)) {
      attachments[pane] = ids.filter((id): id is string => typeof id === 'string');
    }
  }
  return attachments;
};

const toRecent = (value: unknown): Record<string, number> | undefined => {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const recent: Record<string, number> = {};
  for (const [id, seenAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seenAt === 'number') {
      recent[id] = seenAt;
    }
  }
  return recent;
};

const readTabPresence = (tabId: string): TabPresence | null => {
  try {
    const raw = localStorage.getItem(`${TAB_PRESENCE_KEY_PREFIX}${tabId}`);
    if (raw == null || raw === '') {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredTabPresence | null;
    if (parsed == null || typeof parsed.seenAt !== 'number') {
      return null;
    }
    return {
      seenAt: parsed.seenAt,
      suspended: parsed.suspended === true,
      attachments: toAttachments(parsed.attachments),
      recent: toRecent(parsed.recent),
    };
  } catch {
    return null;
  }
};

const writeTabPresence = (tabId: string, presence: TabPresence): void => {
  try {
    localStorage.setItem(`${TAB_PRESENCE_KEY_PREFIX}${tabId}`, JSON.stringify(presence));
  } catch {
    // A tab that cannot record a heartbeat reads as gone, which only ever releases its claims.
  }
};

/** Every tab still reporting, dropping the records of those that stopped so the store cannot grow
 * an entry for every tab the browser has ever opened. */
const readLiveTabs = (): Map<string, TabPresence> => {
  const live = new Map<string, TabPresence>();
  try {
    const now = Date.now();
    const expired: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key == null || !key.startsWith(TAB_PRESENCE_KEY_PREFIX)) {
        continue;
      }
      const tabId = key.slice(TAB_PRESENCE_KEY_PREFIX.length);
      const presence = readTabPresence(tabId);
      if (presence == null || !isPresenceLive(presence, now)) {
        expired.push(key);
        continue;
      }
      live.set(tabId, presence);
    }
    for (const key of expired) {
      localStorage.removeItem(key);
    }
  } catch {
    // An unreadable store just means no other tab can be proven live.
  }
  return live;
};

/** Marks this tab as present. Only ever writes this tab's own key, so concurrent beats cannot
 * overwrite one another. */
const recordTabPresence = (tabId: string, suspended = false): void => {
  /** Read before sweeping, never after. Timers pause while the machine sleeps, so a perfectly
   * live tab can come back with its own record already past the liveness window; letting the
   * sweep reap it first and then rewriting from nothing published an empty presence, and because
   * the file map had not changed there was nothing to make `useAutoSave` republish it. Another
   * tab's retry would then see no claim on chips this one still has on screen. */
  const existing = readTabPresence(tabId);
  /** The beat is the only thing guaranteed to run, so it is where the sweep belongs. Hanging it
   * off cleanup meant a profile that never had a failed deletion accumulated a record for every
   * tab it had ever opened, until the origin quota ran out and draft writes began failing. */
  readLiveTabs();
  writeTabPresence(tabId, {
    seenAt: Date.now(),
    ...(suspended ? { suspended: true } : {}),
    ...(existing?.attachments != null ? { attachments: existing.attachments } : {}),
    ...(existing?.recent != null ? { recent: existing.recent } : {}),
  });
};

/** Publishes what a composer is holding right now, so cleanup in another tab can see attachments
 * that never reached a draft: with draft saving off nothing is written at all, and a reattached
 * file would otherwise look like nobody's. */
export const publishTabAttachmentIds = (index: number, ids: string[]): void => {
  const tabId = getBrowserTabId();
  if (tabId === '') {
    return;
  }
  const now = Date.now();
  const existing = readTabPresence(tabId);
  const attachments = { ...(existing?.attachments ?? {}) };
  if (ids.length === 0) {
    delete attachments[index];
  } else {
    attachments[index] = ids;
  }
  const recent: Record<string, number> = {};
  for (const [id, seenAt] of Object.entries(existing?.recent ?? {})) {
    if (now - seenAt <= RECENT_ATTACHMENT_WINDOW_MS) {
      recent[id] = seenAt;
    }
  }
  for (const id of ids) {
    recent[id] = now;
  }
  /** Publishing is a user-visible act, so it is proof this tab is running right now. Carrying the
   * old `seenAt` over meant a tab whose timers had been paused past the liveness window published
   * a chip and stayed expired until its next interval tick, long enough for another tab's cleanup
   * to sweep the record and delete the file under the chip that had just appeared. A document
   * publishing attachments is also plainly not frozen in the back-forward cache. */
  writeTabPresence(tabId, {
    seenAt: now,
    ...(Object.keys(attachments).length > 0 ? { attachments } : {}),
    ...(Object.keys(recent).length > 0 ? { recent } : {}),
  });
};

/** Withdraws attachment ids from this tab's own presence, so a chip that left a composer stops
 * reading as live. A discarded or deleted file otherwise keeps its `recent` entry for the whole
 * window, and the retry sweep reads that as evidence the file was reattached: it cancels its own
 * cleanup and leaves the failed upload orphaned on the server.
 *
 * Strictly this tab's record, never another's. A second tab that reattached the same file and then
 * sent it has an empty composer and an empty draft, so its `recent` entry is the only thing left
 * protecting the file; erasing that here would hand the next retry a file it reads as abandoned
 * and let it delete the upload out of the message that now references it. The withdrawing tab is
 * always the one that published what it is withdrawing, so its own record is all it needs.
 *
 * `index` narrows that further to the one pane doing the withdrawing. One tab holds several
 * composers, and the hook that wins the global deletion pass only knows its own `files` map, so
 * sweeping every pane's entry would erase the evidence of a chip a sibling pane still has on
 * screen. Omitted only by callers that speak for the whole tab. */
export const removeTabAttachmentPresence = (ids: string[], index?: number): void => {
  if (ids.length === 0) {
    return;
  }
  const tabId = getBrowserTabId();
  if (tabId === '') {
    return;
  }
  const presence = readTabPresence(tabId);
  if (presence == null) {
    return;
  }
  const idSet = new Set(ids);
  let modified = false;
  const attachments = { ...presence.attachments };
  for (const [pane, paneIds] of Object.entries(attachments)) {
    if (index != null && pane !== `${index}`) {
      continue;
    }
    const kept = paneIds.filter((id) => !idSet.has(id));
    if (kept.length === paneIds.length) {
      continue;
    }
    if (kept.length === 0) {
      delete attachments[pane];
    } else {
      attachments[pane] = kept;
    }
    modified = true;
  }
  /** Whatever any pane of this tab still shows stays protected: `recent` is one flat map for the
   * whole tab, so withdrawing an id a sibling pane is still holding would drop the only record of
   * it when draft saving is off. */
  const heldElsewhere = new Set(Object.values(attachments).flat());
  const recent = { ...presence.recent };
  for (const id of idSet) {
    if (recent[id] == null || heldElsewhere.has(id)) {
      continue;
    }
    /** A chip leaving is not evidence the file is unused: this tab may have sent the same file on
     * an earlier message and only now be removing a later reattachment of it. The `recent` entry
     * is the only cross-tab record of that submitted use once the composer and draft have cleared,
     * so an id a submission already consumed keeps its entry and ages out on the ordinary window
     * instead of being withdrawn here. */
    if (isPasteSubmitted(id)) {
      continue;
    }
    delete recent[id];
    modified = true;
  }
  if (!modified) {
    return;
  }
  /** Withdrawing is a user-visible act, so it proves this tab is running right now. A suspended
   * document is not withdrawing anything. Carrying the old `seenAt` over would let the collection
   * sweep remove this record immediately, including claims from sibling panes still on screen. */
  writeTabPresence(tabId, {
    seenAt: Date.now(),
    ...(Object.keys(attachments).length > 0 ? { attachments } : {}),
    ...(Object.keys(recent).length > 0 ? { recent } : {}),
  });
};

/** Every attachment id a live tab's composers are currently showing, or held recently enough to
 * still count.
 *
 * `excludeOwnPane` is how a discard asks what everyone *else* is holding. It cannot count its own
 * pane, because that pane's chips are precisely what it is discarding, and it cannot count this
 * tab's `recent` either, since that map is flat and cannot say which pane an id came from. Every
 * other pane of this tab does count: side-by-side composers are as independent as separate tabs
 * here, and excluding the whole tab deleted files out from under a sibling pane's live chip.
 * Pass `'tab'` when the caller speaks for the tab as a whole rather than one pane. */
export const collectLiveAttachmentIds = ({
  excludeOwnPane,
}: { excludeOwnPane?: number | 'tab' } = {}): Set<string> => {
  const ids = new Set<string>();
  const now = Date.now();
  const ownTabId = excludeOwnPane === undefined ? '' : getBrowserTabId();
  for (const [tabId, presence] of readLiveTabs()) {
    const isOwnTab = ownTabId !== '' && tabId === ownTabId;
    if (isOwnTab && excludeOwnPane === 'tab') {
      continue;
    }
    for (const [pane, paneIds] of Object.entries(presence.attachments ?? {})) {
      if (isOwnTab && pane === `${excludeOwnPane}`) {
        continue;
      }
      for (const id of paneIds) {
        ids.add(id);
      }
    }
    if (isOwnTab) {
      continue;
    }
    for (const [id, seenAt] of Object.entries(presence.recent ?? {})) {
      if (now - seenAt <= RECENT_ATTACHMENT_WINDOW_MS) {
        ids.add(id);
      }
    }
  }
  return ids;
};

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTabId: string | null = null;

const startTabHeartbeat = (tabId: string): void => {
  if (heartbeatTabId === tabId || typeof window === 'undefined') {
    return;
  }
  heartbeatTabId = tabId;
  recordTabPresence(tabId);
  if (heartbeatTimer != null) {
    return;
  }
  const beat = (): void => {
    if (heartbeatTabId != null) {
      recordTabPresence(heartbeatTabId);
    }
  };
  heartbeatTimer = setInterval(beat, TAB_HEARTBEAT_MS);
  /** `pagehide` cannot tell a close from a reload, and the id deliberately survives a reload, so
   * releasing the claim here would hand this tab's own draft to another one while the document
   * was still bootstrapping. A closed tab is left to the ordinary window instead, which is what
   * the window is for. `persisted` is the one case worth marking: the document is going into the
   * back-forward cache with a frozen heartbeat, so it is parked for the longer grace and beats
   * normally again on `pageshow`. */
  window.addEventListener('pagehide', (event) => {
    if (heartbeatTabId != null && event.persisted) {
      recordTabPresence(heartbeatTabId, true);
    }
  });
  window.addEventListener('pageshow', beat);
};

export const getBrowserTabId = (): string => {
  const tabId = resolveBrowserTabId();
  if (tabId !== '') {
    startTabHeartbeat(tabId);
  }
  return tabId;
};

/** Whether the tab a claim names is still around to act on it. A closed tab's `sessionStorage`
 * goes with it, so its id can never be presented again: without a liveness view its drafts would
 * stay stamped to an owner that no longer exists, and no tab could restore, update, or clean them
 * up again. */
export const isTabLive = (tabId?: string | null): boolean => {
  if (tabId == null || tabId === '') {
    return false;
  }
  if (tabId === documentTabId) {
    return true;
  }
  const presence = readTabPresence(tabId);
  return presence != null && isPresenceLive(presence, Date.now());
};

/** Destructive readers skip a record another tab still owns. Untagged legacy drafts are treated
 * as owned so pre-stamp recovery still deletes and clears, and so is a record whose owning tab
 * has since gone away, which is the only way its draft becomes reachable again. */
export const isFilesDraftOwnedByThisTab = (draft: FilesDraft): boolean =>
  draft.tabId == null || draft.tabId === getBrowserTabId() || !isTabLive(draft.tabId);

let filesDraftCache: { id: string; raw: string | null; draft: FilesDraft } | null = null;

/** Reads a files draft without re-parsing storage when the record has not changed. Paste text can
 * dominate the draft's size, and consumers re-read per file-map change, not per write. */
export const getFilesDraftCached = (id: string): FilesDraft => {
  const raw = getLocalStorageItem(`${LocalStorageKeys.FILES_DRAFT}${id}`);
  if (filesDraftCache != null && filesDraftCache.id === id && filesDraftCache.raw === raw) {
    return filesDraftCache.draft;
  }
  const draft = getFilesDraft(id);
  filesDraftCache = { id, raw, draft };
  return draft;
};

/** Adds a paste-generated file id to a draft's persistent provenance record. */
export const addPastedTextDraftFile = ({ id, fileId }: { id: string; fileId: string }): void => {
  const draft = getFilesDraft(id);
  if (draft.pastedTextIds?.includes(fileId) === true) {
    return;
  }
  setFilesDraft(id, {
    ...draft,
    pastedTextIds: [...(draft.pastedTextIds ?? []), fileId],
  });
};

export const setFilesDraft = (id: string, draft: FilesDraft): void => {
  const key = `${LocalStorageKeys.FILES_DRAFT}${id}`;
  const pendingPasteEntries = Object.entries(draft.pendingPastes);
  /** Stamp only the first writer, and only for as long as that writer is still open. A later
   * restore or autosave from another live tab must not steal ownership: that stamp is what keeps
   * Edit / Move back / New Chat from deleting a file the original tab still has attached. Once
   * the owner is gone the claim is worth nothing, so the tab writing now takes it over rather
   * than leaving the record stranded under an id that can never come back. */
  const claimed = draft.tabId ?? getFilesDraft(id).tabId;
  const tabId = (claimed != null && isTabLive(claimed) ? claimed : getBrowserTabId()) || undefined;
  filesDraftCache = null;
  if (
    draft.fileIds.length === 0 &&
    pendingPasteEntries.length === 0 &&
    (draft.pastedTextIds?.length ?? 0) === 0
  ) {
    /** Nothing attached, but on a shared key this record is also the only thing saying whose text
     * is stored there, and dropping it leaves that text unowned for another tab to clear.
     * `useAutoSave` rewrites the draft with an empty file map on every reset and every composer
     * mount, so a claim that did not survive this branch barely survived at all. The text itself
     * is the condition, exactly as in `releaseComposerDraftTab`: with none, the claim is residue
     * and the record still goes. */
    const holdsText = (getLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${id}`) ?? '') !== '';
    if (tabId != null && holdsText && isSharedComposerDraftId(id)) {
      setLocalStorageItem(key, JSON.stringify({ fileIds: [], tabId }));
      return;
    }
    removeLocalStorageItem(key);
    return;
  }

  if (pendingPasteEntries.length === 0) {
    /** Keep the bare array shape when there is nothing to add, so older readers are unaffected. */
    const bareFileIds = !draft.pastedTextIds?.length && !tabId;
    setLocalStorageItem(
      key,
      JSON.stringify(
        bareFileIds
          ? draft.fileIds
          : {
              fileIds: draft.fileIds,
              ...(draft.pastedTextIds?.length ? { pastedTextIds: draft.pastedTextIds } : {}),
              ...(tabId ? { tabId } : {}),
            },
      ),
    );
    return;
  }

  const pendingPastes = Object.fromEntries(
    pendingPasteEntries.map(
      ([fileId, pendingPaste]): [string, StoredPendingTextAttachmentDraft] => [
        fileId,
        {
          encodedText: encodeBase64(pendingPaste.text),
          selectionStart: pendingPaste.selectionStart,
          ...(pendingPaste.selectionEnd != null &&
          pendingPaste.selectionEnd !== pendingPaste.selectionStart
            ? { selectionEnd: pendingPaste.selectionEnd }
            : {}),
          ...(pendingPaste.replacedText
            ? { encodedReplacedText: encodeBase64(pendingPaste.replacedText) }
            : {}),
          ...(pendingPaste.sequence != null ? { sequence: pendingPaste.sequence } : {}),
          ...(pendingPaste.replacedApplied ? { replacedApplied: true } : {}),
          ...(pendingPaste.anchorBefore != null
            ? { encodedAnchorBefore: encodeBase64(pendingPaste.anchorBefore) }
            : {}),
          ...(pendingPaste.anchorAfter != null
            ? { encodedAnchorAfter: encodeBase64(pendingPaste.anchorAfter) }
            : {}),
        },
      ],
    ),
  );

  setLocalStorageItem(
    key,
    JSON.stringify({
      fileIds: draft.fileIds,
      pendingPastes,
      ...(draft.pastedTextIds?.length ? { pastedTextIds: draft.pastedTextIds } : {}),
      ...(tabId ? { tabId } : {}),
    } satisfies StoredFilesDraft),
  );
};

/** Every attachment id any persisted composer draft is holding, across every key and therefore
 * every tab: `localStorage` is shared, so a draft another tab wrote for a conversation this one
 * has never opened is still readable here. Cleanup that only consulted this pane's own keys would
 * delete a file a second tab had reattached somewhere else.
 *
 * `excludeIds` leaves out the keys the caller is itself discarding. Those drafts are the reason
 * the deletion exists, so counting them as protection would cancel every discard; every other
 * key, including this tab's own conversation drafts, still counts. */
export const collectDraftedAttachmentIds = (excludeIds: string[] = []): Set<string> => {
  const ids = new Set<string>();
  const excluded = new Set(excludeIds);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key == null || !key.startsWith(LocalStorageKeys.FILES_DRAFT)) {
        continue;
      }
      const draftId = key.slice(LocalStorageKeys.FILES_DRAFT.length);
      if (excluded.has(draftId)) {
        continue;
      }
      const draft = getFilesDraft(draftId);
      for (const fileId of draft.fileIds) {
        ids.add(fileId);
      }
      for (const pasteId of draft.pastedTextIds ?? []) {
        ids.add(pasteId);
      }
      for (const pendingId of Object.keys(draft.pendingPastes)) {
        ids.add(pendingId);
      }
    }
  } catch {
    // An unreadable store just means no drafted ids to protect beyond the caller's own.
  }
  return ids;
};

/** Every attachment id something other than the caller still claims: any persisted draft outside
 * the keys it is acting on, plus what every other live tab publishes. Every path that deletes an
 * upload has to consult this first, because a second tab or pane can have reattached the same
 * library file, or sent it, and its claim is the only thing standing between that file and the
 * request. One helper rather than a union rebuilt at each deletion site: the guard was missed at
 * three of them precisely because each site assembled it by hand. */
export const collectForeignAttachmentClaims = (
  excludeDraftIds: string[] = [],
  excludeOwnPane: number | 'tab' = 'tab',
): Set<string> => {
  const ids = collectDraftedAttachmentIds(excludeDraftIds);
  for (const liveId of collectLiveAttachmentIds({ excludeOwnPane })) {
    ids.add(liveId);
  }
  return ids;
};

const hasDraftAttachments = (draft: FilesDraft): boolean =>
  draft.fileIds.length > 0 ||
  Object.keys(draft.pendingPastes).length > 0 ||
  (draft.pastedTextIds?.length ?? 0) > 0;

/** A record another open tab is holding against files it still has on screen. Writing over its
 * text, or clearing it, would destroy a draft this tab could never have restored anyway. */
const isForeignAttachmentClaim = (draft: FilesDraft, tabId: string): boolean =>
  draft.tabId != null &&
  draft.tabId !== tabId &&
  hasDraftAttachments(draft) &&
  isTabLive(draft.tabId);

/** Whether this tab may write the text record behind a draft key. Conversation keys are reachable
 * from every tab viewing that chat and are stamped just like the shared composer ones, so the
 * guard is not limited to those. Only an attachment-backed claim refuses a write: last writer wins
 * for text is deliberate, or the tab that typed last could not restore what it typed. */
export const mayWriteComposerText = (id: string): boolean => {
  const tabId = getBrowserTabId();
  return tabId === '' || !isForeignAttachmentClaim(getFilesDraftCached(id), tabId);
};

/** Any live tab other than this one has the key stamped, whether or not anything is attached. */
const isForeignLiveClaim = (draft: FilesDraft, tabId: string): boolean =>
  draft.tabId != null && draft.tabId !== tabId && isTabLive(draft.tabId);

/** Whether this tab may destroy what is behind a draft key. Stricter than the write guard on
 * purpose: `claimComposerDraftTab` stamps a key that holds nothing but text, and overwriting that
 * text is a normal race between panes, but deleting another live tab's record is not. Tab A
 * finishing a run that began as an unsaved chat would otherwise clear the shared new-chat key and
 * take tab B's half-written message with it, with no attachment anywhere to refuse it. */
export const mayClearComposerDrafts = (id: string): boolean => {
  const tabId = getBrowserTabId();
  return tabId === '' || !isForeignLiveClaim(getFilesDraftCached(id), tabId);
};

/** Records which tab a shared composer key belongs to when text is all it holds. The files draft
 * doubles as the ownership record, but it is only written once there is an attachment, so a typed
 * but unattached draft read as unowned and another tab's New Chat cleared it. */
export const claimComposerDraftTab = (id: string): boolean => {
  /** Reached from every debounced keystroke, so it reads through the cache rather than
   * re-parsing the record each time. */
  const existing = getFilesDraftCached(id);
  const tabId = getBrowserTabId();
  /** Already ours, or storage cannot attribute a tab at all: there is nothing to claim and the
   * write goes ahead. This has to come first, or the owner of an attachment-backed draft would
   * be refused its own key and stop saving what it types. */
  if (existing.tabId === tabId || tabId === '') {
    return true;
  }
  /** A claim with nothing behind it speaks only for text, and the caller is about to overwrite
   * that text on a key every tab writes to: the stamp follows whoever's text is actually stored,
   * or the tab that typed last could not restore what it typed. A claim backed by an attachment
   * stays with its owner while that tab is open, because taking it would let this tab delete
   * files the other one still has on screen. */
  if (isForeignAttachmentClaim(existing, tabId)) {
    return false;
  }
  if (hasDraftAttachments(existing)) {
    setFilesDraft(id, { ...existing, tabId });
    return true;
  }
  /** Nothing but the claim to store. `setFilesDraft` drops an empty record rather than leaving
   * a stub behind, which is right for attachments and wrong for this. */
  filesDraftCache = null;
  setLocalStorageItem(
    `${LocalStorageKeys.FILES_DRAFT}${id}`,
    JSON.stringify({ fileIds: [], tabId }),
  );
  return true;
};

/** Drops a claim with nothing behind it. Once the text is cleared and nothing is attached, the
 * record is pure residue, and leaving it would lock the shared key to a tab that no longer has a
 * draft there: the next tab to type could neither restore its own text nor take the key back. */
export const releaseComposerDraftTab = (id: string): void => {
  const existing = getFilesDraftCached(id);
  if (
    existing.tabId == null ||
    existing.tabId !== getBrowserTabId() ||
    hasDraftAttachments(existing)
  ) {
    return;
  }
  filesDraftCache = null;
  removeLocalStorageItem(`${LocalStorageKeys.FILES_DRAFT}${id}`);
};

/** Moves a text draft between keys, reporting whether there was one to move. */
export const migrateTextDraft = (fromId: string, toId: string): boolean => {
  const key = `${LocalStorageKeys.TEXT_DRAFT}${fromId}`;
  const draftText = getLocalStorageItem(key);
  removeLocalStorageItem(key);
  if (!draftText) {
    return false;
  }

  setLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${toId}`, draftText);
  return true;
};

/**
 * Moves a files draft between keys without ever holding two copies: a pending long paste can be
 * most of the storage budget on its own, so writing the destination while the source still exists
 * is what trips quota. Returns the id the record ended up under, so a caller that failed to move
 * it can still recover from the key that kept it.
 */
export const migrateFilesDraft = (fromId: string, toId: string): string => {
  const key = `${LocalStorageKeys.FILES_DRAFT}${fromId}`;
  const record = getLocalStorageItem(key);
  if (!record) {
    return toId;
  }

  removeLocalStorageItem(key);
  try {
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}${toId}`, record);
    return toId;
  } catch {
    /** Storage cannot hold the record even with the source freed, so put it back rather than
     * dropping attachments that recovery can still read from the key it came from. */
    setLocalStorageItem(key, record);
    return fromId;
  }
};

export const setPendingTextAttachmentDraft = ({
  id,
  fileId,
  text,
  selectionStart,
  selectionEnd,
  replacedText,
  replacedApplied,
  anchorBefore,
  anchorAfter,
}: {
  id: string;
  fileId: string;
  text: string;
  selectionStart: number;
  selectionEnd?: number;
  replacedText?: string;
  replacedApplied?: boolean;
  anchorBefore?: string;
  anchorAfter?: string;
}): void => {
  const draft = getFilesDraft(id);
  const existing = draft.pendingPastes[fileId];
  const sequence =
    existing?.sequence ??
    Math.max(0, ...Object.values(draft.pendingPastes).map((paste) => paste.sequence ?? 0)) + 1;
  setFilesDraft(id, {
    fileIds: draft.fileIds.includes(fileId) ? draft.fileIds : [...draft.fileIds, fileId],
    pastedTextIds: draft.pastedTextIds,
    pendingPastes: {
      ...draft.pendingPastes,
      [fileId]: {
        text,
        selectionStart,
        sequence,
        ...(selectionEnd != null ? { selectionEnd } : {}),
        ...(replacedText ? { replacedText } : {}),
        ...(replacedApplied ? { replacedApplied: true } : {}),
        ...(anchorBefore != null ? { anchorBefore } : {}),
        ...(anchorAfter != null ? { anchorAfter } : {}),
      },
    },
  });
};

export const removePendingTextAttachmentDraft = ({
  id,
  fileId,
  removeFile = false,
}: {
  id: string;
  fileId: string;
  removeFile?: boolean;
}): void => {
  const draft = getFilesDraft(id);
  const pendingPastes = { ...draft.pendingPastes };
  delete pendingPastes[fileId];
  /** `removeFile` means the upload never landed or is gone, so its provenance goes with it.
   * Leaving the id in `pastedTextIds` was enough for `hasDraftAttachments` to read the record as a
   * real attachment claim, and since the file map never changed there was no later render to prune
   * it: the stub then locked every other tab out of the shared composer key with no chip behind
   * it. */
  setFilesDraft(id, {
    fileIds: removeFile
      ? draft.fileIds.filter((draftFileId) => draftFileId !== fileId)
      : draft.fileIds,
    pastedTextIds: removeFile
      ? draft.pastedTextIds?.filter((pasteId) => pasteId !== fileId)
      : draft.pastedTextIds,
    pendingPastes,
  });
};

export const setDraft = ({ id, value }: { id: string; value?: string }) => {
  const shouldPersist = value != null && value.length > 0;
  if (shouldPersist) {
    /** A refused key belongs to another open tab holding it against attachments it still has.
     * This tab could not restore what it wrote there anyway, so the write would only destroy that
     * tab's text for nothing. */
    if (!mayWriteComposerText(id)) {
      return;
    }
    /** Claim before writing, but only where ownership would not otherwise exist: the shared text
     * record has no per-tab copy, so once the write lands this tab's text is the only text there
     * is and the stamp has to agree. A conversation key is left unstamped unless something is
     * actually attached to it, since tabs are meant to share those. */
    if (isSharedComposerDraftId(id)) {
      claimComposerDraftTab(id);
    }
    setLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${id}`, encodeBase64(value ?? ''));
    return;
  }
  /** Stricter than the write path: an empty composer in this tab must not erase text another open
   * tab is still holding, and a tab that has only typed still holds it. */
  if (!mayClearComposerDrafts(id)) {
    return;
  }
  removeLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${id}`);
  if (isSharedComposerDraftId(id)) {
    releaseComposerDraftTab(id);
  }
};

export const getDraft = (id?: string): string | null =>
  decodeBase64((getLocalStorageItem(`${LocalStorageKeys.TEXT_DRAFT}${id ?? ''}`) ?? '') || '');

/** Discards a key's attachments while leaving its text where it is. New Chat deletes the uploads
 * the draft was holding, so restoring those chips would put back a file the server no longer has;
 * a typed message has no such resource behind it, and losing it is what made an unsaved chat the
 * one composer whose draft did not survive leaving and coming back.
 *
 * Written as an empty draft rather than a direct delete so the claim rule lives in one place:
 * `setFilesDraft` keeps a shared key's stamp while text is stored under it and drops the record
 * otherwise, which is also what the autosave write that follows this one has to do. */
export const clearFilesDraft = (id: string): void => {
  if (!mayClearComposerDrafts(id)) {
    return;
  }
  setFilesDraft(id, { fileIds: [], pendingPastes: {} });
};

/**
 * Draft-key prefix for a live `ask_user_question` answer phase. While the
 * composer doubles as the free-form answer box, its autosave switches to a key
 * derived from the pause's action id — so the conversation's own draft is left
 * untouched and comes back once the question resolves, and a half-typed answer
 * survives reloads/navigation for as long as its question stays live.
 */
export const ASK_ANSWER_DRAFT_PREFIX = 'ask-answer:';

export const getAskAnswerDraftId = (actionId: string): string =>
  `${ASK_ANSWER_DRAFT_PREFIX}${actionId}`;

export const isAskAnswerDraftId = (id?: string | null): boolean =>
  typeof id === 'string' && id.startsWith(ASK_ANSWER_DRAFT_PREFIX);
