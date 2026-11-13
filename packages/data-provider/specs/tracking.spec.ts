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
    (telemetry) => expect(getProductTrackingConfig(telemetry)).toEqual({ enabled: false }),
  );

  it('publishes only the explicit switch', () => {
    expect(
      getProductTrackingConfig({ productTracking: { enabled: true }, rum: { enabled: true } }),
    ).toEqual({ enabled: true });
  });
});
