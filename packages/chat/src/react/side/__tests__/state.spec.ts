import { createStore } from 'jotai';
import type { TConversation } from 'librechat-data-provider';
import { sideChatAtom, sideChatDraftFamily, sideChatRequestAtom } from '../state';

const conversation = { conversationId: 'destination' } as TConversation;

it('seeds a handoff synchronously and preserves it across close and ordinary reopen', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'My question.' });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My question.');
  store.set(sideChatAtom, null);
  store.set(sideChatAtom, { conversation });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My question.');
  expect(store.get(sideChatAtom)?.text).toBeUndefined();
});

it.each(['An existing draft.', ''])(
  'does not reseed an edited or cleared draft during functional refinement: %s',
  (draft) => {
    const store = createStore();
    store.set(sideChatAtom, { conversation, text: 'Original handoff.' });
    store.set(sideChatDraftFamily('destination'), draft);
    store.set(
      sideChatAtom,
      (current) =>
        current && { ...current, conversation: { ...conversation, title: 'Loaded title' } },
    );
    expect(store.get(sideChatDraftFamily('destination'))).toBe(draft);
    store.set(sideChatAtom, (current) => current && { conversation: current.conversation });
    expect(store.get(sideChatDraftFamily('destination'))).toBe(draft);
  },
);

it('preserves an existing draft when another handoff opens the same conversation', () => {
  const store = createStore();
  store.set(sideChatDraftFamily('destination'), 'My existing words.');
  store.set(sideChatAtom, { conversation, text: 'New handoff.' });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My existing words.');
});

it('separates destinations, withdraws stale open requests, and keeps drafts in memory only', () => {
  const store = createStore();
  const request = {};
  store.set(sideChatRequestAtom, request);
  store.set(sideChatAtom, { conversation, text: 'First.' });
  expect(store.get(sideChatRequestAtom)).toBeNull();
  store.set(sideChatAtom, {
    conversation: { conversationId: 'other' } as TConversation,
    text: 'Second.',
  });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('First.');
  expect(store.get(sideChatDraftFamily('other'))).toBe('Second.');
  expect(createStore().get(sideChatDraftFamily('destination'))).toBe('');
});

it('does not seed a shared empty-id draft for an invalid destination', () => {
  const store = createStore();
  store.set(sideChatAtom, {
    conversation: { conversationId: '' } as TConversation,
    text: 'Not a destination.',
  });
  expect(store.get(sideChatDraftFamily(''))).toBe('');
});

it.each(['Same words.', 'Different draft.'])(
  'suppresses new handoff intent whenever an existing draft wins: %s',
  (draft) => {
    const store = createStore();
    store.set(sideChatDraftFamily('destination'), draft);
    store.set(sideChatAtom, { conversation, text: 'Same words.' });
    expect(store.get(sideChatDraftFamily('destination'))).toBe(draft);
    expect(store.get(sideChatAtom)?.text).toBeUndefined();
  },
);

it('distinguishes same-ID/text functional refinement from a genuine new direct opening', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'My question.' });
  store.set(
    sideChatAtom,
    (current) =>
      current && { ...current, conversation: { ...current.conversation, title: 'Loaded' } },
  );
  expect(store.get(sideChatAtom)?.text).toBe('My question.');
  const current = store.get(sideChatAtom);
  store.set(sideChatAtom, current);
  expect(store.get(sideChatAtom)).toBe(current);
  store.set(sideChatAtom, { conversation, text: 'My question.' });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My question.');
  expect(store.get(sideChatAtom)?.text).toBeUndefined();
});

it('normalizes a functional destination change while preserving both drafts', () => {
  const store = createStore();
  store.set(sideChatDraftFamily('other'), 'Owned draft.');
  store.set(sideChatAtom, { conversation, text: 'Original.' });
  store.set(sideChatAtom, () => ({
    conversation: { ...conversation, conversationId: 'other' },
    text: 'Owned draft.',
  }));
  expect(store.get(sideChatDraftFamily('destination'))).toBe('Original.');
  expect(store.get(sideChatDraftFamily('other'))).toBe('Owned draft.');
  expect(store.get(sideChatAtom)?.text).toBeUndefined();
});
