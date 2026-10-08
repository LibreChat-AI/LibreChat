import { LocalStorageKeys } from 'librechat-data-provider';
import { clearAllConversationStorage, clearLocalStorage } from '../localStorage';

describe('clearAllConversationStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('wipes the selection and conversation state but keeps unrelated keys', () => {
    localStorage.setItem(LocalStorageKeys.LAST_SPEC, 'some-spec');
    localStorage.setItem(LocalStorageKeys.LAST_MODEL, JSON.stringify({ openAI: 'gpt-4o' }));
    localStorage.setItem(LocalStorageKeys.LAST_TOOLS, JSON.stringify(['web_search']));
    localStorage.setItem(
      `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
      JSON.stringify({ spec: 'some-spec' }),
    );
    localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}0`, 'agent_1');
    localStorage.setItem('unrelated-key', 'keep-me');

    clearAllConversationStorage();

    expect(localStorage.getItem(LocalStorageKeys.LAST_SPEC)).toBeNull();
    expect(localStorage.getItem(LocalStorageKeys.LAST_MODEL)).toBeNull();
    expect(localStorage.getItem(LocalStorageKeys.LAST_TOOLS)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.LAST_CONVO_SETUP}_0`)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.AGENT_ID_PREFIX}0`)).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });
});

describe('clearLocalStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drops composer drafts so an account change cannot restore the last user text', () => {
    /** A files draft carries the whole text of a paste held as a file, and the browser tab keeps
     * its identity across an in-app account switch, so leaving these behind let the next account
     * be handed the previous one's writing by the ordinary draft restore. */
    localStorage.setItem(
      `${LocalStorageKeys.FILES_DRAFT}new`,
      JSON.stringify({ fileIds: [], pendingPastes: { 'paste-1': { encodedText: 'c2VjcmV0' } } }),
    );
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}new`, 'half-written message');
    localStorage.setItem('unrelated-key', 'keep-me');

    clearLocalStorage();

    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}new`)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}new`)).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });

  it('drops them even for the pane skipFirst would otherwise spare', () => {
    localStorage.setItem(`${LocalStorageKeys.FILES_DRAFT}new:0`, JSON.stringify({ fileIds: [] }));
    localStorage.setItem(`${LocalStorageKeys.TEXT_DRAFT}new:0`, 'first pane text');

    clearLocalStorage(true);

    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}new:0`)).toBeNull();
    expect(localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}new:0`)).toBeNull();
  });
});
