/** One provider fixture serves the mock journey and the Studio Lighthouse scenario. */
export const mediaFixturePort = process.env.E2E_MEDIA_PORT || '8768';
export const mediaFixtureURL = `http://127.0.0.1:${mediaFixturePort}`;
export function mediaFixtureConfig(enabled = true) {
  return {
    enabled,
    surfaces: { studio: true, chat: true, tools: true },
    integrations: enabled
      ? [
          {
            id: 'fixture-images',
            label: 'Local image fixture',
            api: 'openai.images',
            endpointRef: {
              kind: 'direct',
              apiKey: 'local-fixture-key',
              baseURL: `${mediaFixtureURL}/v1`,
            },
            catalog: { kind: 'configured', models: ['gpt-image-1', 'gpt-image-1-mini'] },
            operations: ['image.generate', 'image.edit'],
          },
          {
            id: 'fixture-videos',
            label: 'Local video fixture',
            api: 'openai.videos',
            endpointRef: {
              kind: 'direct',
              apiKey: 'local-fixture-key',
              baseURL: `${mediaFixtureURL}/v1`,
            },
            catalog: { kind: 'configured', models: ['sora-2'] },
            operations: ['video.generate'],
          },
          {
            id: 'fixture-native-google',
            label: 'Native Google fixture',
            api: 'google.generateContent',
            endpointRef: { kind: 'builtin', endpoint: 'google' },
            catalog: { kind: 'configured', models: ['gemini-3-pro-image-preview'] },
            operations: ['image.generate', 'image.edit'],
          },
        ]
      : [],
    polling: { providerIntervalMs: 500, clientIntervalMs: 500, clientCatchUpIntervalMs: 1000 },
  };
}
