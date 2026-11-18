import { RecoilRoot } from 'recoil';
import { ToastContext } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { SpeechInputPresetSetting as Preset } from '../../Settings/SpeechControls';
import { render, screen, waitFor } from 'test/layout-test-utils';
import store from '~/store';

const showToast = jest.fn();

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function setup(speechToText = true, textToSpeech = true) {
  localStorage.setItem('autoTranscribeAudio', 'false');
  localStorage.setItem('autoSendText', '8');
  localStorage.setItem('decibelValue', '-60');
  localStorage.setItem('automaticPlayback', 'false');
  localStorage.setItem('conversationMode', 'true');

  render(
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.speechToText, speechToText);
        set(store.textToSpeech, textToSpeech);
      }}
    >
      <ToastContext.Provider value={{ showToast }}>
        <Preset />
      </ToastContext.Provider>
    </RecoilRoot>,
  );
  return screen.getByRole('button', { name: 'com_nav_apply_speech_input_preset' });
}

describe('speech input preset', () => {
  beforeEach(() => localStorage.clear());

  it('keeps custom settings until explicitly applied, ignoring the old mode flag', () => {
    const button = setup();

    expect(button).toBeEnabled();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(button).toHaveAccessibleDescription(
      'com_nav_speech_input_preset com_nav_info_speech_input_preset',
    );
    expect(localStorage.getItem('autoTranscribeAudio')).toBe('false');
    expect(localStorage.getItem('autoSendText')).toBe('8');
    expect(localStorage.getItem('decibelValue')).toBe('-60');
  });

  it.each([true, false])(
    'applies and persists the preset without enabling playback (TTS=%s)',
    async (tts) => {
      const button = setup(true, tts);
      await userEvent.tab();
      expect(button).toHaveFocus();
      await userEvent.keyboard('{Enter}');

      await waitFor(() => {
        expect(localStorage.getItem('autoTranscribeAudio')).toBe('true');
        expect(localStorage.getItem('autoSendText')).toBe('3');
        expect(localStorage.getItem('decibelValue')).toBe('-45');
      });
      expect(localStorage.getItem('automaticPlayback')).toBe('false');
      expect(showToast).toHaveBeenCalledWith({ message: 'com_nav_speech_input_preset_applied' });

      await userEvent.click(button);
      expect(localStorage.getItem('autoTranscribeAudio')).toBe('true');
      expect(localStorage.getItem('autoSendText')).toBe('3');
      expect(localStorage.getItem('decibelValue')).toBe('-45');
    },
  );

  it.each([
    [false, true],
    [false, false],
  ])('is disabled with STT=%s and TTS=%s', async (stt, tts) => {
    const button = setup(stt, tts);
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(localStorage.getItem('autoTranscribeAudio')).toBe('false');
    expect(localStorage.getItem('autoSendText')).toBe('8');
    expect(localStorage.getItem('decibelValue')).toBe('-60');
  });
});
