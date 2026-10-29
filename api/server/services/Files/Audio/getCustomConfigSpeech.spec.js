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
        sttRealtime: false,
        ttsExternal: false,
        engineSTT: 'external',
      });
    },
  );

  it('advertises live transcription when the OpenAI provider configures a realtime model', async () => {
    const req = {
      config: {
        speech: {
          stt: {
            openai: {
              apiKey: 'sk',
              model: 'gpt-transcribe',
              realtime: { model: 'gpt-live-transcribe' },
            },
          },
          speechTab: { speechToText: { engineSTT: 'realtime' } },
        },
      },
    };
    const res = createResponse();

    await getCustomConfigSpeech(req, res);

    expect(res.send).toHaveBeenCalledWith({
      sttExternal: true,
      sttRealtime: true,
      ttsExternal: false,
      engineSTT: 'realtime',
    });
  });

  it.each([
    ['without a realtime block', { openai: { apiKey: 'sk', model: 'gpt-transcribe' } }],
    [
      'for Azure OpenAI',
      { azureOpenAI: { apiKey: 'sk', instanceName: 'i', deploymentName: 'd', apiVersion: 'v' } },
    ],
  ])('does not advertise live transcription %s', async (_label, stt) => {
    const res = createResponse();

    await getCustomConfigSpeech({ config: { speech: { stt } } }, res);

    expect(res.send).toHaveBeenCalledWith({
      sttExternal: true,
      sttRealtime: false,
      ttsExternal: false,
    });
  });

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
        sttRealtime: false,
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
