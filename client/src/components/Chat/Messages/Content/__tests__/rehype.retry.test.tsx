import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useRehypeModules } from '../rehype';

/** The first load of the highlighting plugin fails, as a dropped chunk request would. */
let mockFailures = 1;
jest.mock('rehype-highlight', () => {
  if (mockFailures > 0) {
    mockFailures -= 1;
    throw new Error('network dropped the chunk');
  }
  return jest.requireActual('rehype-highlight');
});

function Probe() {
  const modules = useRehypeModules('```js\nconst answer = 42;\n```');
  return <span data-testid="probe">{modules ? 'loaded' : 'waiting'}</span>;
}

describe('useRehypeModules after a failed load', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries while mounted instead of waiting for a remount', async () => {
    render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('waiting');

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('loaded'));
    expect(mockFailures).toBe(0);
  });
});
