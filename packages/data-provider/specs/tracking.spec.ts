import { productTrackingConfigSchema } from '../src/config';
import { productEventSchema, safelyTrack, getProductTrackingConfig } from '../src/tracking';

const event = {
  version: 1,
  eventId: '0a988550-4e78-4b41-a3ed-2de32758ce0d',
  occurredAt: '2026-11-13T12:00:00.000Z',
  producer: 'browser',
  identity: { userId: 'user-1', tenantId: 'tenant-1' },
  fact: {
    name: 'librechat.feature.observed',
    feature: 'skills',
    observation: 'opened',
    entryPoint: 'panel',
  },
};

describe('product tracking boundary', () => {
  it('accepts content-free browser observations', () => {
    expect(productEventSchema.parse(event)).toEqual(event);
  });

  it.each(['text', 'title', 'sql', 'url', 'error', 'toolArguments'])(
    'rejects an unapproved %s field',
    (field) => {
      expect(
        productEventSchema.safeParse({ ...event, fact: { ...event.fact, [field]: 'private' } })
          .success,
      ).toBe(false);
    },
  );

  it('rejects server outcomes submitted as browser observations', () => {
    expect(
      productEventSchema.safeParse({
        ...event,
        fact: { name: 'librechat.langfuse.connection.changed', enabled: true, configured: true },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown versions and device context on server events', () => {
    expect(productEventSchema.safeParse({ ...event, version: 2 }).success).toBe(false);
    expect(
      productEventSchema.safeParse({
        ...event,
        producer: 'server',
        fact: { name: 'librechat.langfuse.connection.changed', enabled: true, configured: true },
        device: { type: 'phone', browser: 'Safari', os: 'iOS' },
      }).success,
    ).toBe(false);
  });

  it('records once without awaiting delivery', () => {
    const recorded: (typeof event)[] = [];
    safelyTrack((value) => {
      recorded.push(value);
    }, event);
    expect(recorded).toEqual([event]);
  });

  it('isolates sync and async delivery failures', async () => {
    expect(() =>
      safelyTrack(() => {
        throw new Error('offline');
      }, event),
    ).not.toThrow();
    safelyTrack(() => Promise.reject(new Error('offline')), event);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(() => safelyTrack(undefined, event)).not.toThrow();
  });
});

describe('deployment product tracking policy', () => {
  it.each([undefined, {}, { productTracking: {} }, { productTracking: { enabled: false } }])(
    'publishes disabled for %p',
    (telemetry) => expect(getProductTrackingConfig(telemetry)).toMatchObject({ enabled: false }),
  );

  it('publishes the explicit switch and session defaults', () => {
    expect(
      getProductTrackingConfig({ productTracking: { enabled: true }, rum: { enabled: true } }),
    ).toEqual({
      enabled: true,
      session: { shareAcrossTabs: true, idleTimeoutMs: 1800000, activityIntervalMs: 60000 },
    });
  });
});

it('preserves only approved correlation fields', () => {
  const context = {
    sessionId: 'd79706cc-4ddf-4cf7-b99a-333755af9be8',
    submissionId: '1b7ff690-8b9b-4af6-b68d-9cab4a5f2f21',
  };
  expect(productEventSchema.parse({ ...event, context }).context).toEqual(context);
  expect(
    productEventSchema.safeParse({ ...event, context: { ...context, text: 'private' } }).success,
  ).toBe(false);
  expect(
    productEventSchema.safeParse({ ...event, context: { sessionId: 'not-a-uuid' } }).success,
  ).toBe(false);
});

it('accepts explicit session settings without enabling tracking', () => {
  expect(
    productTrackingConfigSchema.parse({ session: { shareAcrossTabs: false, idleTimeoutMs: 1000 } }),
  ).toEqual({
    enabled: false,
    session: { shareAcrossTabs: false, idleTimeoutMs: 1000, activityIntervalMs: 60000 },
  });
});

it.each([0, -1, 0.5, 2147483648])('rejects an invalid idle timeout %s', (idleTimeoutMs) => {
  expect(productTrackingConfigSchema.safeParse({ session: { idleTimeoutMs } }).success).toBe(false);
});

describe('agent save facts', () => {
  const saved = {
    ...event,
    producer: 'server',
    fact: {
      name: 'librechat.agents.saved',
      feature: 'agents',
      agentId: 'agent-1',
      promptGroupId: 'prompt-b',
      skillIds: ['skill-1'],
    },
  };
  it('accepts attached IDs and explicitly empty attachments', () => {
    expect(productEventSchema.parse(saved)).toEqual(saved);
    expect(
      productEventSchema.safeParse({
        ...saved,
        fact: { ...saved.fact, promptGroupId: null, skillIds: [] },
      }).success,
    ).toBe(true);
  });
  it('rejects browser claims and content in a save fact', () => {
    expect(productEventSchema.safeParse({ ...saved, producer: 'browser' }).success).toBe(false);
    expect(
      productEventSchema.safeParse({ ...saved, fact: { ...saved.fact, text: 'private' } }).success,
    ).toBe(false);
  });
});
