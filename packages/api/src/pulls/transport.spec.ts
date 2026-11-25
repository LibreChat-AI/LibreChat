import type { Dispatcher } from 'undici';
import { createProxyAwareFetch } from './transport';

const dispatcher = { name: 'proxy' } as unknown as Dispatcher;
type Fetch = typeof globalThis.fetch;
const recordingFetch = () => {
  const calls: Array<[unknown, RequestInit | undefined]> = [];
  const fetchFn = Object.assign(
    async (input: unknown, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response('{}');
    },
    { preconnect: () => undefined },
  ) as unknown as Fetch;
  return { fetchFn, calls };
};

describe('createProxyAwareFetch', () => {
  it('sends the request through the proxy dispatcher when one is configured', async () => {
    const { fetchFn, calls } = recordingFetch();
    const signal = new AbortController().signal;
    await createProxyAwareFetch(fetchFn, () => dispatcher)('https://api.github.com/x', {
      headers: { a: 'b' },
      signal,
    });
    expect(calls).toEqual([
      ['https://api.github.com/x', { headers: { a: 'b' }, signal, dispatcher }],
    ]);
  });

  it('goes direct, with the request untouched, when no proxy is configured', async () => {
    const { fetchFn, calls } = recordingFetch();
    const init = { headers: { a: 'b' } };
    await createProxyAwareFetch(fetchFn, () => undefined)('https://api.github.com/x', init);
    expect(calls).toEqual([['https://api.github.com/x', init]]);
    expect((calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it('resolves the dispatcher for each request', async () => {
    const { fetchFn, calls } = recordingFetch();
    const getDispatcher = jest.fn<Dispatcher | undefined, []>().mockReturnValue(undefined);
    const wrapped = createProxyAwareFetch(fetchFn, getDispatcher);
    await wrapped('https://api.github.com/a');
    getDispatcher.mockReturnValue(dispatcher);
    await wrapped('https://api.github.com/b');
    expect(calls[1][1]).toMatchObject({ dispatcher });
    expect((calls[0][1] as { dispatcher?: unknown } | undefined)?.dispatcher).toBeUndefined();
  });
});
