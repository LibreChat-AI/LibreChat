import { LocalStorageKeys } from 'librechat-data-provider';

export const CHAT_TITLE_IN_TAB_KEY = 'chatTitleInTab';
export const DEFAULT_APP_TITLE = 'LibreChat';
let documentTitleRevision = 0;

export const getDocumentTitleRevision = (): number => documentTitleRevision;

export const hasRealTitle = (title?: string | null): title is string =>
  title != null && title !== '' && title !== 'New Chat';

const getAppTitle = (): string => {
  try {
    return localStorage.getItem(LocalStorageKeys.APP_TITLE) || DEFAULT_APP_TITLE;
  } catch {
    return DEFAULT_APP_TITLE;
  }
};

/** Reads the setting straight from localStorage so non-React callers stay in sync with the atom. */
export const isChatTitleInTabEnabled = (): boolean => {
  try {
    const saved = localStorage.getItem(CHAT_TITLE_IN_TAB_KEY);
    return saved === null ? true : (JSON.parse(saved) as boolean);
  } catch {
    return true;
  }
};

/**
 * Sets the tab title to the conversation title, or to the app title when the
 * conversation title is empty or the user opted out. The revision signal lets
 * title decorators observe a write even when the resulting string is unchanged.
 * Pass `enabled` when the atom's value is already known, since Recoil writes to
 * localStorage after the change handler runs.
 */
export const setDocumentTitle = (title?: string | null, enabled?: boolean): void => {
  const showChatTitle = enabled ?? isChatTitleInTabEnabled();
  document.title = showChatTitle && title != null && title !== '' ? title : getAppTitle();
  documentTitleRevision += 1;
};
