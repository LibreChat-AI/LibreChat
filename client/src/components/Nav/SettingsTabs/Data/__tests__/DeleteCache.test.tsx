import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearTTSCache, setCachedTTSAudio, getTTSCacheGeneration } from '~/utils';
import { DeleteCache } from '../DeleteCache';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const deleteButton = () => screen.getByRole('button', { name: 'com_nav_delete_cache_storage' });

describe('DeleteCache', () => {
  const has = jest.fn(async (_name: string) => false);

  beforeEach(() => {
    has.mockResolvedValue(false);
    Object.defineProperty(globalThis, 'caches', {
      value: { has, delete: jest.fn(async () => true) },
      configurable: true,
    });
    clearTTSCache();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'caches');
  });

  it('is disabled when nothing is cached in memory or left on disk', async () => {
    render(<DeleteCache />);
    await waitFor(() => expect(has).toHaveBeenCalled());
    expect(deleteButton()).toBeDisabled();
  });

  it('is enabled while audio is cached in this tab', async () => {
    setCachedTTSAudio('key', new Blob(['audio']), getTTSCacheGeneration());
    render(<DeleteCache />);
    await waitFor(() => expect(deleteButton()).toBeEnabled());
  });

  it("stays available when an earlier build's cache could not be deleted at startup", async () => {
    has.mockImplementation(async (name: string) => name === 'tts-responses');
    render(<DeleteCache />);
    await waitFor(() => expect(deleteButton()).toBeEnabled());
  });

  it('stays available after a delete whose legacy cache could not be removed', async () => {
    setCachedTTSAudio('key', new Blob(['audio']), getTTSCacheGeneration());
    has.mockImplementation(async (name: string) => name === 'tts-responses');
    render(<DeleteCache />);
    await waitFor(() => expect(deleteButton()).toBeEnabled());

    has.mockClear();
    fireEvent.click(deleteButton());
    fireEvent.click(await screen.findByRole('button', { name: 'com_ui_delete' }));
    /** The recheck after the delete finds the legacy cache still there. */
    await waitFor(() => expect(has).toHaveBeenCalled());
    expect(deleteButton()).toBeEnabled();
  });
});
