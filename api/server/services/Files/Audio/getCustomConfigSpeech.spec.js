jest.mock('@librechat/data-schemas', () => ({ logger: { error: jest.fn() } }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));

const getCustomConfigSpeech = require('./getCustomConfigSpeech');

const createResponse = () => {
  const res = {
    send: jest.fn(),
    status: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
};

describe('getCustomConfigSpeech', () => {
  it.each(['openai', 'azureOpenAI'])(
    'normalizes the legacy STT provider "%s" to the external engine',
    async (engineSTT) => {
      const req = {
        config: {
          speech: {
            stt: { openai: {} },
            speechTab: { speechToText: { engineSTT } },
          },
        },
      };
      const res = createResponse();

      await getCustomConfigSpeech(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({
        sttExternal: true,
        ttsExternal: false,
        engineSTT: 'external',
      });
    },
  );

  it.each(['browser', 'external'])('preserves the runtime STT engine "%s"', async (engineSTT) => {
    const req = {
      config: {
        speech: {
          stt: { openai: {} },
          speechTab: { speechToText: { engineSTT } },
        },
      },
    };
    const res = createResponse();

    await getCustomConfigSpeech(req, res);

    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ engineSTT }));
  });

  it.each(['openai', 'azureOpenAI', 'elevenlabs', 'localai'])(
    'normalizes the legacy TTS provider "%s" to the external engine',
    async (engineTTS) => {
      const req = {
        config: {
          speech: {
            tts: { openai: {} },
            speechTab: { textToSpeech: { engineTTS } },
          },
        },
      };
      const res = createResponse();

      await getCustomConfigSpeech(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.send).toHaveBeenCalledWith({
        sttExternal: false,
        ttsExternal: true,
        engineTTS: 'external',
      });
    },
  );

  it.each(['browser', 'external'])('preserves the runtime TTS engine "%s"', async (engineTTS) => {
    const req = {
      config: {
        speech: {
          tts: { openai: {} },
          speechTab: { textToSpeech: { engineTTS } },
        },
      },
    };
    const res = createResponse();

    await getCustomConfigSpeech(req, res);

    expect(res.send).toHaveBeenCalledWith(expect.objectContaining({ engineTTS }));
  });
});
