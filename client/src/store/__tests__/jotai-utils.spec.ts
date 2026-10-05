import { z } from 'zod';
import { createStore } from 'jotai';
import { RESET } from 'jotai/utils';
import { createSessionAtom } from '../jotai-utils';

beforeEach(() => sessionStorage.clear());
afterEach(() => jest.restoreAllMocks());

test('validates stored state and resets the persisted draft', () => {
  sessionStorage.setItem('draft', JSON.stringify({ prompt: 'restored' }));
  const draft = createSessionAtom('draft', { prompt: '' }, z.object({ prompt: z.string() }));
  const store = createStore();
  expect(store.get(draft)).toEqual({ prompt: 'restored' });
  store.set(draft, RESET);
  expect(store.get(draft)).toEqual({ prompt: '' });
  expect(sessionStorage.getItem('draft')).toBeNull();
  sessionStorage.setItem('invalid', JSON.stringify({ prompt: 42 }));
  expect(
    store.get(createSessionAtom('invalid', { prompt: '' }, z.object({ prompt: z.string() }))),
  ).toEqual({ prompt: '' });
});

test('keeps edits when storage fails and the atom later mounts', () => {
  const draft = createSessionAtom('draft', '', z.string());
  const store = createStore();
  jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  store.set(draft, 'in memory');
  const unmount = store.sub(draft, () => {});
  expect(store.get(draft)).toBe('in memory');
  store.set(draft, (value) => value + ' too');
  expect(store.get(draft)).toBe('in memory too');
  unmount();
});
