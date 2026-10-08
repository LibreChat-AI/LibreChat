import { renderHook } from '@testing-library/react';
import type { ParentSubagentIndex, SubagentThreadView } from 'librechat-data-provider';
import {
  isSubagentReadinessPending,
  parentSubagentsRefetchInterval,
  reconcileSubagentControlReceipts,
  subagentThreadHasTaskEvidence,
  subagentThreadRefetchInterval,
  useParentSubagentsQuery,
  useSubagentThreadQuery,
} from './queries';

const mockUseQuery = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

const view = (status: SubagentThreadView['status']): SubagentThreadView =>
  ({ status }) as SubagentThreadView;

describe('subagent thread refresh policy', () => {
  it('does not downgrade a refreshed terminal control receipt to accepted', () => {
    const applied = {
      invocationId: 'invocation-1',
      action: 'queue',
      status: 'applied',
      createdAt: '2026-08-24T12:00:00.000Z',
      updatedAt: '2026-08-24T12:00:02.000Z',
    } as const;
    const accepted = {
      ...applied,
      status: 'accepted',
      updatedAt: '2026-08-24T12:00:01.000Z',
    } as const;

    expect(reconcileSubagentControlReceipts([applied], accepted)).toEqual([applied]);
  });

  it('bounds child-readiness retries and keeps active work fresh', () => {
    expect(subagentThreadRefetchInterval(undefined, 1_000, 500)).toBe(2_000);
    expect(subagentThreadRefetchInterval(view('dispatched'), 1_000, 500)).toBe(2_000);
    expect(subagentThreadRefetchInterval(undefined, 1_000, 1_000)).toBe(false);
    expect(subagentThreadRefetchInterval(view('dispatched'), 1_000, 1_000)).toBe(false);
    expect(subagentThreadRefetchInterval(view('running'), 1_000, 10_000)).toBe(2_000);
  });

  it.each(['completed', 'failed', 'interrupted', 'cancelled'] as const)(
    'stops polling terminal %s threads',
    (status) => {
      expect(subagentThreadRefetchInterval(view(status), 1_000, 500)).toBe(false);
    },
  );

  it('keeps polling a cached terminal thread until the selected task appears', () => {
    const prior = {
      ...view('completed'),
      messages: [{ messageId: 'old-task:assistant' }],
    } as SubagentThreadView;
    const current = {
      ...view('completed'),
      messages: [{ messageId: 'new-task:assistant' }],
    } as SubagentThreadView;

    expect(subagentThreadRefetchInterval(prior, 1_000, 500, 'new-task')).toBe(2_000);
    expect(subagentThreadRefetchInterval(current, 1_000, 500, 'new-task')).toBe(false);
    expect(subagentThreadRefetchInterval(prior, 1_000, 1_000, 'new-task')).toBe(false);
  });

  it('associates terminal state only with evidence from the selected task', () => {
    const prior = {
      ...view('completed'),
      messages: [{ messageId: 'old-task:assistant' }],
    } as SubagentThreadView;

    expect(subagentThreadHasTaskEvidence(prior, 'new-task')).toBe(false);
    expect(subagentThreadHasTaskEvidence(prior, 'old-task')).toBe(true);
  });

  it('stops polling an older API view once the exact task response exists', () => {
    const rollingDeployView = {
      ...view('running'),
      messages: [{ messageId: 'selected:assistant' }],
    } as SubagentThreadView;

    expect(subagentThreadRefetchInterval(rollingDeployView, 1_000, 500, 'selected')).toBe(false);
  });

  it('treats only readiness-window 404s as pending', () => {
    expect(isSubagentReadinessPending({ response: { status: 404 } }, 1_000, 500)).toBe(true);
    expect(isSubagentReadinessPending({ response: { status: 404 } }, 1_000, 1_000)).toBe(false);
    expect(isSubagentReadinessPending({ response: { status: 500 } }, 1_000, 500)).toBe(false);
  });

  it('keys the bounded activity projection by the selected invocation', () => {
    const refetch = jest.fn();
    mockUseQuery.mockReturnValue({
      data: view('completed'),
      error: null,
      refetch,
    });
    const { rerender } = renderHook(
      ({ taskId }) => useSubagentThreadQuery('parent-conversation', 'child-thread', taskId),
      { initialProps: { taskId: 'task-1' } },
    );

    expect(mockUseQuery.mock.calls.at(-1)?.[0]).toEqual([
      'subagentThread',
      'parent-conversation',
      'child-thread',
      'task-1',
    ]);
    rerender({ taskId: 'task-2' });
    expect(mockUseQuery.mock.calls.at(-1)?.[0]).toEqual([
      'subagentThread',
      'parent-conversation',
      'child-thread',
      'task-2',
    ]);
    expect(refetch).not.toHaveBeenCalled();
  });

  it('retains fast live refresh but sparsifies quiet parent discovery', () => {
    const parent = (status?: ParentSubagentIndex['children'][number]['status']) =>
      ({
        parentConversationId: 'parent-conversation',
        childrenTruncated: false,
        children: status == null ? [] : [{ status }],
      }) as ParentSubagentIndex;

    expect(parentSubagentsRefetchInterval(parent('running'))).toBe(2_000);
    expect(parentSubagentsRefetchInterval(parent('dispatched'))).toBe(10_000);
    expect(parentSubagentsRefetchInterval(parent(), false, null, 1)).toBe(10_000);
    expect(parentSubagentsRefetchInterval(parent(), false, null, 2)).toBe(60_000);
    expect(parentSubagentsRefetchInterval(parent('completed'), false, null, 3)).toBe(60_000);
    expect(parentSubagentsRefetchInterval(parent(), true, null, 20)).toBe(10_000);
    expect(parentSubagentsRefetchInterval(undefined)).toBe(10_000);
  });

  it('stops idle 404 polling and gives a running first turn bounded readiness retries', () => {
    const missing = { response: { status: 404 } };
    expect(parentSubagentsRefetchInterval(undefined, false, missing, 0, Date.now() + 60_000)).toBe(
      false,
    );
    expect(parentSubagentsRefetchInterval(undefined, true, missing, 0, Date.now() + 60_000)).toBe(
      10_000,
    );
    expect(parentSubagentsRefetchInterval(undefined, true, missing, 0, Date.now())).toBe(false);
    expect(parentSubagentsRefetchInterval(undefined, false, { response: { status: 503 } })).toBe(
      60_000,
    );
  });

  it('keeps idle fallback and suppresses automatic 404 retries in the live query', () => {
    mockUseQuery.mockReturnValue({ data: undefined, error: null, refetch: jest.fn() });

    renderHook(() => useParentSubagentsQuery('parent-conversation'));

    expect(mockUseQuery.mock.calls.at(-1)?.[0]).toEqual(['parentSubagents', 'parent-conversation']);
    const options = mockUseQuery.mock.calls.at(-1)?.[2];
    expect(options).toEqual(
      expect.objectContaining({
        enabled: true,
        refetchOnWindowFocus: true,
        refetchIntervalInBackground: false,
        staleTime: 5_000,
      }),
    );
    expect(options.retry(0, { response: { status: 404 } })).toBe(false);
    expect(options.retry(0, { response: { status: 500 } })).toBe(true);
    expect(options.retry(3, { response: { status: 500 } })).toBe(false);
    expect(
      options.refetchInterval(undefined, { state: { dataUpdateCount: 0, error: { status: 404 } } }),
    ).toBe(false);
    expect(
      options.refetchInterval({ children: [] }, { state: { dataUpdateCount: 2, error: null } }),
    ).toBe(60_000);
  });
});
