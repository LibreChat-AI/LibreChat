import { act, renderHook } from '@testing-library/react';
import useSpeechToText from './useSpeechToText';

let mockSpeechToTextEndpoint = 'external';
let mockBrowserIsListening = false;
let mockExternalIsListening = false;

const mockStartSpeechRecordingBrowser = jest.fn();
const mockStopSpeechRecordingBrowser = jest.fn();
const mockStartSpeechRecordingExternal = jest.fn();
const mockStopSpeechRecordingExternal = jest.fn();
const mockStartSpeechRecordingRealtime = jest.fn();
const mockStopSpeechRecordingRealtime = jest.fn();
const mockAbortSpeechRecordingRealtime = jest.fn();
let mockRealtimeConnection: 'connecting' | 'reconnecting' | null = null;

jest.mock('./useGetAudioSettings', () => ({
  __esModule: true,
  default: () => ({ speechToTextEndpoint: mockSpeechToTextEndpoint }),
}));

jest.mock('./useSpeechToTextBrowser', () => ({
  __esModule: true,
  default: () => ({
    isListening: mockBrowserIsListening,
    isLoading: false,
    startRecording: mockStartSpeechRecordingBrowser,
    stopRecording: mockStopSpeechRecordingBrowser,
  }),
}));

jest.mock('./useSpeechToTextExternal', () => ({
  __esModule: true,
  default: () => ({
    isListening: mockExternalIsListening,
    isLoading: false,
    externalStartRecording: mockStartSpeechRecordingExternal,
    externalStopRecording: mockStopSpeechRecordingExternal,
  }),
}));

jest.mock('./useSpeechToTextRealtime', () => ({
  __esModule: true,
  default: () => ({
    isListening: true,
    isLoading: false,
    connection: mockRealtimeConnection,
    startRecording: mockStartSpeechRecordingRealtime,
    stopRecording: mockStopSpeechRecordingRealtime,
    abortRecording: mockAbortSpeechRecordingRealtime,
  }),
}));

describe('useSpeechToText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeechToTextEndpoint = 'external';
    mockBrowserIsListening = false;
    mockExternalIsListening = false;
    mockRealtimeConnection = null;
  });

  it('selects the externally seeded engine after settings change', () => {
    mockSpeechToTextEndpoint = 'browser';
    const { result, rerender } = renderHook(() =>
      useSpeechToText(jest.fn(), jest.fn(), jest.fn(), -1),
    );

    mockSpeechToTextEndpoint = 'external';
    rerender();

    act(() => result.current.startRecording());

    expect(mockStartSpeechRecordingExternal).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingBrowser).not.toHaveBeenCalled();
  });

  it('selects the browser engine', () => {
    mockSpeechToTextEndpoint = 'browser';
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn(), -1));

    act(() => result.current.startRecording());

    expect(mockStartSpeechRecordingBrowser).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingExternal).not.toHaveBeenCalled();
  });

  it('selects the active engine stop handler', () => {
    mockExternalIsListening = true;
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn(), -1));

    act(() => result.current.stopRecording());

    expect(mockStopSpeechRecordingExternal).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingExternal).not.toHaveBeenCalled();
    expect(mockStopSpeechRecordingBrowser).not.toHaveBeenCalled();
  });

  it('selects the live engine and reports its connection', () => {
    mockSpeechToTextEndpoint = 'realtime';
    mockRealtimeConnection = 'connecting';
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn(), -1));

    expect(result.current.isListening).toBe(true);
    expect(result.current.connection).toBe('connecting');

    act(() => result.current.startRecording());
    act(() => result.current.stopRecording());
    act(() => result.current.abortRecording());

    expect(mockStartSpeechRecordingRealtime).toHaveBeenCalledTimes(1);
    expect(mockStopSpeechRecordingRealtime).toHaveBeenCalledTimes(1);
    expect(mockAbortSpeechRecordingRealtime).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingExternal).not.toHaveBeenCalled();
    expect(mockStartSpeechRecordingBrowser).not.toHaveBeenCalled();
  });

  it('reports no connection state for the recorded engines', () => {
    mockRealtimeConnection = 'reconnecting';
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn(), -1));

    expect(result.current.connection).toBeNull();
  });
});
