import { act, renderHook } from '@testing-library/react';
import useSpeechToText from './useSpeechToText';

let mockSpeechToTextEndpoint = 'external';
let mockBrowserIsListening = false;
let mockExternalIsListening = false;

const mockStartSpeechRecordingBrowser = jest.fn();
const mockStopSpeechRecordingBrowser = jest.fn();
const mockStartSpeechRecordingExternal = jest.fn();
const mockStopSpeechRecordingExternal = jest.fn();

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

describe('useSpeechToText', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSpeechToTextEndpoint = 'external';
    mockBrowserIsListening = false;
    mockExternalIsListening = false;
  });

  it('selects the externally seeded engine after settings change', () => {
    mockSpeechToTextEndpoint = 'browser';
    const { result, rerender } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn()));

    mockSpeechToTextEndpoint = 'external';
    rerender();

    act(() => result.current.startRecording());

    expect(mockStartSpeechRecordingExternal).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingBrowser).not.toHaveBeenCalled();
  });

  it('selects the browser engine', () => {
    mockSpeechToTextEndpoint = 'browser';
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn()));

    act(() => result.current.startRecording());

    expect(mockStartSpeechRecordingBrowser).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingExternal).not.toHaveBeenCalled();
  });

  it('selects the active engine stop handler', () => {
    mockExternalIsListening = true;
    const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn(), jest.fn()));

    act(() => result.current.stopRecording());

    expect(mockStopSpeechRecordingExternal).toHaveBeenCalledTimes(1);
    expect(mockStartSpeechRecordingExternal).not.toHaveBeenCalled();
    expect(mockStopSpeechRecordingBrowser).not.toHaveBeenCalled();
  });
});
