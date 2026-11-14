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
  useFeatureObservation('skills', 'panel', visible);
  return <button>{'Product remains usable'}</button>;
}

it('records visible opens once, including a later reopen', () => {
  const events: BrowserProductFact[] = [];
  const track = (event: BrowserProductFact) => {
    events.push(event);
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
  expect(events).toEqual([
    {
      name: 'librechat.feature.observed',
      feature: 'skills',
      entryPoint: 'panel',
      observation: 'opened',
    },
  ]);
  rendered.rerender(view(true));
  expect(events).toHaveLength(1);
  rendered.rerender(view(false));
  rendered.rerender(view(true));
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
