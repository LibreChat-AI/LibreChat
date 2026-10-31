import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { request, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useResponseReviewDecision, useResponseCancel } from '../queries';

const decision = { actionId: 'action', answer: 'staging' };
const receipt = {
  responseId: 'response/test',
  actionId: 'action',
  intentId: 'intent',
  status: 'queued',
};
let post: jest.SpyInstance;
beforeEach(() => {
  post = jest.spyOn(request, 'post');
});
afterEach(() => jest.restoreAllMocks());

function setup(userId: string | undefined = 'owner') {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    invalidate,
    ...renderHook(() => useResponseReviewDecision('response/test', userId, 'tenant'), { wrapper }),
  };
}

function setupCancel(userId: string | undefined = 'owner') {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  const invalidate = jest.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    invalidate,
    ...renderHook(() => useResponseCancel('response/test', userId, 'tenant'), { wrapper }),
  };
}

it('cancels only the scoped owner response and refreshes its canonical status', async () => {
  post.mockResolvedValue({ id: 'response/test', status: 'in_progress' });
  const f = setupCancel();
  await act(async () => {
    await f.result.current.mutateAsync();
  });
  expect(post).toHaveBeenCalledWith('/api/agents/responses/response%2Ftest/cancel', {});
  expect(f.invalidate).toHaveBeenCalledWith([
    QueryKeys.responseReview,
    'owner',
    'tenant',
    'response/test',
  ]);
});

it.each([{ id: 'wrong', status: 'cancelled' }, {}, { id: 'response/test', status: 'unknown' }])(
  'rejects invalid cancellation receipt without automatic retries',
  async (body) => {
    post.mockResolvedValue(body);
    const f = setupCancel();
    await act(async () => {
      await expect(f.result.current.mutateAsync()).rejects.toThrow(
        'Response cancellation acknowledgement is unavailable',
      );
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.invalidate).toHaveBeenCalledWith([
      QueryKeys.responseReview,
      'owner',
      'tenant',
      'response/test',
    ]);
  },
);

it('never cancels without a browser owner', async () => {
  const f = setupCancel('');
  await act(async () => {
    await expect(f.result.current.mutateAsync()).rejects.toThrow('Response owner is unavailable');
  });
  expect(post).not.toHaveBeenCalled();
});

it('uses only the owner Responses review endpoint and invalidates only that owner/tenant response', async () => {
  post.mockResolvedValue(receipt);
  const f = setup();
  await act(async () => {
    expect(await f.result.current.mutateAsync(decision)).toEqual(receipt);
  });
  expect(post).toHaveBeenCalledWith('/api/agents/responses/response%2Ftest/review', decision);
  expect(f.invalidate).toHaveBeenCalledWith([
    QueryKeys.responseReview,
    'owner',
    'tenant',
    'response/test',
  ]);
  expect(post).toHaveBeenCalledTimes(1);
});

it.each([
  { ...receipt, responseId: 'another-response' },
  { ...receipt, actionId: 'another-action' },
  {},
])(
  'rejects a mismatched or malformed acknowledgement without marking review successful',
  async (body) => {
    post.mockResolvedValue(body);
    const f = setup();
    await act(async () => {
      await expect(f.result.current.mutateAsync(decision)).rejects.toThrow(
        'Response decision acknowledgement is unavailable',
      );
    });
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  },
);

it('does not automatically retry an ambiguous submission failure', async () => {
  post.mockRejectedValue(new Error('service unavailable'));
  const f = setup();
  await act(async () => {
    await expect(f.result.current.mutateAsync(decision)).rejects.toThrow('service unavailable');
  });
  expect(post).toHaveBeenCalledTimes(1);
  expect(f.invalidate).not.toHaveBeenCalled();
});

it('does not submit without an authenticated owner', async () => {
  const f = setup('');
  await act(async () => {
    await expect(f.result.current.mutateAsync(decision)).rejects.toThrow(
      'Response owner is unavailable',
    );
  });
  expect(post).not.toHaveBeenCalled();
});
