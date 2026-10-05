import { useMediaQuery } from '@librechat/client';
import { act, render, screen } from '@testing-library/react';
import { MediaImagePending, MediaImagePixels } from '../ImagePending';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useMediaQuery: jest.fn(() => false),
  PixelCard: ({ progress }: { progress: number }) => (
    <div data-testid="pixels" data-fill={progress} />
  ),
}));

const createdAt = '2026-09-17T12:00:00.000Z';
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(createdAt));
  jest.mocked(useMediaQuery).mockReturnValue(false);
});
afterEach(() => jest.useRealTimers());

test('decorative pixels build gradually, cap without completion, and stop their timer', () => {
  const view = render(
    <MediaImagePending createdAt={createdAt} label="Generating" hint="Waiting for provider" />,
  );
  const fill = () => Number(screen.getByTestId('pixels').dataset.fill);
  expect(fill()).toBeCloseTo(0.12);
  act(() => jest.advanceTimersByTime(30000));
  expect(fill()).toBeCloseTo(0.5);
  act(() => jest.advanceTimersByTime(30000));
  expect(fill()).toBeCloseTo(0.88);
  expect(jest.getTimerCount()).toBe(0);
  expect(screen.getByRole('status', { name: 'Generating' })).toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
});

test('restored pending jobs retain a capped decorative surface without inventing completion', () => {
  jest.setSystemTime(new Date('2026-09-17T14:00:00Z'));
  render(
    <MediaImagePending
      createdAt={createdAt}
      label="Checking outcome"
      hint="Waiting for provider"
    />,
  );
  expect(Number(screen.getByTestId('pixels').dataset.fill)).toBeCloseTo(0.88);
  expect(screen.getByRole('status', { name: 'Checking outcome' })).toBeInTheDocument();
  expect(jest.getTimerCount()).toBe(0);
});

test('reduced motion and unmount cancel the decorative timer', () => {
  const view = render(<MediaImagePixels createdAt={createdAt} />);
  expect(jest.getTimerCount()).toBe(1);
  jest.mocked(useMediaQuery).mockReturnValue(true);
  view.rerender(<MediaImagePixels createdAt={createdAt} />);
  expect(jest.getTimerCount()).toBe(0);
  expect(Number(screen.getByTestId('pixels').dataset.fill)).toBeCloseTo(0.88);
  jest.mocked(useMediaQuery).mockReturnValue(false);
  view.rerender(<MediaImagePixels createdAt={createdAt} />);
  expect(jest.getTimerCount()).toBe(1);
  view.unmount();
  expect(jest.getTimerCount()).toBe(0);
});
