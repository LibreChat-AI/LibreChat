import { StrictMode } from 'react';
import { render, act } from '@testing-library/react';
import type { BrowserProductFact, ProductTracker } from 'librechat-data-provider';
import { useFeatureObservation } from '../useProductObservation';
import { TrackingProvider } from '~/Providers/TrackingContext';

let mockProductTracking: { enabled: boolean } | undefined = { enabled: true };
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: mockProductTracking } }),
}));

beforeEach(() => {
  mockProductTracking = { enabled: true };
});

function Observer({ visible }: { visible: boolean }) {
  useFeatureObservation('skills', 'sidebar', visible);
  return <button>{'Product remains usable'}</button>;
}

it('records visible opens once, including a later reopen', async () => {
  const events: BrowserProductFact[] = [];
  const track = (event: BrowserProductFact) => {
    if (event.name === 'librechat.skills.opened') events.push(event);
  };
  const view = (visible: boolean) => (
    <StrictMode>
      <TrackingProvider track={track}>
        <Observer visible={visible} />
      </TrackingProvider>
    </StrictMode>
  );
  const rendered = render(view(false));
  expect(events).toEqual([]);
  rendered.rerender(view(true));
  await act(async () => {});
  expect(events).toEqual([
    {
      name: 'librechat.skills.opened',
      feature: 'skills',
      entryPoint: 'sidebar',
    },
  ]);
  rendered.rerender(view(true));
  await act(async () => {});
  expect(events).toHaveLength(1);
  rendered.rerender(view(false));
  rendered.rerender(view(true));
  await act(async () => {});
  expect(events).toHaveLength(2);
});

it.each([
  () => {
    throw new Error('blocked');
  },
  () => Promise.reject(new Error('blocked')),
] satisfies ProductTracker<BrowserProductFact>[])(
  'does not break the product when tracking fails',
  async (track) => {
    const rendered = render(
      <TrackingProvider track={track}>
        <Observer visible />
      </TrackingProvider>,
    );
    await act(async () => {});
    expect(rendered.getByRole('button')).toBeVisible();
  },
);

it('uses a no-op without a provider', () => {
  expect(() => render(<Observer visible />)).not.toThrow();
});

it.each([undefined, { enabled: false }])(
  'does not call an injected tracker when policy is %p',
  (policy) => {
    mockProductTracking = policy;
    const track = jest.fn();
    render(
      <TrackingProvider track={track}>
        <Observer visible />
      </TrackingProvider>,
    );
    expect(track).not.toHaveBeenCalled();
  },
);

it('creates no session timer or observer delivery while the host is unavailable', async () => {
  const interval = jest.spyOn(window, 'setInterval');
  const track = jest.fn();
  const rendered = render(
    <TrackingProvider track={track} enabled={false}>
      <Observer visible />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(interval).not.toHaveBeenCalled();
  expect(track).not.toHaveBeenCalled();
  rendered.unmount();
  interval.mockRestore();
});

it('drops a queued observation after its provider is removed', async () => {
  const track = jest.fn();
  const rendered = render(
    <TrackingProvider track={track}>
      <Observer visible />
    </TrackingProvider>,
  );
  rendered.unmount();
  await act(async () => {});
  expect(track.mock.calls.some(([fact]) => fact.name === 'librechat.skills.opened')).toBe(false);
});
