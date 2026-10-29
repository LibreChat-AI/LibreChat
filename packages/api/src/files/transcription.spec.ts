import http from 'http';
import axios from 'axios';
import { Readable } from 'stream';
import { logger } from '@librechat/data-schemas';
import type { AddressInfo } from 'net';
import {
  getTranscriptionHints,
  usesTranscriptionHints,
  normalizeTranscriptionLanguage,
} from './transcription';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const hintConfig = {
  prompt: '  A support call about LibreChat.  ',
  keywords: ['LibreChat', 'OpenShift'],
  languages: ['de', 'EN'],
};

describe('usesTranscriptionHints', () => {
  it.each([
    'gpt-transcribe',
    'gpt-live-transcribe',
    'gpt-transcribe-2026-03-01',
    'GPT-Transcribe',
    'openai/gpt-transcribe',
  ])('treats %s as a hint model', (model) => {
    expect(usesTranscriptionHints(model)).toBe(true);
  });

  it.each([
    'whisper-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-transcribe',
    'gpt-4o-transcribe-diarize',
    'gpt-transcriber',
    '',
    undefined,
    null,
  ])('treats %s as a legacy model', (model) => {
    expect(usesTranscriptionHints(model)).toBe(false);
  });
});

describe('normalizeTranscriptionLanguage', () => {
  it('reduces locales to ISO 639-1 for legacy models', () => {
    expect(normalizeTranscriptionLanguage('en-US', false)).toBe('en');
    expect(normalizeTranscriptionLanguage('zh-TW', false)).toBe('zh');
    expect(normalizeTranscriptionLanguage('yue', false)).toBeUndefined();
  });

  it('keeps regional Chinese and ISO 639-3 codes for hint models', () => {
    expect(normalizeTranscriptionLanguage('zh-TW', true)).toBe('zh-tw');
    expect(normalizeTranscriptionLanguage('zh-HK', true)).toBe('zh-hk');
    expect(normalizeTranscriptionLanguage('pt-br', true)).toBe('pt');
    expect(normalizeTranscriptionLanguage('yue', true)).toBe('yue');
  });

  it.each(['xx-piglatin', 'en_US', 'english', 'PRIVATE@example.com'])(
    'drops %s instead of sending it',
    (language) => {
      expect(normalizeTranscriptionLanguage(language, true)).toBeUndefined();
      expect(normalizeTranscriptionLanguage(language, false)).toBeUndefined();
    },
  );

  it('does not log the submitted value it drops', () => {
    const submitted = 'PRIVATE-LANGUAGE@example.com';

    normalizeTranscriptionLanguage(submitted, true);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid language format'));
    expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain(submitted);
  });

  it('ignores an empty language', () => {
    expect(normalizeTranscriptionLanguage('', true)).toBeUndefined();
    expect(normalizeTranscriptionLanguage(undefined, false)).toBeUndefined();
  });
});

describe('getTranscriptionHints', () => {
  it('sends languages, keywords, and prompt to gpt-transcribe and never the singular language', () => {
    const hints = getTranscriptionHints(hintConfig, 'gpt-transcribe');

    expect(hints).toEqual({
      prompt: 'A support call about LibreChat.',
      keywords: ['LibreChat', 'OpenShift'],
      languages: ['de', 'en'],
    });
    expect(hints).not.toHaveProperty('language');
  });

  it("narrows the admin languages to the user's language", () => {
    expect(getTranscriptionHints(hintConfig, 'gpt-transcribe', 'en-GB').languages).toEqual(['en']);
    expect(getTranscriptionHints(hintConfig, 'gpt-transcribe', 'zh-TW').languages).toEqual([
      'zh-tw',
    ]);
  });

  it('falls back to the admin languages when the user language is not a language code', () => {
    expect(getTranscriptionHints(hintConfig, 'gpt-transcribe', 'xx-piglatin').languages).toEqual([
      'de',
      'en',
    ]);
  });

  it('sends the user language as languages[] even without admin hints', () => {
    expect(getTranscriptionHints(undefined, 'gpt-transcribe', 'fr-FR')).toEqual({
      languages: ['fr'],
    });
  });

  it('omits empty hint fields', () => {
    expect(
      getTranscriptionHints({ prompt: '   ', keywords: [], languages: [] }, 'gpt-transcribe'),
    ).toEqual({});
  });

  it.each(['whisper-1', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe'])(
    'keeps the singular language for %s and drops hints it would reject',
    (model) => {
      const hints = getTranscriptionHints(hintConfig, model, 'en-US');

      expect(hints).toEqual({ prompt: 'A support call about LibreChat.', language: 'en' });
      expect(hints).not.toHaveProperty('languages');
      expect(hints).not.toHaveProperty('keywords');
    },
  );

  it('leaves a legacy request unchanged when no hints are configured', () => {
    expect(getTranscriptionHints(undefined, 'whisper-1')).toEqual({});
    expect(getTranscriptionHints({}, 'whisper-1', 'de-DE')).toEqual({ language: 'de' });
  });
});

describe('multipart serialization', () => {
  let server: http.Server;
  let url: string;
  let received: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = Buffer.concat(chunks).toString('utf8');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: 'ok' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/audio/transcriptions`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const fieldValues = (name: string) =>
    [
      ...received.matchAll(
        new RegExp(`name="${name.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)`, 'g'),
      ),
    ].map((match) => match[1]);

  it('posts array hints as the repeated languages[] and keywords[] fields OpenAI documents', async () => {
    const file = Readable.from(Buffer.from('audio'));
    Object.assign(file, { path: 'audio.webm' });

    await axios.post(
      url,
      { file, model: 'gpt-transcribe', ...getTranscriptionHints(hintConfig, 'gpt-transcribe') },
      { headers: { 'Content-Type': 'multipart/form-data' }, proxy: false },
    );

    expect(fieldValues('languages[]')).toEqual(['de', 'en']);
    expect(fieldValues('keywords[]')).toEqual(['LibreChat', 'OpenShift']);
    expect(fieldValues('prompt')).toEqual(['A support call about LibreChat.']);
    expect(fieldValues('language')).toEqual([]);
  });
});
