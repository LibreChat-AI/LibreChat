import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook, waitFor } from '@testing-library/react';

const mockUseGetCustomConfigSpeechQuery = jest.fn();

jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: () => mockUseGetCustomConfigSpeechQuery(),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
}));

import useSpeechSettingsInit from '../useSpeechSettingsInit';
import store from '~/store';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

const useSpeechSettingsHarness = (isAuthenticated = true) => {
  useSpeechSettingsInit(isAuthenticated);
  return {
    engineSTT: useRecoilValue(store.engineSTT),
    engineTTS: useRecoilValue(store.engineTTS),
    speechSettingsInitialized: useRecoilValue(store.speechSettingsInitialized),
  };
};

describe('useSpeechSettingsInit', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: { sttExternal: true, ttsExternal: true },
      isFetched: true,
    });
  });

  it.each(['openai', 'azureOpenAI'])(
    'migrates the persisted STT provider "%s" to the external engine',
    async (engineSTT) => {
      localStorage.setItem('engineSTT', JSON.stringify(engineSTT));

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.engineSTT).toBe('external'));
      expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('external'));
    },
  );

  it.each(['openai', 'azureOpenAI', 'elevenlabs', 'localai'])(
    'migrates the persisted TTS provider "%s" to the external engine',
    async (engineTTS) => {
      localStorage.setItem('engineTTS', JSON.stringify(engineTTS));

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.engineTTS).toBe('external'));
      expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('external'));
    },
  );

  it('falls back migrated providers when no external provider is reported', async () => {
    localStorage.setItem('engineSTT', JSON.stringify('openai'));
    localStorage.setItem('engineTTS', JSON.stringify('elevenlabs'));
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: { sttExternal: false, ttsExternal: false },
      isFetched: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({
        engineSTT: 'browser',
        engineTTS: 'browser',
        speechSettingsInitialized: true,
      });
    });
    expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('browser'));
    expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('browser'));
  });

  it('falls back saved external engines when their providers are unavailable', async () => {
    localStorage.setItem('engineSTT', JSON.stringify('external'));
    localStorage.setItem('engineTTS', JSON.stringify('external'));
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: { sttExternal: false, ttsExternal: false },
      isFetched: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({
        engineSTT: 'browser',
        engineTTS: 'browser',
        speechSettingsInitialized: true,
      });
    });
    expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('browser'));
    expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('browser'));
  });

  it.each(['browser', 'external'])('preserves the valid engine "%s"', async (engine) => {
    localStorage.setItem('engineSTT', JSON.stringify(engine));
    localStorage.setItem('engineTTS', JSON.stringify(engine));

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({
        engineSTT: engine,
        engineTTS: engine,
        speechSettingsInitialized: true,
      });
    });
  });

  it.each([
    ['loading', { data: undefined, isFetched: false, isError: false }, false],
    ['error', { data: undefined, isFetched: true, isError: true }, true],
  ])(
    'normalizes legacy providers while the speech configuration query is in the %s state',
    async (_state, queryResult, speechSettingsInitialized) => {
      localStorage.setItem('engineSTT', JSON.stringify('openai'));
      localStorage.setItem('engineTTS', JSON.stringify('localai'));
      mockUseGetCustomConfigSpeechQuery.mockReturnValue(queryResult);

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => {
        expect(result.current).toEqual({
          engineSTT: 'external',
          engineTTS: 'external',
          speechSettingsInitialized,
        });
      });
      expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('external'));
      expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('external'));
    },
  );

  describe('live engine', () => {
    it('keeps a saved live engine while the server offers it', async () => {
      localStorage.setItem('engineSTT', JSON.stringify('realtime'));
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: { sttExternal: true, sttRealtime: true, ttsExternal: true },
        isFetched: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.speechSettingsInitialized).toBe(true));
      expect(result.current.engineSTT).toBe('realtime');
      expect(localStorage.getItem('sttRealtime')).toBeNull();
    });

    it('falls back to recorded transcription when the live block is removed', async () => {
      localStorage.setItem('engineSTT', JSON.stringify('realtime'));
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: { sttExternal: true, sttRealtime: false, ttsExternal: true },
        isFetched: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.engineSTT).toBe('external'));
      expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('external'));
    });

    it('falls back to the browser when no speech provider is left', async () => {
      localStorage.setItem('engineSTT', JSON.stringify('realtime'));
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: { sttExternal: false, sttRealtime: false, ttsExternal: false },
        isFetched: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.engineSTT).toBe('browser'));
    });

    it('seeds the live engine as the server default', async () => {
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: { sttExternal: true, sttRealtime: true, ttsExternal: true, engineSTT: 'realtime' },
        isFetched: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.engineSTT).toBe('realtime'));
    });

    it('does not seed a live default the server cannot serve', async () => {
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: { sttExternal: true, sttRealtime: false, ttsExternal: true, engineSTT: 'realtime' },
        isFetched: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      await waitFor(() => expect(result.current.speechSettingsInitialized).toBe(true));
      await waitFor(() => expect(result.current.engineSTT).toBe('external'));
    });
  });

  it('normalizes unknown saved engines to browser', async () => {
    localStorage.setItem('engineSTT', JSON.stringify('unknown-stt'));
    localStorage.setItem('engineTTS', JSON.stringify('unknown-tts'));

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({
        engineSTT: 'browser',
        engineTTS: 'browser',
        speechSettingsInitialized: true,
      });
    });
    expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('browser'));
    expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('browser'));
  });

  it('seeds external engines from the server configuration when storage is empty', async () => {
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: {
        sttExternal: true,
        ttsExternal: true,
        engineSTT: 'external',
        engineTTS: 'external',
      },
      isFetched: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => {
      expect(result.current).toEqual({
        engineSTT: 'external',
        engineTTS: 'external',
        speechSettingsInitialized: true,
      });
    });
    expect(localStorage.getItem('engineSTT')).toBe(JSON.stringify('external'));
    expect(localStorage.getItem('engineTTS')).toBe(JSON.stringify('external'));
  });

  it('does not write browser defaults before a server default is provided', () => {
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: { sttExternal: false, ttsExternal: false },
      isFetched: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    expect(result.current).toEqual({
      engineSTT: 'browser',
      engineTTS: 'browser',
      speechSettingsInitialized: true,
    });
    expect(localStorage.getItem('engineSTT')).toBeNull();
    expect(localStorage.getItem('engineTTS')).toBeNull();
  });

  it('keeps speech controls disabled until configuration initialization settles', () => {
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: undefined,
      isFetched: false,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    expect(result.current.speechSettingsInitialized).toBe(false);
  });

  it('enables speech controls after a missing configuration response', async () => {
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: { message: 'not_found' },
      isFetched: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    await waitFor(() => expect(result.current.speechSettingsInitialized).toBe(true));
  });

  it('keeps speech controls disabled after a configuration error on fresh storage', () => {
    mockUseGetCustomConfigSpeechQuery.mockReturnValue({
      data: undefined,
      isFetched: true,
      isError: true,
    });

    const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

    expect(result.current.speechSettingsInitialized).toBe(false);
  });

  it.each(['engineSTT', 'engineTTS'])(
    'keeps speech controls disabled after an error when only %s is saved',
    (savedEngine) => {
      localStorage.setItem(savedEngine, JSON.stringify('browser'));
      mockUseGetCustomConfigSpeechQuery.mockReturnValue({
        data: undefined,
        isFetched: true,
        isError: true,
      });

      const { result } = renderHook(() => useSpeechSettingsHarness(), { wrapper });

      expect(result.current.speechSettingsInitialized).toBe(false);
    },
  );
});
