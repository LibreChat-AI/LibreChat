import axios from 'axios';
import type { InternalAxiosRequestConfig } from 'axios';
import { createModerationCheck } from './moderation';

test('uses configured credentials and all inputs, rejects malformed replies, and respects disabled moderation', async () => {
  const calls: InternalAxiosRequestConfig[] = [];
  let data: object = { results: [{ flagged: false }, { flagged: true }] };
  const http = axios.create({
    adapter: async (config) => {
      calls.push(config);
      return { config, data, status: 200, statusText: 'OK', headers: {} };
    },
  });
  const environment = {
    OPENAI_MODERATION: 'true',
    OPENAI_MODERATION_REVERSE_PROXY: 'https://moderation.example/check',
    OPENAI_MODERATION_API_KEY: 'existing-key',
  };
  const moderate = createModerationCheck({ http, environment });
  expect(await moderate(['prompt', 'negative prompt'])).toBe(true);
  expect(calls[0].url).toBe(environment.OPENAI_MODERATION_REVERSE_PROXY);
  expect(calls[0].headers.Authorization).toBe('Bearer existing-key');
  expect(JSON.parse(calls[0].data).input).toEqual(['prompt', 'negative prompt']);
  data = { results: [{ flagged: 'invalid' }] };
  await expect(moderate(['prompt'])).rejects.toThrow();
  environment.OPENAI_MODERATION = 'false';
  expect(await moderate(['prompt'])).toBe(false);
  expect(calls).toHaveLength(2);
});

test('preserves chat moderation semantics for an empty provider result and still blocks flagged input', async () => {
  const http = axios.create();
  const response = jest.spyOn(http, 'post').mockResolvedValue({ data: { results: [] } });
  const moderate = createModerationCheck({
    http,
    environment: { OPENAI_MODERATION: 'true', OPENAI_MODERATION_API_KEY: 'fixture-key' },
  });
  await expect(moderate(['question'])).resolves.toBe(false);
  response.mockResolvedValue({ data: { results: [{ flagged: true }] } });
  await expect(moderate(['blocked question'])).resolves.toBe(true);
  expect(response).toHaveBeenCalledTimes(2);
});
