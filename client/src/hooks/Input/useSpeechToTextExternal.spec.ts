import { getBestSupportedMimeType } from './useSpeechToTextExternal';

const preferredMimeTypes = [
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/mp4',
];

describe('getBestSupportedMimeType', () => {
  it.each(
    preferredMimeTypes.map((expected, index) => ({
      expected,
      supportedTypes: new Set(preferredMimeTypes.slice(index)),
      probedTypes: preferredMimeTypes.slice(0, index + 1),
    })),
  )(
    'selects $expected before lower-priority formats',
    ({ expected, supportedTypes, probedTypes }) => {
      const isTypeSupported = jest.fn((type: string) => supportedTypes.has(type));

      expect(getBestSupportedMimeType(isTypeSupported, 'test browser')).toBe(expected);
      expect(isTypeSupported.mock.calls.map(([type]) => type)).toEqual(probedTypes);
    },
  );

  it.each([
    ['Safari', 'Mozilla/5.0 Version/17.0 Safari/605.1.15', 'audio/mp4'],
    ['Firefox', 'Mozilla/5.0 Firefox/128.0', 'audio/ogg'],
    ['Chrome', 'Mozilla/5.0 Chrome/128.0 Safari/537.36', 'audio/webm'],
    ['an unknown browser', 'test browser', 'audio/webm'],
  ])('falls back to %s defaults when no format is supported', (_browser, userAgent, expected) => {
    const isTypeSupported = jest.fn((_type: string) => false);

    expect(getBestSupportedMimeType(isTypeSupported, userAgent)).toBe(expected);
    expect(isTypeSupported.mock.calls.map(([type]) => type)).toEqual(preferredMimeTypes);
  });
});
