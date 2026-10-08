import { LocalStorageKeys } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import {
  hasRealTitle,
  getDisplayTitle,
  setDocumentTitle,
  CHAT_TITLE_IN_TAB_KEY,
  isChatTitleInTabEnabled,
} from '../documentTitle';

describe('document title', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LocalStorageKeys.APP_TITLE, 'LibreChat');
    document.title = '';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses a conversation title when chat titles are enabled', () => {
    setDocumentTitle('Project status', true);

    expect(document.title).toBe('Project status');
  });

  it('uses the app title when chat titles are disabled', () => {
    setDocumentTitle('Project status', false);

    expect(document.title).toBe('LibreChat');
  });

  it('uses the app title when the conversation title is empty', () => {
    setDocumentTitle('', true);

    expect(document.title).toBe('LibreChat');
  });

  it('uses a conversation deliberately titled New Chat when enabled', () => {
    setDocumentTitle('New Chat', true);

    expect(document.title).toBe('New Chat');
  });

  it('keeps rejecting the generated new chat placeholder as a real title', () => {
    expect(hasRealTitle('New Chat')).toBe(false);
  });

  it('uses the default app title when no app title is stored', () => {
    localStorage.removeItem(LocalStorageKeys.APP_TITLE);

    setDocumentTitle('', true);

    expect(document.title).toBe('LibreChat');
  });

  it('uses the default app title when the stored app title is empty', () => {
    localStorage.setItem(LocalStorageKeys.APP_TITLE, '');

    setDocumentTitle('', true);

    expect(document.title).toBe('LibreChat');
  });

  it('uses the default app title when storage is unavailable', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage unavailable');
    });

    setDocumentTitle('', true);

    expect(document.title).toBe('LibreChat');
  });

  it('defaults to enabled when the stored setting is malformed', () => {
    localStorage.setItem(CHAT_TITLE_IN_TAB_KEY, 'not-json');

    expect(isChatTitleInTabEnabled()).toBe(true);
  });
});

describe('getDisplayTitle', () => {
  const localize = ((key: string) => `t:${key}`) as LocalizeFunction;

  it('keeps a title the chat was given', () => {
    expect(getDisplayTitle('گزارش فروش', localize)).toBe('گزارش فروش');
  });

  it('reads the stored New Chat placeholder in the interface language', () => {
    expect(getDisplayTitle('New Chat', localize)).toBe('t:com_ui_new_chat');
  });

  it('labels a missing title as untitled', () => {
    expect(getDisplayTitle('', localize)).toBe('t:com_ui_untitled');
    expect(getDisplayTitle(null, localize)).toBe('t:com_ui_untitled');
    expect(getDisplayTitle(undefined, localize)).toBe('t:com_ui_untitled');
  });
});
