import axios from 'axios';
import { MemoryRouter } from 'react-router-dom';
import { useAtomValue, useSetAtom } from 'jotai';
import { ToastContext } from '@librechat/client';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { filesFamily, presetFamily } from '@librechat/chat/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TPreset } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ExtendedFile } from '~/common';
import translationEn from '~/locales/en/translation.json';
import { AuthContextProvider } from '~/hooks/AuthContext';
import usePresets from '../usePresets';
import store from '~/store';

/** Counts the times the library is actually evaluated, which only the lazy loader may trigger. */
const mockEvaluated = jest.fn();
const mockExportFromJSON = jest.fn();
const mockShowToast = jest.fn();

jest.mock('export-from-json', () => {
  mockEvaluated('export-from-json');
  return Object.assign(mockExportFromJSON, { types: { json: 'json' } });
});

const preset = { title: 'My preset', endpoint: 'openAI', model: 'gpt-4o' } as TPreset;

/** The hook runs on the real providers, stores and data layer; only the HTTP client is faked. */
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <RecoilRoot>
          <MemoryRouter>
            <AuthContextProvider authConfig={{ loginRedirect: '', test: true }}>
              <ToastContext.Provider value={{ showToast: mockShowToast }}>
                {children}
              </ToastContext.Provider>
            </AuthContextProvider>
          </MemoryRouter>
        </RecoilRoot>
      </QueryClientProvider>
    );
  };
}

function setup() {
  const hook = renderHook(
    () => ({ presets: usePresets(), setPreset: useSetAtom(presetFamily(0)) }),
    { wrapper: wrapper() },
  );
  act(() => hook.result.current.setPreset(preset));
  return hook;
}

describe('exportPreset', () => {
  beforeEach(() => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    delete window.__lcRecoverStaleAssets;
  });

  it('does not load the export library when the hook is imported, rendered or has no preset', async () => {
    expect(mockEvaluated).not.toHaveBeenCalled();
    const { result } = renderHook(() => usePresets(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.exportPreset();
    });
    expect(mockEvaluated).not.toHaveBeenCalled();
  });

  it('loads the library on demand and exports the preset as JSON', async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.presets.exportPreset();
    });
    expect(mockEvaluated).toHaveBeenCalledTimes(1);
    expect(mockExportFromJSON).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'My_preset',
        exportType: 'json',
        data: expect.objectContaining({ endpoint: 'openAI', model: 'gpt-4o' }),
      }),
    );
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('tells the user when the library chunk cannot load and asks for stale-asset recovery', async () => {
    const recover = jest.fn(() => false);
    window.__lcRecoverStaleAssets = recover;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = setup();
    jest.resetModules();
    jest.doMock('export-from-json', () => {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/export-old.js');
    });

    await act(async () => {
      await result.current.presets.exportPreset();
    });

    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: translationEn.com_endpoint_preset_export_error }),
    );
    expect(recover).toHaveBeenCalledTimes(1);
    expect(mockExportFromJSON).not.toHaveBeenCalled();
  });
});

describe('onSelectPreset', () => {
  beforeEach(() => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: {} });
  });

  it('keeps the attachments of the unsent chat it is picked for', () => {
    const upload = {
      file_id: 'kept-upload',
      temp_file_id: 'client-kept-upload',
      filepath: '/uploads/kept.txt',
      source: 'local',
      progress: 1,
    } as ExtendedFile;
    const { result } = renderHook(
      () => ({
        presets: usePresets(),
        files: useAtomValue(filesFamily(0)),
        setFiles: useSetAtom(filesFamily(0)),
        setConversation: useSetRecoilState(store.conversationByIndex(0)),
      }),
      { wrapper: wrapper() },
    );
    act(() => {
      result.current.setConversation({
        conversationId: 'new',
        endpoint: 'openAI',
        model: 'gpt-4o',
      } as TConversation);
      result.current.setFiles(new Map([['client-kept-upload', upload]]));
    });

    act(() =>
      result.current.presets.onSelectPreset({
        title: 'Claude preset',
        endpoint: 'anthropic',
        model: 'claude-sonnet-4-5',
      } as TPreset),
    );

    expect(Array.from(result.current.files.keys())).toEqual(['client-kept-upload']);
  });
});
