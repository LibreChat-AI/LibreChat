import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { TrackingProvider } from '~/Providers/TrackingContext';
import { useSkillOpened } from '../useSkillOpened';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { productTracking: { enabled: true } } }),
}));

function Observer({
  requestedId,
  loadedId,
  loaded,
}: {
  requestedId: string;
  loadedId?: string;
  loaded: boolean;
}) {
  useSkillOpened(requestedId, loadedId ? { _id: loadedId } : undefined, loaded);
  return null;
}

it('waits for the loaded skill, rejects stale data, and records one open in StrictMode', async () => {
  const track = jest.fn();
  const view = (requestedId: string, loadedId?: string, loaded = false) => (
    <StrictMode>
      <TrackingProvider track={track}>
        <Observer requestedId={requestedId} loadedId={loadedId} loaded={loaded} />
      </TrackingProvider>
    </StrictMode>
  );
  const rendered = render(view('private-route-text'));
  await act(async () => {});
  expect(track).not.toHaveBeenCalled();
  rendered.rerender(view('private-route-text', 'stored-id', true));
  await act(async () => {});
  expect(track).not.toHaveBeenCalled();
  rendered.rerender(view('stored-id', 'stored-id', true));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(track.mock.calls[0][0]).toEqual({
    name: 'librechat.skills.opened',
    feature: 'skills',
    entryPoint: 'route',
    skillId: 'stored-id',
  });
  rendered.rerender(view('stored-id', 'stored-id', true));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  rendered.rerender(view('another-private-route', 'stored-id', false));
  await act(async () => {});
  expect(track).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(track.mock.calls)).not.toContain('private-route');
});
