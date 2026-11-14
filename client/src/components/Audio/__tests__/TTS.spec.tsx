import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { BrowserTTS, ExternalTTS } from '../TTS';

/**
 * Every assistant row mounts one of these, hidden, for its read-aloud button. Until the button
 * is pressed the element must stay without a source: an `<audio autoplay>` given one starts
 * loading it, so a thread of 250 rows that each point at the page made 250 failed media loads
 * each time the rows re-rendered.
 */

/** The speech engines need auth and a speech synthesizer; the element and its ref are real. */
function mockSpeechHook() {
  const useAudioRef = jest.requireActual('~/hooks/Audio/useAudioRef').default;
  const useSpeech = () => ({
    ...useAudioRef({ setIsPlaying: () => undefined }),
    toggleSpeech: jest.fn(),
    isSpeaking: false,
    isLoading: false,
  });
  return { __esModule: true, default: useSpeech };
}

jest.mock('~/hooks/Audio/useTTSBrowser', () => mockSpeechHook());
jest.mock('~/hooks/Audio/useTTSExternal', () => mockSpeechHook());

const wrap = (ui: ReactElement) => <RecoilRoot>{ui}</RecoilRoot>;

/** jsdom has no object URLs; the element's cleanup revokes its source on unmount. */
const revokeObjectURL = URL.revokeObjectURL;
beforeAll(() => {
  URL.revokeObjectURL = jest.fn();
});
afterAll(() => {
  URL.revokeObjectURL = revokeObjectURL;
});

describe.each([
  ['BrowserTTS', BrowserTTS],
  ['ExternalTTS', ExternalTTS],
])('%s audio element', (_name, TTS) => {
  it('stays without a source across re-renders', () => {
    const props = { index: 0, messageId: 'message-1', content: 'Read this' };
    const { container, rerender } = render(wrap(<TTS {...props} isLast={false} />));
    const audio = container.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.hasAttribute('src')).toBe(false);

    rerender(wrap(<TTS {...props} isLast={true} />));
    rerender(wrap(<TTS {...props} isLast={false} />));

    expect(container.querySelector('audio')).toBe(audio);
    expect(audio?.hasAttribute('src')).toBe(false);
  });

  it('keeps a source the player assigned', () => {
    const props = { index: 0, messageId: 'message-2', content: 'Read this' };
    const { container, rerender } = render(wrap(<TTS {...props} isLast={false} />));
    const audio = container.querySelector('audio');
    audio?.setAttribute('src', 'blob:speech');

    rerender(wrap(<TTS {...props} isLast={true} />));

    expect(audio?.getAttribute('src')).toBe('blob:speech');
  });
});
