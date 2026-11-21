import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type {
  BrowserProductFact,
  ProductTrackingContext,
  TPromptGroup,
} from 'librechat-data-provider';
import {
  getProductPromptReference,
  usePromptOpened,
  usePromptResolved,
} from '../usePromptTracking';
import { TrackingProvider } from '~/Providers/TrackingContext';

const mockTrack = jest.fn();
/** The provider also reports `librechat.session.activity`; these tests count prompt facts only. */
const trackPrompts = (fact: BrowserProductFact, context?: ProductTrackingContext) => {
  if (fact.name !== 'librechat.session.activity') mockTrack(fact, context);
};
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
}));

beforeEach(() => {
  mockTrack.mockClear();
  localStorage.clear();
});

function Observer({ visible, groupId }: { visible: boolean; groupId?: string }) {
  usePromptOpened('preview', visible, groupId);
  return null;
}

it('records visible object opens once, with new observations for another object or reopen', async () => {
  const track = mockTrack;
  const view = (visible: boolean, groupId = 'group-1') => (
    <StrictMode>
      <TrackingProvider track={trackPrompts}>
        <Observer visible={visible} groupId={groupId} />
      </TrackingProvider>
    </StrictMode>
  );
  const rendered = render(view(false));
  expect(track).not.toHaveBeenCalled();
  rendered.rerender(view(true));
  rendered.rerender(view(true));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toEqual({
    name: 'librechat.prompts.opened',
    feature: 'prompts',
    entryPoint: 'preview',
    groupId: 'group-1',
  });
  rendered.rerender(view(true, 'group-2'));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(2);
  rendered.rerender(view(false, 'group-2'));
  rendered.rerender(view(true, 'group-2'));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(3);
});

it('keeps one initial visible open when StrictMode replaces the provider session', async () => {
  const view = (
    <StrictMode>
      <TrackingProvider track={trackPrompts}>
        <Observer visible groupId="group-1" />
      </TrackingProvider>
    </StrictMode>
  );
  const rendered = render(view);
  await act(async () => {});
  expect(mockTrack).toHaveBeenCalledTimes(1);
  expect(mockTrack).toHaveBeenCalledWith(
    {
      name: 'librechat.prompts.opened',
      feature: 'prompts',
      entryPoint: 'preview',
      groupId: 'group-1',
    },
    { sessionId: expect.any(String) },
  );
  rendered.rerender(view);
  await act(async () => {});
  expect(mockTrack).toHaveBeenCalledTimes(1);
});

it('requires successful external resolution and excludes revisions and content', () => {
  const group: TPromptGroup = {
    _id: 'group-1',
    name: 'private name',
    source: 'langfuse',
    author: 'user-1',
    authorName: 'Author',
  };
  expect(getProductPromptReference(group)).toBeUndefined();
  expect(
    getProductPromptReference(group, {
      source: 'langfuse',
      groupId: 'group-1',
      version: 2,
      type: 'text',
      prompt: 'private content',
      labels: [],
    }),
  ).toEqual({ source: 'langfuse', groupId: 'group-1' });
  expect(
    getProductPromptReference({ ...group, source: 'native', productionId: 'prompt-1' }),
  ).toEqual({ source: 'native', groupId: 'group-1' });
});

it.each([false, true])(
  'dispatches resolution before handing text to the composer (variables=%s)',
  (variables) => {
    const order: string[] = [];
    const track = jest.fn((fact: BrowserProductFact, _context?: ProductTrackingContext) => {
      order.push(fact.name);
    });
    function ResolveButton() {
      const resolved = usePromptResolved('picker');
      return (
        <button
          onClick={() => {
            resolved({ source: 'native', groupId: 'group-1' }, variables);
            order.push('submit');
          }}
        >
          {'Resolve'}
        </button>
      );
    }
    render(
      <TrackingProvider track={track}>
        <ResolveButton />
      </TrackingProvider>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(order).toEqual(['librechat.prompts.resolved', 'submit']);
    expect(track.mock.calls[0][1]).toEqual({ sessionId: expect.any(String) });
  },
);
