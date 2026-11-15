import { generateKeyPairSync, sign } from 'node:crypto';
import { normalizeDiscordCommand, parseDiscordInteraction, verifyDiscordSignature } from './events';

const command = {
  id: '123',
  application_id: '456',
  token: 'private',
  version: 1,
  type: 2,
  guild_id: '789',
  context: 0,
  authorizing_integration_owners: { '0': '789' },
  channel_id: '321',
  member: { user: { id: '654' } },
  data: { id: '987', name: 'ask', options: [{ name: 'prompt', type: 3, value: ' Hello ' }] },
};
describe('Discord interaction ingress', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('hex');
  const body = Buffer.from(JSON.stringify(command));
  const timestamp = '1700000000';
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    keys.privateKey,
  ).toString('hex');
  const policy = {
    publicKey,
    maxBodyBytes: 4096,
    maxAgeMs: 300_000,
    now: Number(timestamp) * 1000,
  };
  test('verifies exact bytes and timestamp with Ed25519', () => {
    expect(verifyDiscordSignature(body, signature, timestamp, policy)).toBe(true);
    expect(
      verifyDiscordSignature(Buffer.concat([body, Buffer.from(' ')]), signature, timestamp, policy),
    ).toBe(false);
    expect(
      verifyDiscordSignature(body, signature, timestamp, { ...policy, now: policy.now + 300_001 }),
    ).toBe(false);
    expect(
      verifyDiscordSignature(body, signature, timestamp, { ...policy, now: policy.now - 300_001 }),
    ).toBe(false);
    expect(verifyDiscordSignature(body, signature, timestamp, { ...policy, maxBodyBytes: 1 })).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, 'invalid', timestamp, policy)).toBe(false);
    expect(
      verifyDiscordSignature(body, signature, timestamp, { ...policy, publicKey: 'bad' }),
    ).toBe(false);
  });
  test('parses ping, commands, components and modal input without retaining unknown fields', () => {
    expect(parseDiscordInteraction(Buffer.from('{"type":1}'), 100)).toEqual({ type: 1 });
    expect(parseDiscordInteraction(body, 4096)).toEqual(command);
    expect(
      parseDiscordInteraction(
        Buffer.from(
          JSON.stringify({
            ...command,
            type: 3,
            data: { custom_id: 'review', component_type: 2 },
            untrusted: 'discard',
          }),
        ),
        4096,
      ),
    ).not.toHaveProperty('untrusted');
    const modal = {
      ...command,
      type: 5,
      data: {
        custom_id: 'review',
        components: [{ type: 1, components: [{ type: 4, custom_id: 'answer', value: 'yes' }] }],
      },
    };
    expect(parseDiscordInteraction(Buffer.from(JSON.stringify(modal)), 4096)).toEqual(modal);
    expect(() => parseDiscordInteraction(body, 1)).toThrow();
    expect(() => parseDiscordInteraction(Buffer.from([0xff]), 4096)).toThrow();
    expect(() => parseDiscordInteraction(Buffer.from('{"type":4}'), 100)).toThrow();
  });
  test.each([
    { context: 1 },
    { context: 2 },
    { context: undefined },
    { authorizing_integration_owners: undefined },
    { authorizing_integration_owners: { '1': '654' } },
    { authorizing_integration_owners: { '0': '0' } },
    { authorizing_integration_owners: { '0': '999' } },
  ])('rejects commands without matching guild installation authority: %j', (override) => {
    const parsed = parseDiscordInteraction(
      Buffer.from(JSON.stringify({ ...command, ...override })),
      4096,
    );
    expect(normalizeDiscordCommand(parsed, '456')).toBeNull();
  });
  test('accepts guild authority when both installations authorize the interaction', () => {
    const parsed = parseDiscordInteraction(
      Buffer.from(
        JSON.stringify({ ...command, authorizing_integration_owners: { '0': '789', '1': '654' } }),
      ),
      4096,
    );
    expect(normalizeDiscordCommand(parsed, '456')?.guildId).toBe('789');
  });
  test.each([
    { context: 3 },
    { context: '0' },
    { authorizing_integration_owners: { '0': 789 } },
    { authorizing_integration_owners: { '0': 'invalid' } },
  ])('rejects malformed authority metadata: %j', (override) => {
    expect(() =>
      parseDiscordInteraction(Buffer.from(JSON.stringify({ ...command, ...override })), 4096),
    ).toThrow();
  });
  test('normalizes guild slash commands with a fresh lane and interaction deduplication', () => {
    const parsed = parseDiscordInteraction(body, 4096);
    expect(normalizeDiscordCommand(parsed, '456')).toEqual({
      provider: 'discord',
      applicationId: '456',
      guildId: '789',
      externalUserId: '654',
      externalChannelId: '321',
      externalMessageKey: '321:123',
      externalThreadKey: '321:123',
      deduplicationKey: '123',
      input: 'Hello',
    });
    expect(normalizeDiscordCommand(parsed, 'other')).toBeNull();
    expect(
      normalizeDiscordCommand(
        parseDiscordInteraction(
          Buffer.from(JSON.stringify({ ...command, guild_id: undefined })),
          4096,
        ),
        '456',
      ),
    ).toBeNull();
    expect(
      normalizeDiscordCommand(
        parseDiscordInteraction(
          Buffer.from(JSON.stringify({ ...command, member: { user: { id: '654', bot: true } } })),
          4096,
        ),
        '456',
      ),
    ).toBeNull();
    expect(
      normalizeDiscordCommand(
        parseDiscordInteraction(Buffer.from(JSON.stringify({ ...command, id: '124' })), 4096),
        '456',
      )?.externalThreadKey,
    ).toBe('321:124');
  });
});
