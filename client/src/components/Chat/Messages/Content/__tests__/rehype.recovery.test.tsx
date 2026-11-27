import React from 'react';
import { LazyImportProvider } from '@librechat/chat/react';
import { render, screen, waitFor } from '@testing-library/react';
import { importWithRecovery } from '~/lib/assets/lazy';
import { useRehypeModules } from '../rehype';

/** The highlighting plugin's chunk is gone, as it is for a page a newer deploy has outdated. */
jest.mock('rehype-highlight', () => {
  throw new TypeError('Failed to fetch dynamically imported module: /assets/rehype-highlight.js');
});

function Probe() {
  const modules = useRehypeModules('```js\nconst answer = 42;\n```');
  return <span data-testid="probe">{modules ? 'loaded' : 'waiting'}</span>;
}

describe('the markdown plugins under the app’s import recovery', () => {
  const recover = jest.fn(() => true);

  beforeEach(() => {
    window.__lcRecoverStaleAssets = recover;
  });
  afterEach(() => {
    delete window.__lcRecoverStaleAssets;
  });

  it('asks for stale-asset recovery when a plugin chunk fails to load', async () => {
    render(
      <LazyImportProvider value={importWithRecovery}>
        <Probe />
      </LazyImportProvider>,
    );
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('probe')).toHaveTextContent('waiting');
  });
});
