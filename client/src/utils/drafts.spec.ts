import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import {
  applyPendingPastesToDraft,
  clearAllDrafts,
  clearDraft,
  clearComposerDrafts,
  clearFilesDraft,
  decodeBase64,
  encodeBase64,
  resolvePendingPasteInsertStart,
  getComposerDraftId,
  getBrowserTabId,
  getDraft,
  getFilesDraft,
  getNewConversationDraftId,
  getNewConversationDraftToken,
  getNewConversationDraftRevision,
  getPendingDraftId,
  isFilesDraftOwnedByThisTab,
  isNewConversationDraftId,
  isTabLive,
  publishTabAttachmentIds,
  collectLiveAttachmentIds,
  removeTabAttachmentPresence,
  migrateFilesDraft,
  migrateTextDraft,
  renewNewConversationDraftToken,
  setDraft,
  setFilesDraft,
  subscribeDraftOwnership,
  registerComposerDraft,
  captureComposerDraft,
  bindComposerLaunch,
  consumeComposerQuery,
  adoptComposerConversation,
  resolveComposerConversationId,
  getActiveComposerDraftId,
  removePendingTextAttachmentDraft,
  setPendingTextAttachmentDraft,
} from './drafts';
import { markPasteSubmitted } from './files';

describe('new-conversation draft tokens', () => {
  it('keeps tokens independent across composer indexes', () => {
    const firstPaneToken = getNewConversationDraftToken(0);
    const secondPaneToken = getNewConversationDraftToken(1);

    expect(firstPaneToken).not.toBe(secondPaneToken);

    renewNewConversationDraftToken(1);

    expect(getNewConversationDraftToken(0)).toBe(firstPaneToken);
    expect(getNewConversationDraftToken(1)).not.toBe(secondPaneToken);
  });
});

describe('getPendingDraftId', () => {
  it('keeps the primary composer on the historical PENDING key', () => {
    expect(getPendingDraftId()).toBe(Constants.PENDING_CONVO);
    expect(getPendingDraftId(0)).toBe(Constants.PENDING_CONVO);
  });

  it('suffixes additional composer indexes', () => {
    expect(getPendingDraftId(1)).toBe(`${Constants.PENDING_CONVO}:1`);
  });
});

describe('getNewConversationDraftId', () => {
  it('keeps the primary composer on the historical NEW_CONVO key', () => {
    expect(getNewConversationDraftId()).toBe(Constants.NEW_CONVO);
    expect(getNewConversationDraftId(0)).toBe(Constants.NEW_CONVO);
  });

  it('suffixes additional composer indexes', () => {
    expect(getNewConversationDraftId(1)).toBe(`${Constants.NEW_CONVO}:1`);
  });

  it('treats suffixed keys as new-conversation drafts', () => {
    expect(isNewConversationDraftId(Constants.NEW_CONVO)).toBe(true);
    expect(isNewConversationDraftId(`${Constants.NEW_CONVO}:1`)).toBe(true);
    expect(isNewConversationDraftId('convo-1')).toBe(false);
  });

  it('scopes idle unsaved drafts and in-flight drafts separately', () => {
    expect(getComposerDraftId(1, Constants.NEW_CONVO)).toBe(`${Constants.NEW_CONVO}:1`);
    expect(getComposerDraftId(1, Constants.NEW_CONVO, true)).toBe(`${Constants.PENDING_CONVO}:1`);
    expect(getComposerDraftId(1, 'convo-side')).toBe('convo-side');
  });
});

describe('applyPendingPastesToDraft with a single paste', () => {
  it('replaces a stale selected range when the original text is still present', () => {
    expect(
      applyPendingPastesToDraft('before selected after', [
        {
          text: 'pasted',
          selectionStart: 7,
          selectionEnd: 15,
          replacedText: 'selected',
        },
      ]),
    ).toBe('before pasted after');
  });

  it('inserts at the caret when the selected range is already gone', () => {
    expect(
      applyPendingPastesToDraft('before  after', [
        {
          text: 'pasted',
          selectionStart: 7,
          selectionEnd: 15,
          replacedText: 'selected',
        },
      ]),
    ).toBe('before pasted after');
  });

  it('inserts at the caret when no replacement range was stored', () => {
    expect(
      applyPendingPastesToDraft('before  after', [
        {
          text: 'pasted',
          selectionStart: 7,
        },
      ]),
    ).toBe('before pasted after');
  });

  it('does not delete remaining identical text after a post-replacement snapshot', () => {
    expect(
      applyPendingPastesToDraft('abc', [
        {
          text: 'PASTE',
          selectionStart: 0,
          replacedText: 'abc',
          replacedApplied: true,
          anchorBefore: '',
          anchorAfter: 'abc',
        },
      ]),
    ).toBe('PASTEabc');
  });
});

describe('applyPendingPastesToDraft', () => {
  it('rebases an earlier end replacement after a later start replacement', () => {
    const pastes = [
      {
        text: 'END',
        selectionStart: 10,
        selectionEnd: 14,
        replacedText: 'CCCC',
        sequence: 1,
      },
      {
        text: 'START',
        selectionStart: 0,
        selectionEnd: 4,
        replacedText: 'AAAA',
        sequence: 2,
      },
    ];

    expect(applyPendingPastesToDraft('AAAA BBBB CCCC', pastes)).toBe('START BBBB END');
    expect(applyPendingPastesToDraft(' BBBB ', pastes)).toBe('START BBBB END');
  });

  it('rebases an insert after the user edits text before the original caret', () => {
    expect(
      applyPendingPastesToDraft('Xhello', [
        {
          text: 'PASTE',
          selectionStart: 5,
          replacedApplied: true,
          anchorBefore: 'hello',
          anchorAfter: '',
        },
      ]),
    ).toBe('XhelloPASTE');
  });

  it('rebases an insert past a prefix the user duplicated', () => {
    expect(
      applyPendingPastesToDraft('aabc', [
        {
          text: 'PASTE',
          selectionStart: 1,
          replacedApplied: true,
          anchorBefore: 'a',
          anchorAfter: 'bc',
        },
      ]),
    ).toBe('aaPASTEbc');
  });

  it('keeps a leading insert ahead of a suffix the user duplicated', () => {
    expect(
      applyPendingPastesToDraft('abcabc', [
        {
          text: 'PASTE',
          selectionStart: 0,
          replacedApplied: true,
          anchorBefore: '',
          anchorAfter: 'abc',
        },
      ]),
    ).toBe('PASTEabcabc');
  });

  it('rebases an insert when both sides of the original caret were edited', () => {
    expect(
      applyPendingPastesToDraft('XhelloWORLDY', [
        {
          text: 'PASTE',
          selectionStart: 5,
          replacedApplied: true,
          anchorBefore: 'hello',
          anchorAfter: 'WORLD',
        },
      ]),
    ).toBe('XhelloPASTEWORLDY');
  });

  it('keeps a later replacement anchored after an earlier middle removal', () => {
    expect(
      applyPendingPastesToDraft('0123456789', [
        {
          text: 'MID',
          selectionStart: 2,
          replacedText: '234',
          sequence: 1,
        },
        {
          text: 'TAIL',
          selectionStart: 5,
          replacedText: '89',
          sequence: 2,
        },
      ]),
    ).toBe('01MID567TAIL');
  });
});

describe('clearComposerDrafts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('clears pane-scoped pending and new-chat keys without touching another pane', () => {
    setDraft({ id: Constants.NEW_CONVO as string, value: 'pane 0 new' });
    setDraft({ id: `${Constants.NEW_CONVO}:1`, value: 'pane 1 new' });
    setDraft({ id: Constants.PENDING_CONVO as string, value: 'pane 0 pending' });
    setDraft({ id: `${Constants.PENDING_CONVO}:1`, value: 'pane 1 pending' });
    setFilesDraft(`${Constants.PENDING_CONVO}:1`, {
      fileIds: ['pane-1-file'],
      pendingPastes: {
        'pane-1-file': { text: 'paste', selectionStart: 0 },
      },
    });

    clearComposerDrafts(1, Constants.NEW_CONVO as string);

    expect(getDraft(Constants.NEW_CONVO)).toBe('pane 0 new');
    expect(getDraft(Constants.PENDING_CONVO)).toBe('pane 0 pending');
    expect(
      localStorage.getItem(`${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}:1`),
    ).toBeNull();
    expect(getDraft(`${Constants.PENDING_CONVO}:1`)).toBe('pane 1 pending');
    expect(
      localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${Constants.PENDING_CONVO}:1`),
    ).not.toBeNull();
  });

  it('does not clear an unrelated new-chat draft when a saved conversation finishes', () => {
    setDraft({ id: `${Constants.NEW_CONVO}:1`, value: 'unsent new chat' });
    setDraft({ id: 'convo-side', value: 'sent message leftover' });

    clearComposerDrafts(1, 'convo-side');

    expect(getDraft(`${Constants.NEW_CONVO}:1`)).toBe('unsent new chat');
    expect(getDraft('convo-side')).toBe('');
  });
});

describe('pending paste encoding', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** Past the argument limit that a spread into String.fromCharCode blows */
  const hugePaste = `${'a'.repeat(200000)} café 🧪`;

  it('round-trips a paste far larger than the call argument limit', () => {
    expect(decodeBase64(encodeBase64(hugePaste))).toBe(hugePaste);
  });

  it('stores and reads back a huge pending paste', () => {
    setPendingTextAttachmentDraft({
      id: 'convo-1',
      fileId: 'file-1',
      text: hugePaste,
      selectionStart: 0,
    });

    expect(getFilesDraft('convo-1').pendingPastes['file-1']?.text).toBe(hugePaste);
  });
});

/** One presence record per tab, matching the store the liveness check reads. */
const markTabLive = (tabId: string, seenAt = Date.now()): void =>
  localStorage.setItem(`librechat-live-tab:${tabId}`, JSON.stringify({ seenAt }));

describe('browser tab ownership of unsaved-chat drafts', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('returns a stable id per tab session', () => {
    const first = getBrowserTabId();
    expect(first).toBe(getBrowserTabId());
  });

  it('still attributes a tab when session storage is unusable', () => {
    /** Session storage can be blocked or quota-exhausted while localStorage still works. Returning
     * an empty id left the document unattributed, and every ownership and liveness guard reads
     * that as "no owner", so tabs would destructively clear each other's attachment-backed drafts.
     * An id that lasts only for this document still tells the open tabs apart. */
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation((key: string) => {
      if (key === 'librechat-tab-session') {
        throw new Error('session storage blocked');
      }
      return null;
    });

    try {
      expect(getBrowserTabId()).not.toBe('');
    } finally {
      getItem.mockRestore();
    }
  });

  /** jsdom's performance object has no navigation-timing entries at all, so the stub installs
   * the method rather than spying on it. */
  const withNavigationType = (type: string, run: () => void): void => {
    const performanceStub = performance as unknown as {
      getEntriesByType?: (type: string) => PerformanceEntry[];
    };
    const original = performanceStub.getEntriesByType;
    performanceStub.getEntriesByType = () => [{ type } as unknown as PerformanceEntry];
    try {
      run();
    } finally {
      if (original != null) {
        performanceStub.getEntriesByType = original;
      } else {
        delete performanceStub.getEntriesByType;
      }
    }
  };

  it('adopts the stored id when the same tab reloaded', () => {
    sessionStorage.setItem('librechat-tab-session', 'kept-through-reload');
    withNavigationType('reload', () => {
      expect(getBrowserTabId()).toBe('kept-through-reload');
    });
  });

  it('adopts the stored id on back-forward restoration', () => {
    sessionStorage.setItem('librechat-tab-session', 'kept-through-history');
    withNavigationType('back_forward', () => {
      expect(getBrowserTabId()).toBe('kept-through-history');
    });
  });

  it('still mints an id when the browser has no randomUUID', () => {
    /** Insecure origins and older webviews have none, and an empty id would leave every draft
     * unowned and every guard reading another tab's record as its own. */
    const original = crypto.randomUUID;

    (crypto as any).randomUUID = undefined;
    try {
      withNavigationType('navigate', () => {
        const minted = getBrowserTabId();
        expect(minted).not.toBe('');
        expect(minted).toBe(sessionStorage.getItem('librechat-tab-session'));
      });
    } finally {
      (crypto as any).randomUUID = original;
    }
  });

  it('mints a fresh id when storage was inherited by a cloned tab', () => {
    sessionStorage.setItem('librechat-tab-session', 'inherited-from-original');
    withNavigationType('navigate', () => {
      const minted = getBrowserTabId();
      expect(minted).not.toBe('inherited-from-original');
      expect(minted).toBe(sessionStorage.getItem('librechat-tab-session'));
    });
  });

  it('stamps the writing tab on unsaved-chat drafts', () => {
    setFilesDraft(Constants.NEW_CONVO, { fileIds: ['file-1'], pendingPastes: {} });

    expect(getFilesDraft(Constants.NEW_CONVO).tabId).toBe(getBrowserTabId());
  });

  it('stamps conversation drafts too: their key is shared by every tab viewing the chat', () => {
    setFilesDraft('convo-1', { fileIds: ['file-1'], pendingPastes: {} });

    expect(getFilesDraft('convo-1').tabId).toBe(getBrowserTabId());
  });

  it('treats a record owned by an open tab as another tab’s', () => {
    markTabLive('other-tab');

    expect(isFilesDraftOwnedByThisTab({ fileIds: [], pendingPastes: {}, tabId: 'other-tab' })).toBe(
      false,
    );
  });

  it('leaves no attachment claim behind when a rejected upload is removed', () => {
    /** Validation can reject a paste before it ever reaches composer state, and the failure path
     * removes it with `removeFile`. Keeping the id in `pastedTextIds` made the leftover record read
     * as a real attachment claim, and with the file map unchanged nothing would prune it, so the
     * stub locked every other tab out of the shared composer key with no chip behind it. */
    setPendingTextAttachmentDraft({
      id: Constants.NEW_CONVO as string,
      fileId: 'rejected-paste',
      text: 'a'.repeat(30),
      selectionStart: 0,
    });
    setFilesDraft(Constants.NEW_CONVO, {
      ...getFilesDraft(Constants.NEW_CONVO),
      pastedTextIds: ['rejected-paste'],
    });

    removePendingTextAttachmentDraft({
      id: Constants.NEW_CONVO as string,
      fileId: 'rejected-paste',
      removeFile: true,
    });

    const draft = getFilesDraft(Constants.NEW_CONVO);
    expect(draft.fileIds).toEqual([]);
    expect(draft.pastedTextIds ?? []).toEqual([]);
    expect(Object.keys(draft.pendingPastes)).toEqual([]);
  });

  it('reclaims a record whose owning tab has closed', () => {
    /** The tab that stamped it can never present that id again, so holding the claim open would
     * leave the draft unreachable to every tab, for good. */
    expect(
      isFilesDraftOwnedByThisTab({ fileIds: [], pendingPastes: {}, tabId: 'closed-tab' }),
    ).toBe(true);
  });

  it('keeps its claim when the page only enters the back-forward cache', () => {
    /** A bfcached document can come back with those attachments still on screen, so handing the
     * claim over now would let another tab delete the files out from under it. */
    const tabId = getBrowserTabId();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));

    expect(isTabLive(tabId)).toBe(true);
  });

  it('holds a bfcached claim past the ordinary liveness window', () => {
    /** A frozen heartbeat must not read as a dead tab: the document can still come back with
     * those attachments on screen. */
    const tabId = getBrowserTabId();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    const parked = JSON.parse(localStorage.getItem(`librechat-live-tab:${tabId}`) ?? '{}');
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({ ...parked, seenAt: Date.now() - 600_000 }),
    );

    expect(isTabLive(tabId)).toBe(true);
  });

  it('lets a bfcached claim go once even a restorable document would be gone', () => {
    const tabId = 'parked-tab';
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({ seenAt: Date.now() - 3_600_000, suspended: true }),
    );

    expect(isTabLive(tabId)).toBe(false);
  });

  it('stays live through an ordinary reload rather than releasing mid-bootstrap', () => {
    /** `pagehide` cannot tell a reload from a close, and the id survives a reload on purpose, so
     * releasing here would hand this tab's own draft away while the document was restarting. */
    const tabId = getBrowserTabId();
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));

    expect(isTabLive(tabId)).toBe(true);
  });

  it('lets a closed tab expire through the ordinary window', () => {
    markTabLive('closed-tab', Date.now() - 600_000);

    expect(isTabLive('closed-tab')).toBe(false);
  });

  it('keeps protecting an id after the composer that held it was emptied', () => {
    /** Sending clears the map and the draft, so without a memory of what this tab just held,
     * another tab's backed-off retry would delete a file the sent message now references. */
    publishTabAttachmentIds(0, ['sent-file']);
    publishTabAttachmentIds(0, []);

    expect(collectLiveAttachmentIds().has('sent-file')).toBe(true);
  });

  it('stops protecting an id when it is explicitly removed from presence', () => {
    publishTabAttachmentIds(0, ['discarded-file']);
    expect(collectLiveAttachmentIds().has('discarded-file')).toBe(true);

    removeTabAttachmentPresence(['discarded-file']);
    expect(collectLiveAttachmentIds().has('discarded-file')).toBe(false);
  });

  it("keeps another tab's recent record when withdrawing its own", () => {
    /** Once that tab reattached the file and sent it, its composer and its draft are both empty,
     * so this record is the only thing left protecting the upload. Erasing it here would hand the
     * next retry a file it reads as abandoned and let it delete the upload out of the message that
     * now references it. */
    localStorage.setItem(
      'librechat-live-tab:other-tab',
      JSON.stringify({ seenAt: Date.now(), recent: { 'shared-file': Date.now() } }),
    );
    publishTabAttachmentIds(0, ['shared-file']);

    removeTabAttachmentPresence(['shared-file']);

    expect(collectLiveAttachmentIds().has('shared-file')).toBe(true);
    expect(collectLiveAttachmentIds({ excludeOwnPane: 'tab' }).has('shared-file')).toBe(true);
  });

  it('keeps a submitted id protected when a later chip of it is removed', () => {
    /** The same file can be sent on one message and reattached afterwards. Removing that later
     * chip is not evidence the file is unused, and once the composer and draft have cleared this
     * entry is the only cross-tab record that a message still references it. */
    markPasteSubmitted('sent-then-reattached');
    publishTabAttachmentIds(0, ['sent-then-reattached']);

    removeTabAttachmentPresence(['sent-then-reattached']);

    expect(collectLiveAttachmentIds().has('sent-then-reattached')).toBe(true);
  });

  it("keeps a sibling pane's chip protected when one pane withdraws", () => {
    /** One tab holds several composers, and the hook that wins the global deletion pass only knows
     * its own pane's file map. Sweeping every pane's entry erased the evidence of a chip the other
     * pane still has on screen, and with draft saving off nothing else recorded it. */
    publishTabAttachmentIds(0, ['shared-across-panes']);
    publishTabAttachmentIds(1, ['shared-across-panes']);

    removeTabAttachmentPresence(['shared-across-panes'], 0);

    expect(collectLiveAttachmentIds().has('shared-across-panes')).toBe(true);
  });

  it("keeps a sibling pane's chip live when withdrawal resumes after liveness expires", () => {
    /** A resumed withdrawal proves the tab is running, just like publishing does. If it rewrites
     * its expired timestamp unchanged, the collection sweep removes the whole record and erases a
     * sibling pane's only claim before cleanup checks what remains on screen. */
    const tabId = getBrowserTabId();
    publishTabAttachmentIds(0, ['resumed-withdrawal']);
    publishTabAttachmentIds(1, ['resumed-withdrawal']);
    const presence = JSON.parse(localStorage.getItem(`librechat-live-tab:${tabId}`) ?? '{}');
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({ ...presence, seenAt: Date.now() - 600_000 }),
    );

    removeTabAttachmentPresence(['resumed-withdrawal'], 0);

    expect(collectLiveAttachmentIds({ excludeOwnPane: 0 }).has('resumed-withdrawal')).toBe(true);
  });

  it("reports a sibling pane's chip as claimed elsewhere", () => {
    /** Excluding the whole tab hid the other composer, so the pane doing the discarding deleted a
     * file the sibling still had on screen. Side-by-side panes are as independent here as separate
     * tabs; only the discarding pane's own entry is left out. */
    publishTabAttachmentIds(0, ['pane-0-file']);
    publishTabAttachmentIds(1, ['pane-1-file']);

    const claimed = collectLiveAttachmentIds({ excludeOwnPane: 0 });

    expect(claimed.has('pane-1-file')).toBe(true);
    expect(claimed.has('pane-0-file')).toBe(false);
  });

  it('refreshes liveness when a resumed tab publishes an attachment', () => {
    /** Publishing is a user-visible act, so it proves the tab is running. Rewriting the record
     * with its expired seenAt left a resumed tab looking dead until its next interval tick, long
     * enough for another tab's cleanup to delete the file under the chip just added. */
    const tabId = getBrowserTabId();
    publishTabAttachmentIds(0, ['first-file']);
    const presence = JSON.parse(localStorage.getItem(`librechat-live-tab:${tabId}`) ?? '{}');
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({ ...presence, seenAt: Date.now() - 600_000 }),
    );

    publishTabAttachmentIds(0, ['first-file', 'just-added']);

    expect(isTabLive(tabId)).toBe(true);
    expect(collectLiveAttachmentIds().has('just-added')).toBe(true);
  });

  it('keeps its own published ids through a heartbeat that resumes past the window', () => {
    /** Timers pause while the machine sleeps, so a live tab can beat again with its own record
     * already stale. Sweeping before reading it published an empty presence, and nothing would
     * republish it because the file map had not changed. */
    const tabId = getBrowserTabId();
    publishTabAttachmentIds(0, ['on-screen-file']);
    const presence = JSON.parse(localStorage.getItem(`librechat-live-tab:${tabId}`) ?? '{}');
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({ ...presence, seenAt: Date.now() - 600_000 }),
    );

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));

    expect(collectLiveAttachmentIds().has('on-screen-file')).toBe(true);
  });

  it('forgets a held id once the window has passed', () => {
    const tabId = getBrowserTabId();
    publishTabAttachmentIds(0, ['old-file']);
    const presence = JSON.parse(localStorage.getItem(`librechat-live-tab:${tabId}`) ?? '{}');
    localStorage.setItem(
      `librechat-live-tab:${tabId}`,
      JSON.stringify({
        ...presence,
        attachments: {},
        recent: { 'old-file': Date.now() - 900_000 },
      }),
    );

    expect(collectLiveAttachmentIds().has('old-file')).toBe(false);
  });

  it('does not drop another tab when both record a heartbeat', () => {
    /** One shared map meant two tabs could read the same snapshot and write back rival copies,
     * and the loser vanished until its next beat: long enough to look abandoned. */
    markTabLive('other-tab');
    const ownId = getBrowserTabId();

    expect(isTabLive('other-tab')).toBe(true);
    expect(isTabLive(ownId)).toBe(true);
  });

  it('reclaims a record whose owning tab stopped reporting long ago', () => {
    markTabLive('crashed-tab', Date.now() - 600_000);

    expect(
      isFilesDraftOwnedByThisTab({ fileIds: [], pendingPastes: {}, tabId: 'crashed-tab' }),
    ).toBe(true);
  });

  it('restamps a written record when the tab that claimed it is gone', () => {
    setFilesDraft(Constants.NEW_CONVO, {
      fileIds: ['file-1'],
      pendingPastes: {},
      tabId: 'closed-tab',
    });

    expect(getFilesDraft(Constants.NEW_CONVO).tabId).toBe(getBrowserTabId());
  });

  it('leaves the claim alone when the tab that made it is still open', () => {
    markTabLive('other-tab');
    setFilesDraft(Constants.NEW_CONVO, {
      fileIds: ['file-1'],
      pendingPastes: {},
      tabId: 'other-tab',
    });

    expect(getFilesDraft(Constants.NEW_CONVO).tabId).toBe('other-tab');
  });

  it('claims a shared composer key from a text draft with no attachment', () => {
    /** Ownership rides on the files record, which is only written once something is attached, so
     * a typed-but-unattached draft used to read as nobody's and be cleared by another tab. */
    setDraft({ id: getNewConversationDraftId(), value: 'queued follow-up' });

    expect(getFilesDraft(getNewConversationDraftId()).tabId).toBe(getBrowserTabId());
  });

  it('gives the shared key back when the text is cleared and nothing is attached', () => {
    /** Otherwise the empty claim outlives the draft and locks the key to a tab that has nothing
     * in it, leaving the next tab unable to restore its own text. */
    setDraft({ id: getNewConversationDraftId(), value: 'queued follow-up' });

    setDraft({ id: getNewConversationDraftId(), value: '' });

    expect(getFilesDraft(getNewConversationDraftId()).tabId).toBeUndefined();
  });

  it('keeps saving the owner’s own text once its draft has an attachment', () => {
    /** The refusal is about other tabs. Applying it to the owner would silently stop the
     * composer saving anything typed after the first file was attached. */
    setFilesDraft(getNewConversationDraftId(), { fileIds: ['my-file'], pendingPastes: {} });

    setDraft({ id: getNewConversationDraftId(), value: 'typed after attaching' });

    expect(getDraft(getNewConversationDraftId())).toBe('typed after attaching');
  });

  it('keeps the claim when clearing the text leaves an attachment behind', () => {
    setFilesDraft(getNewConversationDraftId(), { fileIds: ['file-1'], pendingPastes: {} });
    setDraft({ id: getNewConversationDraftId(), value: 'queued follow-up' });

    setDraft({ id: getNewConversationDraftId(), value: '' });

    expect(getFilesDraft(getNewConversationDraftId()).tabId).toBe(getBrowserTabId());
  });

  it('takes a text-only claim from another tab, whose text it is overwriting anyway', () => {
    /** The shared text record has no per-tab copy: once this tab writes, its text is the only
     * text there is, so a stamp left with the other tab would stop it restoring its own draft. */
    markTabLive('other-tab');
    localStorage.setItem(
      `${LocalStorageKeys.FILES_DRAFT}${getNewConversationDraftId()}`,
      JSON.stringify({ fileIds: [], tabId: 'other-tab' }),
    );

    setDraft({ id: getNewConversationDraftId(), value: 'text from this tab' });

    expect(getFilesDraft(getNewConversationDraftId()).tabId).toBe(getBrowserTabId());
  });

  it('leaves a claim backed by an attachment with the tab that still has it', () => {
    markTabLive('other-tab');
    setFilesDraft(getNewConversationDraftId(), {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });

    setDraft({ id: getNewConversationDraftId(), value: 'text from this tab' });

    expect(getFilesDraft(getNewConversationDraftId()).tabId).toBe('other-tab');
  });

  it('does not overwrite the text of a tab whose attachment claim it could not take', () => {
    /** This tab could not restore what it wrote anyway, so writing would destroy the other
     * tab's text for nothing. */
    markTabLive('other-tab');
    setFilesDraft(getNewConversationDraftId(), {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });
    localStorage.setItem(
      `${LocalStorageKeys.TEXT_DRAFT}${getNewConversationDraftId()}`,
      encodeBase64('text the other tab is still writing'),
    );

    setDraft({ id: getNewConversationDraftId(), value: 'text from this tab' });

    expect(getDraft(getNewConversationDraftId())).toBe('text the other tab is still writing');
  });

  it('refuses to overwrite a conversation draft another tab holds with attachments', () => {
    /** A conversation key is reachable from every tab viewing that chat and is stamped the same
     * way, so the text guard cannot be limited to the shared composer keys. */
    markTabLive('other-tab');
    setFilesDraft('convo-1', {
      fileIds: ['other-tab-file'],
      pendingPastes: {},
      tabId: 'other-tab',
    });
    localStorage.setItem(
      `${LocalStorageKeys.TEXT_DRAFT}convo-1`,
      encodeBase64('text the other tab is still writing'),
    );

    setDraft({ id: 'convo-1', value: 'text from this tab' });

    expect(getDraft('convo-1')).toBe('text the other tab is still writing');
  });

  it('does not claim a conversation key, which tabs are meant to share', () => {
    setDraft({ id: 'convo-1', value: 'shared conversation text' });

    expect(getFilesDraft('convo-1').tabId).toBeUndefined();
  });

  it('refuses to clear a shared key another live tab holds with text alone', () => {
    /** `claimComposerDraftTab` stamps a key that holds nothing but text, and the attachment-backed
     * guard ignored that: tab A finishing a run that began as an unsaved chat cleared the shared
     * new-chat key and took tab B's half-written message with it. Overwriting that text is still a
     * normal race between panes; destroying the record is not. Written the way that claim is,
     * since `setFilesDraft` drops a record with nothing attached rather than leaving a stub. */
    markTabLive('other-tab');
    localStorage.setItem(
      `${LocalStorageKeys.FILES_DRAFT}${Constants.NEW_CONVO}`,
      JSON.stringify({ fileIds: [], tabId: 'other-tab' }),
    );
    localStorage.setItem(
      `${LocalStorageKeys.TEXT_DRAFT}${Constants.NEW_CONVO}`,
      encodeBase64('text the other tab is still writing'),
    );

    clearAllDrafts(Constants.NEW_CONVO);

    expect(getDraft(Constants.NEW_CONVO)).toBe('text the other tab is still writing');
  });

  it('keeps the original tab owner when another tab rewrites the same record', () => {
    setFilesDraft(Constants.NEW_CONVO, { fileIds: ['file-1'], pendingPastes: {} });
    const stamped = getFilesDraft(Constants.NEW_CONVO).tabId;

    sessionStorage.clear();
    setFilesDraft(Constants.NEW_CONVO, { fileIds: ['file-1'], pendingPastes: {} });

    expect(getFilesDraft(Constants.NEW_CONVO).tabId).toBe(stamped);
  });
});

describe('clearFilesDraft', () => {
  const newChatKey = getNewConversationDraftId();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('discards the attachments and keeps the text', () => {
    setDraft({ id: newChatKey, value: 'half-written message' });
    setFilesDraft(newChatKey, { fileIds: ['file-1'], pendingPastes: {} });

    clearFilesDraft(newChatKey);

    expect(getFilesDraft(newChatKey).fileIds).toEqual([]);
    expect(getDraft(newChatKey)).toBe('half-written message');
  });

  it('keeps this tab claim on the text it left behind', () => {
    /** `setFilesDraft` drops the whole record once nothing is attached, and that record is the
     * only ownership stamp the shared text draft has: without it another tab's New Chat would be
     * free to clear text this tab is still holding. */
    setDraft({ id: newChatKey, value: 'half-written message' });
    setFilesDraft(newChatKey, { fileIds: ['file-1'], pendingPastes: {} });

    clearFilesDraft(newChatKey);

    expect(getFilesDraft(newChatKey).tabId).toBe(getBrowserTabId());
  });

  /** The reset empties the file map, and `useAutoSave`'s attachment effect then writes the draft
   * with nothing in it. That write used to delete the record this helper had just re-stamped, so
   * the preserved text sat unowned until the next keystroke and another live tab finishing a
   * new-chat run could clear it as though nobody were holding it. */
  it('keeps the claim through the empty-map write the reset triggers', () => {
    setDraft({ id: newChatKey, value: 'half-written message' });
    setFilesDraft(newChatKey, { fileIds: ['file-1'], pendingPastes: {} });

    clearFilesDraft(newChatKey);
    /** What the attachment effect writes once the composer's file map is empty. */
    setFilesDraft(newChatKey, { fileIds: [], pastedTextIds: [], pendingPastes: {} });

    expect(getFilesDraft(newChatKey).tabId).toBe(getBrowserTabId());
    expect(getDraft(newChatKey)).toBe('half-written message');
  });

  it('leaves no claim behind when there was no text to hold', () => {
    setFilesDraft(newChatKey, { fileIds: ['file-1'], pendingPastes: {} });

    clearFilesDraft(newChatKey);

    expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}${newChatKey}`)).toBeNull();
  });

  it('refuses a record another live tab owns', () => {
    markTabLive('other-tab');
    localStorage.setItem(
      `${LocalStorageKeys.FILES_DRAFT}${newChatKey}`,
      JSON.stringify({ fileIds: ['other-tab-file'], tabId: 'other-tab' }),
    );

    clearFilesDraft(newChatKey);

    expect(getFilesDraft(newChatKey).fileIds).toEqual(['other-tab-file']);
  });
});

describe('migrateFilesDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('moves the record to the destination key', () => {
    setFilesDraft('pending', {
      fileIds: ['file-1'],
      pendingPastes: { 'file-1': { text: 'pasted', selectionStart: 0 } },
    });

    expect(migrateFilesDraft('pending', 'convo-1')).toBe('convo-1');
    expect(getFilesDraft('convo-1').pendingPastes['file-1']?.text).toBe('pasted');
    expect(getFilesDraft('pending')).toEqual({ fileIds: [], pendingPastes: {} });
  });

  it('never holds the record under both keys at once', () => {
    setFilesDraft('pending', { fileIds: ['file-1'], pendingPastes: {} });
    const realSetItem = Storage.prototype.setItem;
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === `${LocalStorageKeys.FILES_DRAFT}convo-1`) {
        expect(localStorage.getItem(`${LocalStorageKeys.FILES_DRAFT}pending`)).toBeNull();
      }
      realSetItem.call(this, key, value);
    });

    expect(migrateFilesDraft('pending', 'convo-1')).toBe('convo-1');
    setItem.mockRestore();
  });

  it('leaves the record where it was when the destination write fails', () => {
    setFilesDraft('pending', {
      fileIds: ['file-1'],
      pendingPastes: { 'file-1': { text: 'pasted', selectionStart: 0 } },
    });
    const realSetItem = Storage.prototype.setItem;
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === `${LocalStorageKeys.FILES_DRAFT}convo-1`) {
        throw new Error('quota exceeded');
      }
      realSetItem.call(this, key, value);
    });

    expect(migrateFilesDraft('pending', 'convo-1')).toBe('pending');
    setItem.mockRestore();
    expect(getFilesDraft('pending').pendingPastes['file-1']?.text).toBe('pasted');
    expect(getFilesDraft('convo-1')).toEqual({ fileIds: [], pendingPastes: {} });
  });

  it('reports the destination when there is nothing to move', () => {
    expect(migrateFilesDraft('pending', 'convo-1')).toBe('convo-1');
  });
});

describe('migrateTextDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('moves the draft and reports that it did', () => {
    setDraft({ id: 'pending', value: 'carried over' });

    expect(migrateTextDraft('pending', 'convo-1')).toBe(true);
    expect(getDraft('convo-1')).toBe('carried over');
    expect(getDraft('pending')).toBe('');
  });

  it('reports nothing moved when the source is empty', () => {
    expect(migrateTextDraft('pending', 'convo-1')).toBe(false);
    expect(getDraft('convo-1')).toBe('');
  });
});

describe('setDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each(['x', '字', ' ', '\n', '🙂', 'line one\nline two'])(
    'preserves the exact draft %j',
    (value) => {
      setDraft({ id: 'convo-1', value });
      expect(getDraft('convo-1')).toBe(value);
    },
  );

  it('clears a draft only when its value is empty', () => {
    setDraft({ id: 'convo-1', value: 'x' });
    setDraft({ id: 'convo-1', value: '' });
    expect(getDraft('convo-1')).toBe('');
  });

  it('does not throw when localStorage.setItem fails', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => setDraft({ id: 'convo-1', value: 'draft text' })).not.toThrow();
    setItem.mockRestore();
  });

  it('returns empty drafts when localStorage.getItem throws', () => {
    setDraft({ id: 'convo-1', value: 'draft text' });
    setFilesDraft('convo-1', {
      fileIds: ['file-1'],
      pendingPastes: { 'file-1': { text: 'paste', selectionStart: 0 } },
    });
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(getFilesDraft('convo-1')).toEqual({ fileIds: [], pendingPastes: {} });
    expect(getDraft('convo-1')).toBe('');
    getItem.mockRestore();
  });
});

describe('resolvePendingPasteInsertStart', () => {
  it('moves the caret when text is prepended before the original snapshot', () => {
    expect(
      resolvePendingPasteInsertStart('Xhello', {
        text: 'PASTE',
        selectionStart: 5,
        anchorBefore: 'hello',
        anchorAfter: '',
      }),
    ).toBe(6);
  });

  it('finds the original junction when both sides of the caret were edited', () => {
    expect(
      resolvePendingPasteInsertStart('XhelloWORLDY', {
        text: 'PASTE',
        selectionStart: 5,
        anchorBefore: 'hello',
        anchorAfter: 'WORLD',
      }),
    ).toBe(6);
  });

  it('picks the junction the anchors still meet at when an edit duplicates the prefix', () => {
    expect(
      resolvePendingPasteInsertStart('aabc', {
        text: 'PASTE',
        selectionStart: 1,
        anchorBefore: 'a',
        anchorAfter: 'bc',
      }),
    ).toBe(2);
  });

  it('keeps the duplicated prefix junction when the tail was edited too', () => {
    expect(
      resolvePendingPasteInsertStart('aabcX', {
        text: 'PASTE',
        selectionStart: 1,
        anchorBefore: 'a',
        anchorAfter: 'bc',
      }),
    ).toBe(2);
  });

  it('holds the captured caret when a duplicated prefix leaves the junction ambiguous', () => {
    expect(
      resolvePendingPasteInsertStart('helloXhello', {
        text: 'PASTE',
        selectionStart: 5,
        anchorBefore: 'hello',
        anchorAfter: '',
      }),
    ).toBe(5);
  });

  it('holds the captured caret when the suffix is appended to itself', () => {
    expect(
      resolvePendingPasteInsertStart('abcabc', {
        text: 'PASTE',
        selectionStart: 0,
        anchorBefore: '',
        anchorAfter: 'abc',
      }),
    ).toBe(0);
  });

  it('still trails a suffix the user edited out of recognition', () => {
    expect(
      resolvePendingPasteInsertStart('ZZWORLD', {
        text: 'PASTE',
        selectionStart: 5,
        anchorBefore: 'hello',
        anchorAfter: 'WORLD',
      }),
    ).toBe(2);
  });

  it('stays at the captured caret when an edit duplicates both anchors', () => {
    /** `abcabc` is what both prepending and appending `abc` to `abc` produce, so the junction
     * could be 1 or 4 and nothing in the saved state says which. The caret is the tiebreak. */
    expect(
      resolvePendingPasteInsertStart('abcabc', {
        text: 'PASTE',
        selectionStart: 1,
        anchorBefore: 'a',
        anchorAfter: 'bc',
      }),
    ).toBe(1);
  });

  it('falls back to the captured caret when both anchors were empty', () => {
    expect(
      resolvePendingPasteInsertStart('typed since', {
        text: 'PASTE',
        selectionStart: 0,
        anchorBefore: '',
        anchorAfter: '',
      }),
    ).toBe(0);
  });
});

describe('clearDraft navigation ordering', () => {
  beforeEach(() => {
    localStorage.clear();
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('cannot delete text written after returning to a cleared conversation', () => {
    setDraft({ id: 'chat-a', value: 'old draft' });
    clearDraft('chat-a');
    expect(getDraft('chat-a')).toBe('');
    setDraft({ id: 'chat-a', value: 'replacement draft' });
    jest.advanceTimersByTime(3000);
    expect(getDraft('chat-a')).toBe('replacement draft');
  });

  it('clears two different conversations without cancelling either deletion', () => {
    setDraft({ id: 'chat-a', value: 'alpha' });
    setDraft({ id: 'chat-b', value: 'beta' });
    clearDraft('chat-a');
    clearDraft('chat-b');
    jest.advanceTimersByTime(3000);
    expect(getDraft('chat-a')).toBe('');
    expect(getDraft('chat-b')).toBe('');
  });
});

describe('composer draft ownership', () => {
  it('releases only the registered pane scope and rejects another conversation', () => {
    const releaseOld = registerComposerDraft(4, 'origin', 'ask-answer:old');
    const releaseNew = registerComposerDraft(4, 'origin', 'ask-answer:new');
    releaseOld();
    expect(getActiveComposerDraftId(4, 'origin')).toBe('ask-answer:new');
    expect(getActiveComposerDraftId(4, 'other')).toBeNull();
    expect(getActiveComposerDraftId(5, 'origin')).toBeNull();
    releaseNew();
    expect(getActiveComposerDraftId(4, 'origin')).toBeNull();
  });

  it('coalesces actual local changes and stops notifying after unsubscription', async () => {
    localStorage.clear();
    await Promise.resolve();
    const changed = jest.fn();
    const unsubscribe = subscribeDraftOwnership('observed', changed);
    const draft = { fileIds: ['file'], pendingPastes: {} };
    setFilesDraft('unrelated', draft);
    setFilesDraft('observed', draft);
    setFilesDraft('observed', draft);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    setFilesDraft('observed', draft);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    clearFilesDraft('observed');
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('logical composer lifetime', () => {
  it('preserves pending storage migration but rejects a new host and answer scope', () => {
    const host = {};
    const leavePending = registerComposerDraft(7, 'chat', 'pending:7', host);
    const captured = captureComposerDraft(7, 'chat');
    leavePending();
    const leaveIdle = registerComposerDraft(7, 'chat', 'chat', host);
    expect(captured()).toBe(true);
    leaveIdle();
    const leaveAnswer = registerComposerDraft(7, 'chat', 'ask-answer:question', host);
    expect(captured()).toBe(false);
    leaveAnswer();
  });
  it('hands an acknowledged scope to a replacement host without accepting stale cleanup', () => {
    const releaseFirst = registerComposerDraft(9, Constants.NEW_CONVO, 'pending:9', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 9);
    const captured = captureComposerDraft(9, Constants.NEW_CONVO);
    expect(adoptComposerConversation(launch, 'assigned-chat', 9)).toBe(true);
    releaseFirst();
    const releaseReplacement = registerComposerDraft(9, 'assigned-chat', 'assigned-chat', {});
    releaseFirst();
    expect(captured()).toBe(true);
    expect(captured.conversationId()).toBe('assigned-chat');
    releaseReplacement();
    expect(captured()).toBe(false);
  });

  it('does not revive an acknowledged scope after genuine teardown', async () => {
    const release = registerComposerDraft(10, Constants.NEW_CONVO, 'pending:10', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 10);
    const captured = captureComposerDraft(10, Constants.NEW_CONVO);
    expect(adoptComposerConversation(launch, 'closed-chat', 10)).toBe(true);
    release();
    await Promise.resolve();
    const closeNewHost = registerComposerDraft(10, 'closed-chat', 'closed-chat', {});
    expect(captured()).toBe(false);
    closeNewHost();
  });

  it('does not treat a remount without acknowledgement as the same composer', () => {
    const release = registerComposerDraft(11, 'existing-chat', 'existing-chat', {});
    const captured = captureComposerDraft(11, 'existing-chat');
    release();
    const closeReplacement = registerComposerDraft(11, 'existing-chat', 'existing-chat', {});
    expect(captured()).toBe(false);
    closeReplacement();
  });

  it('keeps side-by-side new-chat choices from targeting an assigned pane', () => {
    const releaseAssigned = registerComposerDraft(12, Constants.NEW_CONVO, 'pending:12', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 12);
    const captured = captureComposerDraft(12, Constants.NEW_CONVO);
    expect(adoptComposerConversation(launch, 'assigned-pane', 12)).toBe(true);
    const releaseNew = registerComposerDraft(13, Constants.NEW_CONVO, 'new:13', {});
    expect(resolveComposerConversationId(Constants.NEW_CONVO)).toBe(Constants.NEW_CONVO);
    expect(captured()).toBe(true);
    expect(captured.conversationId()).toBe('assigned-pane');
    releaseNew();
    releaseAssigned();
  });

  it('rejects a stale acknowledgement after navigation before React commits', () => {
    window.history.replaceState({}, '', '/c/new?prompt=hello');
    const release = registerComposerDraft(14, Constants.NEW_CONVO, 'pending:14', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 14);
    window.history.pushState({}, '', '/c/unrelated');
    expect(adoptComposerConversation(launch, 'stale-id', 14)).toBe(false);
    release();
    window.history.replaceState({}, '', '/');
  });

  it('preserves the query when the server replaces the new-chat URL', () => {
    window.history.replaceState({}, '', '/c/new?prompt=hello');
    const release = registerComposerDraft(15, Constants.NEW_CONVO, 'pending:15', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 15);
    const captured = captureComposerDraft(15, Constants.NEW_CONVO);
    expect(adoptComposerConversation(launch, 'assigned-id', 15)).toBe(true);
    window.history.replaceState({}, '', '/c/assigned-id?prompt=hello');
    expect(captured()).toBe(true);
    release();
    window.history.replaceState({}, '', '/');
  });

  it('binds a new launch immediately after a same-route reset without reviving the old one', () => {
    const host = {};
    const release = registerComposerDraft(16, Constants.NEW_CONVO, 'new:16', host);
    const oldLaunch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(oldLaunch, 16);
    const oldOwner = captureComposerDraft(16, Constants.NEW_CONVO);
    renewNewConversationDraftToken(16);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 16);
    const owner = captureComposerDraft(16, Constants.NEW_CONVO);
    expect(oldOwner()).toBe(false);
    expect(adoptComposerConversation(oldLaunch, 'old-reset-chat', 16)).toBe(false);
    release();
    const releasePending = registerComposerDraft(16, Constants.NEW_CONVO, 'pending:16', host);
    expect(owner()).toBe(true);
    expect(adoptComposerConversation(launch, 'new-reset-chat', 16)).toBe(true);
    expect(owner.conversationId()).toBe('new-reset-chat');
    releasePending();
  });

  it('retires the refreshed registration on unmount and keeps sibling panes unchanged', async () => {
    const release = registerComposerDraft(17, Constants.NEW_CONVO, 'new:17', {});
    const releaseSibling = registerComposerDraft(18, Constants.NEW_CONVO, 'new:18', {});
    const sibling = captureComposerDraft(18, Constants.NEW_CONVO);
    renewNewConversationDraftToken(17);
    const owner = captureComposerDraft(17, Constants.NEW_CONVO);
    expect(owner()).toBe(true);
    expect(sibling()).toBe(true);
    release();
    expect(owner()).toBe(false);
    await Promise.resolve();
    expect(getActiveComposerDraftId(17, Constants.NEW_CONVO)).toBeNull();
    expect(sibling()).toBe(true);
    releaseSibling();
  });

  it('keeps captured upload ownership across consumed prompt parameters and acknowledgement', () => {
    window.history.replaceState({}, '', '/c/new?prompt=hello&submit=true&projectId=project');
    const release = registerComposerDraft(20, Constants.NEW_CONVO, 'pending:20', {});
    const captured = captureComposerDraft(20, Constants.NEW_CONVO);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 20);
    consumeComposerQuery(
      20,
      Constants.NEW_CONVO,
      '/c/new',
      'submit=true&projectId=project&prompt=hello',
      'projectId=project',
    );
    window.history.replaceState({}, '', '/c/new?projectId=project');
    expect(captured()).toBe(true);
    expect(adoptComposerConversation(launch, 'cleaned-chat', 20)).toBe(true);
    window.history.replaceState({}, '', '/c/cleaned-chat?projectId=project');
    expect(captured()).toBe(true);
    window.history.pushState({}, '', '/c/another-chat?projectId=project');
    expect(captured()).toBe(false);
    release();
    window.history.replaceState({}, '', '/');
  });

  it('preserves an acknowledged route when its consumed parameters are cleaned afterwards', () => {
    window.history.replaceState({}, '', '/c/new?prompt=hello');
    const release = registerComposerDraft(21, Constants.NEW_CONVO, 'pending:21', {});
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 21);
    const captured = captureComposerDraft(21, Constants.NEW_CONVO);
    expect(adoptComposerConversation(launch, 'assigned-cleanup', 21)).toBe(true);
    window.history.replaceState({}, '', '/c/assigned-cleanup?prompt=hello');
    consumeComposerQuery(21, 'assigned-cleanup', '/c/assigned-cleanup', 'prompt=hello', '');
    window.history.replaceState({}, '', '/c/assigned-cleanup');
    expect(captured()).toBe(true);
    expect(adoptComposerConversation(launch, 'assigned-cleanup', 21)).toBe(true);
    release();
    window.history.replaceState({}, '', '/');
  });

  it.each([
    { owner: 'new', path: '/c/new', from: 'prompt=hello&projectId=project', to: '' },
    { owner: 'new', path: '/c/new', from: 'prompt=hello&projectId=project', to: 'projectId=other' },
    {
      owner: 'other',
      path: '/c/new',
      from: 'prompt=hello&projectId=project',
      to: 'projectId=project',
    },
    {
      owner: 'new',
      path: '/c/new',
      from: 'prompt=hello&projectId=project',
      to: 'prompt=another&projectId=project',
    },
    {
      owner: 'new',
      path: '/c/unrelated',
      from: 'prompt=hello&projectId=project',
      to: 'projectId=project',
    },
  ])('does not treat a project, owner, prompt, or path change as consumption (%j)', (change) => {
    window.history.replaceState({}, '', '/c/new?prompt=hello&projectId=project');
    const release = registerComposerDraft(22, Constants.NEW_CONVO, 'pending:22', {});
    const captured = captureComposerDraft(22, Constants.NEW_CONVO);
    consumeComposerQuery(22, change.owner, change.path, change.from, change.to);
    window.history.replaceState({}, '', change.path + (change.to ? `?${change.to}` : ''));
    expect(captured()).toBe(false);
    release();
    window.history.replaceState({}, '', '/');
  });

  it('retires the old scope when the same host is registered on a changed project route', () => {
    window.history.replaceState({}, '', '/c/new?projectId=project-a');
    const host = {};
    const releaseOld = registerComposerDraft(23, Constants.NEW_CONVO, 'new:23', host);
    const oldOwner = captureComposerDraft(23, Constants.NEW_CONVO);
    const oldLaunch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(oldLaunch, 23);
    window.history.replaceState({}, '', '/c/new?projectId=project-b');
    releaseOld();
    const releaseNew = registerComposerDraft(23, Constants.NEW_CONVO, 'new:23', host);
    const owner = captureComposerDraft(23, Constants.NEW_CONVO);
    expect(oldOwner()).toBe(false);
    expect(owner()).toBe(true);
    expect(adoptComposerConversation(oldLaunch, 'wrong-project', 23)).toBe(false);
    releaseNew();
    window.history.replaceState({}, '', '/');
  });

  it('reuses registered ownership after passive query cleanup and acknowledged route adoption', () => {
    window.history.replaceState({}, '', '/c/new?prompt=hello&projectId=project');
    const host = {};
    const release = registerComposerDraft(24, Constants.NEW_CONVO, 'new:24', host);
    const owner = captureComposerDraft(24, Constants.NEW_CONVO);
    consumeComposerQuery(
      24,
      Constants.NEW_CONVO,
      '/c/new',
      'prompt=hello&projectId=project',
      'projectId=project',
    );
    window.history.replaceState({}, '', '/c/new?projectId=project');
    release();
    const releaseCleaned = registerComposerDraft(24, Constants.NEW_CONVO, 'pending:24', host);
    expect(owner()).toBe(true);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 24);
    expect(adoptComposerConversation(launch, 'assigned-project', 24)).toBe(true);
    window.history.replaceState({}, '', '/c/assigned-project?projectId=project');
    releaseCleaned();
    const releaseAssigned = registerComposerDraft(24, 'assigned-project', 'assigned-project', host);
    expect(owner()).toBe(true);
    expect(owner.conversationId()).toBe('assigned-project');
    releaseAssigned();
    window.history.replaceState({}, '', '/');
  });

  it('keeps the acknowledged owner while its source prop catches up after the URL', () => {
    window.history.replaceState({}, '', '/c/new?projectId=project');
    const host = {};
    const releaseSource = registerComposerDraft(25, Constants.NEW_CONVO, 'pending:25', host);
    const captured = captureComposerDraft(25, Constants.NEW_CONVO);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 25);
    expect(adoptComposerConversation(launch, 'acknowledged-url', 25)).toBe(true);
    window.history.replaceState({}, '', '/c/acknowledged-url?projectId=project');
    releaseSource();
    const releaseLagging = registerComposerDraft(25, Constants.NEW_CONVO, 'pending:25', host);
    expect(captured()).toBe(true);
    expect(captured.conversationId()).toBe('acknowledged-url');
    expect(adoptComposerConversation(launch, 'acknowledged-url', 25)).toBe(true);
    releaseLagging();
    const releaseSaved = registerComposerDraft(25, 'acknowledged-url', 'acknowledged-url', host);
    expect(captured()).toBe(true);
    window.history.replaceState({}, '', '/c/acknowledged-url?projectId=other');
    releaseSaved();
    const releaseOther = registerComposerDraft(25, 'acknowledged-url', 'acknowledged-url', host);
    expect(captured()).toBe(false);
    releaseOther();
    window.history.replaceState({}, '', '/');
  });

  it('does not reuse the source alias after the saved conversation prop has arrived', () => {
    window.history.replaceState({}, '', '/c/new');
    const host = {};
    const releaseSource = registerComposerDraft(29, Constants.NEW_CONVO, 'pending:29', host);
    const owner = captureComposerDraft(29, Constants.NEW_CONVO);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 29);
    expect(adoptComposerConversation(launch, 'saved-before-back', 29)).toBe(true);
    window.history.replaceState({}, '', '/c/saved-before-back');
    releaseSource();
    const releaseSaved = registerComposerDraft(29, 'saved-before-back', 'saved-before-back', host);
    expect(owner()).toBe(true);
    window.history.pushState({}, '', '/c/new');
    releaseSaved();
    const releaseReturned = registerComposerDraft(29, Constants.NEW_CONVO, 'new:29', host);
    expect(owner()).toBe(false);
    expect(captureComposerDraft(29, Constants.NEW_CONVO)()).toBe(true);
    expect(adoptComposerConversation(launch, 'saved-before-back', 29)).toBe(false);
    releaseReturned();
    window.history.replaceState({}, '', '/');
  });

  it('permits origin recovery only when an owned saved draft still references the file', () => {
    const release = registerComposerDraft(26, 'saved-owner', 'saved-owner', {});
    const captured = captureComposerDraft(26, 'saved-owner');
    setFilesDraft('saved-owner', { fileIds: ['kept-file'], pendingPastes: {} });
    release();
    expect(captured()).toBe(false);
    expect(captured.retainsFile('kept-file')).toBe(true);
    expect(captured.retainsFile('absent-file')).toBe(false);
    clearFilesDraft('saved-owner');
    expect(captured.retainsFile('kept-file')).toBe(false);
  });

  it.each(['owned', 'blocked', 'unrelated', 'foreign', 'unsubscribed'])(
    'follows a retained pending upload only through its owned migration (%s)',
    async (mode) => {
      const conversationId = 'retained-migration';
      const pendingId = getPendingDraftId(42);
      const release = registerComposerDraft(42, conversationId, pendingId, {});
      const captured = captureComposerDraft(42, conversationId);
      const unsubscribe = captured.onAssignment(jest.fn());
      if (mode === 'foreign') markTabLive('foreign-migration-owner');
      setFilesDraft(pendingId, {
        fileIds: ['migrating-upload'],
        pendingPastes: {},
        ...(mode === 'foreign' ? { tabId: 'foreign-migration-owner' } : {}),
      });
      release();
      await Promise.resolve();
      if (mode === 'unsubscribed') unsubscribe();
      const setItem = Storage.prototype.setItem;
      const blocked =
        mode === 'blocked'
          ? jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
              this: Storage,
              key: string,
              value: string,
            ) {
              if (key === `${LocalStorageKeys.FILES_DRAFT}${conversationId}`) {
                throw new Error('Migration destination unavailable');
              }
              setItem.call(this, key, value);
            })
          : undefined;
      try {
        const destination = mode === 'unrelated' ? 'unrelated-migration' : conversationId;
        expect(migrateFilesDraft(pendingId, destination)).toBe(
          mode === 'blocked' ? pendingId : destination,
        );
        expect(captured()).toBe(false);
        expect(captured.retainsFile('migrating-upload')).toBe(
          mode === 'owned' || mode === 'blocked',
        );
        if (mode === 'owned') {
          captured.discardFile('migrating-upload');
          expect(getFilesDraft(conversationId).fileIds).toEqual([]);
        }
      } finally {
        blocked?.mockRestore();
        unsubscribe();
      }
    },
  );

  it('never treats a shared new-chat draft as a retained retired project', () => {
    const release = registerComposerDraft(27, Constants.NEW_CONVO, 'new:27', {});
    const captured = captureComposerDraft(27, Constants.NEW_CONVO);
    setFilesDraft('new:27', { fileIds: ['old-project-file'], pendingPastes: {} });
    release();
    expect(captured()).toBe(false);
    expect(captured.retainsFile('old-project-file')).toBe(false);
    clearFilesDraft('new:27');
  });

  it.each(['url-first', 'props-first'])(
    'retires the source URL after both parts of the handoff arrive (%s)',
    (order) => {
      window.history.replaceState({}, '', '/c/new?projectId=history-project');
      const host = {};
      const release = registerComposerDraft(30, Constants.NEW_CONVO, 'pending:30', host);
      const owner = captureComposerDraft(30, Constants.NEW_CONVO);
      const launch = { conversationId: Constants.NEW_CONVO };
      bindComposerLaunch(launch, 30);
      expect(adoptComposerConversation(launch, 'saved-terminal-route', 30)).toBe(true);
      if (order === 'url-first') {
        window.history.replaceState({}, '', '/c/saved-terminal-route?projectId=history-project');
        expect(owner()).toBe(true);
      }
      release();
      const releaseSaved = registerComposerDraft(
        30,
        'saved-terminal-route',
        'saved-terminal-route',
        host,
      );
      expect(owner()).toBe(true);
      window.history.replaceState({}, '', '/c/saved-terminal-route?projectId=history-project');
      expect(owner()).toBe(true);
      window.history.pushState({}, '', '/c/new?projectId=history-project');
      expect(owner()).toBe(false);
      expect(adoptComposerConversation(launch, 'saved-terminal-route', 30)).toBe(false);
      releaseSaved();
      window.history.replaceState({}, '', '/');
    },
  );

  it('discards a retired upload only from its pane and leaves fresh attachments intact', () => {
    const release = registerComposerDraft(35, Constants.NEW_CONVO, 'pending:35', {});
    const owner = captureComposerDraft(35, Constants.NEW_CONVO);
    for (const id of ['new:35', 'pending:35', 'new:36', 'saved-unrelated']) {
      setFilesDraft(id, { fileIds: ['retired-upload', 'fresh-file'], pendingPastes: {} });
    }
    renewNewConversationDraftToken(35);
    owner.discardFile('retired-upload');
    expect(getFilesDraft('new:35').fileIds).toEqual(['fresh-file']);
    expect(getFilesDraft('pending:35').fileIds).toEqual(['fresh-file']);
    expect(getFilesDraft('new:36').fileIds).toEqual(['retired-upload', 'fresh-file']);
    expect(getFilesDraft('saved-unrelated').fileIds).toEqual(['retired-upload', 'fresh-file']);
    release();
  });

  it("never prunes a retired upload from another live tab's draft", () => {
    const release = registerComposerDraft(37, Constants.NEW_CONVO, 'new:37', {});
    const owner = captureComposerDraft(37, Constants.NEW_CONVO);
    markTabLive('foreign-retained-upload');
    setFilesDraft('new:37', {
      fileIds: ['foreign-file'],
      pendingPastes: {},
      tabId: 'foreign-retained-upload',
    });
    renewNewConversationDraftToken(37);
    owner.discardFile('foreign-file');
    expect(getFilesDraft('new:37').fileIds).toEqual(['foreign-file']);
    expect(getFilesDraft('new:37').tabId).toBe('foreign-retained-upload');
    release();
  });

  it('notifies the identity assignment once while validating replays and later launches', () => {
    window.history.replaceState({}, '', '/c/new');
    const host = {};
    const release = registerComposerDraft(39, Constants.NEW_CONVO, 'new:39', host);
    const launch = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(launch, 39);
    const assigned = jest.fn();
    expect(adoptComposerConversation(launch, 'once-assigned', 39, assigned)).toBe(true);
    expect(assigned).toHaveBeenCalledWith(Constants.NEW_CONVO, 'once-assigned');
    expect(adoptComposerConversation(launch, 'once-assigned', 39, assigned)).toBe(true);
    window.history.replaceState({}, '', '/c/once-assigned');
    release();
    const releaseSaved = registerComposerDraft(39, 'once-assigned', 'once-assigned', host);
    const nextLaunch = { conversationId: 'once-assigned' };
    bindComposerLaunch(nextLaunch, 39);
    expect(adoptComposerConversation(nextLaunch, 'once-assigned', 39, assigned)).toBe(true);
    expect(assigned).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, '', '/c/unrelated');
    expect(adoptComposerConversation(nextLaunch, 'once-assigned', 39, assigned)).toBe(false);
    expect(assigned).toHaveBeenCalledTimes(1);
    releaseSaved();
    window.history.replaceState({}, '', '/');
  });

  it('keeps reset revisions pane-local and stable until an explicit reset', () => {
    const first = getNewConversationDraftRevision(31);
    expect(getNewConversationDraftRevision(31)).toBe(first);
    const sibling = getNewConversationDraftRevision(32);
    renewNewConversationDraftToken(31);
    expect(getNewConversationDraftRevision(31)).not.toBe(first);
    expect(getNewConversationDraftRevision(32)).toBe(sibling);
  });

  it('does not trust an old reset revision when session storage is read-only on reload', () => {
    const revision = getNewConversationDraftRevision(33);
    const setItem = Storage.prototype.setItem;
    const blocked = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'librechat-new-composer:33') throw new Error('Session revision unavailable');
      setItem.call(this, key, value);
    });
    const navigation = Object.getOwnPropertyDescriptor(performance, 'getEntriesByType');
    Object.defineProperty(performance, 'getEntriesByType', {
      configurable: true,
      value: () => [{ type: 'reload' }],
    });
    try {
      renewNewConversationDraftToken(33);
      expect(getNewConversationDraftRevision(33)).not.toBe(revision);
      jest.isolateModules(() => {
        const reloaded = jest.requireActual<typeof import('./drafts')>('./drafts');
        expect(reloaded.getNewConversationDraftRevision(33)).not.toBe(revision);
      });
    } finally {
      blocked.mockRestore();
      if (navigation) Object.defineProperty(performance, 'getEntriesByType', navigation);
      else Reflect.deleteProperty(performance, 'getEntriesByType');
    }
  });

  it('rejects an acknowledgement from a launch superseded by New Chat', () => {
    const release = registerComposerDraft(8, Constants.NEW_CONVO, 'pending:8', {});
    const submissionConversation = { conversationId: Constants.NEW_CONVO };
    bindComposerLaunch(submissionConversation, 8);
    renewNewConversationDraftToken(8);
    expect(adoptComposerConversation(submissionConversation, 'server-id', 8)).toBe(false);
    release();
  });
});
