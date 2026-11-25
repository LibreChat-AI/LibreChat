import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import cleanupUser from '../../../setup/cleanupUser';
import type { User } from '../../../types';

/**
 * `rateLimits` in librechat.yaml is applied during startup, and the speech routes
 * build their limiters when their module loads. The harness sets `userMax: 2` for
 * `stt` and `tts` in the yaml only, against a built-in default of 50, so the third
 * request from a fresh user is refused only when the yaml budget reached the
 * limiter.
 */

const YAML_USER_MAX = 2;

async function registerAndLogin(request: APIRequestContext, user: User): Promise<string> {
  const registerResponse = await request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const loginResponse = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const { token } = (await loginResponse.json()) as { token?: string };
  if (!token) {
    throw new Error('Expected login response to include a bearer token');
  }
  return token;
}

test.describe('rate limits from librechat.yaml', () => {
  test('the speech routes enforce the yaml budget @scenario:yaml-rate-limits-reach-speech-limiters', async ({
    request,
  }) => {
    const user: User = {
      email: `yaml-rate-limits-${randomUUID()}@example.com`,
      name: 'Yaml Rate Limits',
      password: 'securepassword123',
    };

    try {
      const token = await registerAndLogin(request, user);
      const headers = { Authorization: `Bearer ${token}` };

      for (const lane of ['stt', 'tts'] as const) {
        const statuses: number[] = [];
        let body: { message?: string } = {};
        for (let attempt = 0; attempt <= YAML_USER_MAX; attempt++) {
          const response = await request.post(`/api/files/speech/${lane}`, {
            headers,
            data: { input: 'hello' },
          });
          statuses.push(response.status());
          if (response.status() === 429) {
            body = (await response.json()) as { message?: string };
          }
        }

        expect(statuses.slice(0, YAML_USER_MAX)).not.toContain(429);
        expect(statuses[YAML_USER_MAX]).toBe(429);
        expect(body.message).toBe(`Too many ${lane.toUpperCase()} requests. Try again later`);
      }
    } finally {
      await cleanupUser(user);
    }
  });
});
