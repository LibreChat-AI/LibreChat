import { createStore } from 'jotai';
import type { TConversation } from 'librechat-data-provider';
import { sideChatAtom, sideChatDraftFamily, sideChatDraftTakenAtom } from '../state';

const conversation = { conversationId: 'destination' } as TConversation;

it('owns the question synchronously before a loading panel mounts, and retains it after close', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'My question.' });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My question.');
  store.set(sideChatAtom, null);
  store.set(sideChatAtom, { conversation });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('My question.');
  expect(store.get(sideChatAtom)?.text).toBeUndefined();
});

it('keeps each destination draft isolated when switching while loading', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'First.' });
  store.set(sideChatAtom, {
    conversation: { ...conversation, conversationId: 'other' },
    text: 'Second.',
  });
  expect(store.get(sideChatDraftFamily('destination'))).toBe('First.');
  expect(store.get(sideChatDraftFamily('other'))).toBe('Second.');
  expect(createStore().get(sideChatDraftFamily('destination'))).toBe('');
});

it.each(['Existing words.', 'New question.'])(
  'does not overwrite or automatically send an existing draft: %s',
  (draft) => {
    const store = createStore();
    store.set(sideChatDraftFamily('destination'), draft);
    store.set(sideChatAtom, { conversation, text: 'New question.' });
    expect(store.get(sideChatDraftFamily('destination'))).toBe(draft);
    expect(store.get(sideChatAtom)?.text).toBeUndefined();
  },
);

it.each(['Edited words.', ''])(
  'does not reseed edits or clearing during metadata refinement: %s',
  (draft) => {
    const store = createStore();
    store.set(sideChatAtom, { conversation, text: 'Original.' });
    store.set(sideChatDraftFamily('destination'), draft);
    store.set(
      sideChatAtom,
      (current) => current && { ...current, conversation: { ...conversation, title: 'Loaded' } },
    );
    expect(store.get(sideChatDraftFamily('destination'))).toBe(draft);
  },
);

it('does not seed an empty-id draft for an invalid destination', () => {
  const store = createStore();
  store.set(sideChatAtom, {
    conversation: { conversationId: '' } as TConversation,
    text: 'Orphan',
  });
  expect(store.get(sideChatDraftFamily(''))).toBe('');
});

it('does not clear newer edits when captured words are taken', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'Sent.' });
  const expected = store.get(sideChatAtom)!;
  store.set(sideChatDraftFamily('destination'), 'Edited.');
  store.set(sideChatDraftTakenAtom, expected, 'Sent.');
  expect(store.get(sideChatDraftFamily('destination'))).toBe('Edited.');
  expect(store.get(sideChatAtom)).toBe(expected);
});

it('does not retire a replacement owner even with the same conversation and words', () => {
  const store = createStore();
  store.set(sideChatAtom, { conversation, text: 'Same.' });
  const expected = store.get(sideChatAtom)!;
  store.set(sideChatDraftFamily('destination'), '');
  store.set(sideChatAtom, { conversation, text: 'Same.' });
  const replacement = store.get(sideChatAtom);
  store.set(sideChatDraftTakenAtom, expected, 'Same.');
  expect(store.get(sideChatAtom)).toBe(replacement);
  expect(store.get(sideChatDraftFamily('destination'))).toBe('Same.');
});
