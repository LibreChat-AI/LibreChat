import { z } from 'zod';
import { updateSchedulePayloadSchema } from './types/schedules';
import { partialWithoutDefaults } from './zod';
import { configSchema } from './config';

describe('partialWithoutDefaults', () => {
  const schema = z
    .object({
      enabled: z.boolean().default(true),
      mode: z.enum(['a', 'b']).prefault('a'),
      name: z.string(),
    })
    .strict();

  it('leaves omitted fields absent instead of filling their defaults', () => {
    expect(partialWithoutDefaults(schema).parse({})).toEqual({});
    expect(partialWithoutDefaults(schema).parse({ name: 'x' })).toEqual({ name: 'x' });
  });

  it('still validates the fields that are sent and keeps the object config', () => {
    expect(partialWithoutDefaults(schema).parse({ enabled: false })).toEqual({ enabled: false });
    expect(partialWithoutDefaults(schema).safeParse({ enabled: 'yes' }).success).toBe(false);
    expect(partialWithoutDefaults(schema).safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('optional sections with defaults', () => {
  it('does not re-enable or retarget a schedule on a partial update', () => {
    expect(updateSchedulePayloadSchema.parse({ name: 'renamed' })).toEqual({ name: 'renamed' });
  });

  it('leaves unset config sections absent', () => {
    const parsed = configSchema.parse({
      version: '1.0.0',
      endpoints: { custom: [] },
      rateLimits: {},
      turnstile: { siteKey: 'key' },
      registration: { openidDiscovery: { startupAttempts: 3 } },
    });
    expect(parsed.endpoints?.agents).toBeUndefined();
    expect(parsed.rateLimits?.mcpApps).toBeUndefined();
    expect(parsed.turnstile?.options).toBeUndefined();
    expect(parsed.registration?.openidDiscovery).toEqual({ startupAttempts: 3 });
  });
});
