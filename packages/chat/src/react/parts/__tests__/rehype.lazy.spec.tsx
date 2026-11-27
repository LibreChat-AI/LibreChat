/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import type { LazyImport } from '../../lazy';
import { LazyImportProvider } from '../../lazy';
import { useRehypeModules } from '../rehype';

function Probe() {
  const modules = useRehypeModules('```js\nconst answer = 42;\n```');
  return <span data-testid="probe">{modules ? 'loaded' : 'waiting'}</span>;
}

describe('useRehypeModules under a host that wraps on-demand imports', () => {
  it('loads the plugins through the wrapper, once for every reader', async () => {
    const lazy = jest.fn((load: () => Promise<unknown>) => load()) as jest.Mock & LazyImport;
    render(
      <LazyImportProvider value={lazy}>
        <Probe />
        <Probe />
      </LazyImportProvider>,
    );
    await waitFor(() =>
      screen.getAllByTestId('probe').forEach((probe) => expect(probe).toHaveTextContent('loaded')),
    );
    expect(lazy).toHaveBeenCalledTimes(1);
  });
});
