import { useEffect } from 'react';
import { render, act } from '@testing-library/react';
import type { BrowserProductFact } from 'librechat-data-provider';
import { TrackingProvider, useProductTracking } from '../TrackingContext';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
}));

function Observer({ fact }: { fact: BrowserProductFact }) {
  const track = useProductTracking();
  useEffect(() => {
    void track(fact);
  }, [fact, track]);
  return <button>{'Chat remains usable'}</button>;
}

const submission: BrowserProductFact = {
  name: 'librechat.chat.message.submitted',
  feature: 'chat',
  submissionId: 'aef33490-7e1a-4786-9ac6-d45dd28ca281',
  kind: 'send',
  model: 'private-model',
  provider: 'private-endpoint',
  agentId: 'private__model___Sender',
};

it('normalizes chat labels before invoking the browser host callback', async () => {
  const track = jest.fn();
  render(
    <TrackingProvider track={track}>
      <Observer fact={submission} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toMatchObject({
    model: 'custom',
    provider: 'custom',
    agentId: undefined,
  });
  expect(JSON.stringify(track.mock.calls)).not.toContain('private');
});

it('drops malformed facts without interrupting the browser action', async () => {
  const track = jest.fn();
  const malformed = { ...submission, arguments: 'private' };
  const view = render(
    <TrackingProvider track={track}>
      <Observer fact={malformed} />
    </TrackingProvider>,
  );
  await act(async () => {});
  expect(track).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Chat remains usable' })).toBeInTheDocument();
});
