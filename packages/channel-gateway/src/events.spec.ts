import { createHmac } from 'node:crypto';
import type { ChannelBundle } from './types';
import { eventTimestampUs, normalizeEvent, parseEnvelope, verifySignature } from './events';

const bundle: ChannelBundle = {
  channel: {
    channelId: 'binding',
    tenantId: 'tenant',
    agentId: 'agent',
    createdBy: 'owner',
    type: 'slack',
    status: 'active',
    credentialMode: 'per_user',
    revision: 'r1',
    slack: { teamId: 'T1', appId: 'A1', botUserId: 'B1' },
  },
  agent: { id: 'agent' },
  credentials: { botToken: 'test-bot', signingSecret: 'test-signing' },
};
const envelope = (event: object) => ({
  type: 'event_callback',
  event_id: 'E1',
  team_id: 'T1',
  api_app_id: 'A1',
  event: {
    type: 'app_mention',
    user: 'U1',
    channel: 'C1',
    ts: '1793000000.123456',
    text: '<@B1> hello',
    ...event,
  },
});
const normalize = (event: object) => normalizeEvent(parseEnvelope(envelope(event), bundle), bundle);

describe('Slack message normalization', () => {
  test('binds actor, admission identity and thread to the exact envelope', () => {
    expect(normalize({ thread_ts: '1792999999.654321' })).toEqual({
      kind: 'message',
      admission: {
        eventId: 'E1',
        externalChannelId: 'C1',
        externalThreadKey: 'C1:1792999999.654321',
        externalMessageKey: 'C1:1793000000.123456',
        actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
        input: 'hello',
      },
    });
  });
  test('new mentions use their message as the thread root; DMs require no mention', () => {
    expect(normalize({})).toMatchObject({
      admission: { externalThreadKey: 'C1:1793000000.123456' },
    });
    expect(normalize({ type: 'message', channel_type: 'im', text: 'hello' })).toMatchObject({
      kind: 'message',
      admission: { input: 'hello' },
    });
  });
  test.each([
    { user: undefined },
    { user: 'B1' },
    { bot_id: 'other-bot' },
    { subtype: 'message_changed' },
    { subtype: 'bot_message' },
    { type: 'message', channel_type: 'channel' },
    { text: '<@B1> ' },
    { channel: undefined },
    { ts: undefined },
  ])('ignores bot, subtype, unrelated or incomplete message %p', (event) =>
    expect(normalize(event)).toBeNull(),
  );
  test.each(['team_id', 'api_app_id'])('rejects another %s before normalization', (field) =>
    expect(() => parseEnvelope({ ...envelope({}), [field]: 'other' }, bundle)).toThrow(),
  );
  test('native Stop carries its actor and occurrence time, not receipt time', () => {
    expect(
      normalize({
        type: 'agent_session_stopped',
        thread_ts: '1792999999.5',
        event_ts: '1793000001.123456',
      }),
    ).toEqual({
      kind: 'stop',
      actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
      externalThreadKey: 'C1:1792999999.5',
      eventAt: 1793000001123,
    });
  });
  test('native Stop without actor is ignored and without thread/time is rejected', () => {
    expect(normalize({ type: 'agent_session_stopped', user: undefined })).toBeNull();
    expect(() => normalize({ type: 'agent_session_stopped' })).toThrow('Invalid native Stop');
  });
  test('reaction retains exact message handle and microsecond event ordering', () => {
    expect(
      normalize({
        type: 'reaction_removed',
        reaction: 'thumbsup',
        item: { type: 'message', channel: 'C9', ts: '1792999998.2' },
        event_ts: '1793000000.000001',
      }),
    ).toEqual({
      kind: 'reaction',
      reaction: {
        eventId: 'E1',
        eventTimestampUs: 1793000000000001,
        externalMessageKey: 'C9:1792999998.2',
        externalUserId: 'U1',
        reaction: 'thumbsup',
        action: 'removed',
      },
    });
    expect(
      normalize({
        type: 'reaction_added',
        reaction: 'thumbsup',
        item: { type: 'file', file: 'F1' },
        event_ts: '1793000000.1',
      }),
    ).toBeNull();
  });
});

describe('Slack request authenticity', () => {
  const body = Buffer.from('{"hello":"world"}');
  const timestamp = '1793000000';
  const signature =
    'v0=' +
    createHmac('sha256', 'test-secret').update(`v0:${timestamp}:`).update(body).digest('hex');
  test('verifies exact raw bytes and a fresh timestamp', () =>
    expect(verifySignature(body, signature, timestamp, 'test-secret', 300, 1793000000000)).toBe(
      true,
    ));
  test('rejects altered bytes, secret, expired or future timestamp', () => {
    expect(
      verifySignature(
        Buffer.from('changed'),
        signature,
        timestamp,
        'test-secret',
        300,
        1793000000000,
      ),
    ).toBe(false);
    expect(verifySignature(body, signature, timestamp, 'wrong', 300, 1793000000000)).toBe(false);
    expect(verifySignature(body, signature, timestamp, 'test-secret', 300, 1793000301000)).toBe(
      false,
    );
    expect(verifySignature(body, signature, timestamp, 'test-secret', 300, 1792999699000)).toBe(
      false,
    );
  });
  test.each(['v0=x', 'v1=' + 'a'.repeat(64), '', 'v0=' + 'A'.repeat(64)])(
    'rejects malformed signature %s without timing exception',
    (invalid) =>
      expect(verifySignature(body, invalid, timestamp, 'test-secret', 300, 1793000000000)).toBe(
        false,
      ),
  );
  test.each(['1', '-1.1', '1.1234567', '9999999999.123456', '0.0', 'nan'])(
    'rejects unsafe event timestamp %s',
    (value) => expect(() => eventTimestampUs(value)).toThrow(),
  );
  test('pads microseconds exactly without floating-point rounding', () =>
    expect(eventTimestampUs('1793000000.1')).toBe(1793000000100000));
});
