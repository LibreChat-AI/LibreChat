import { parse, Writer } from 'protobufjs';
import { filterReplayLogs } from './replay';

const requestType = parse(`syntax = "proto3";
  message AnyValue { string stringValue = 1; }
  message KeyValue { string key = 1; AnyValue value = 2; }
  message Scope { string name = 1; }
  message LogRecord { string severityText = 3; AnyValue body = 5; repeated KeyValue attributes = 6; }
  message ScopeLogs { Scope scope = 1; repeated LogRecord logRecords = 2; string schemaUrl = 3; }
  message ResourceLogs { repeated ScopeLogs scopeLogs = 2; string schemaUrl = 3; }
  message ExportLogsServiceRequest { repeated ResourceLogs resourceLogs = 1; }
`).root.lookupType('ExportLogsServiceRequest');

const ordinary = {
  severityText: 'ERROR',
  body: { stringValue: 'ordinary-client-error' },
  attributes: [{ key: 'route', value: { stringValue: '/c/new' } }],
};
const replay = {
  body: { stringValue: 'private-replay-snapshot' },
  attributes: [{ key: 'rr-web.event', value: { stringValue: '2' } }],
};
const batch = (records = [ordinary, replay], name = 'browser') => ({
  resourceLogs: [{ schemaUrl: 'schema', scopeLogs: [{ scope: { name }, logRecords: records }] }],
});

describe.each(['json', 'protobuf', 'octet-stream'] as const)(
  'replay-off %s filtering',
  (encoding) => {
    const contentType =
      encoding === 'json'
        ? 'application/json'
        : `application/${encoding === 'protobuf' ? 'x-protobuf' : encoding}`;
    const encode = (value: ReturnType<typeof batch>) =>
      encoding === 'json'
        ? JSON.stringify(value)
        : Buffer.from(requestType.encode(requestType.create(value)).finish());
    const decode = (value: Buffer | string) =>
      encoding === 'json'
        ? JSON.parse(value.toString())
        : requestType.toObject(requestType.decode(Buffer.from(value)));

    it('drops replay-only batches without forwarding their content', () => {
      expect(filterReplayLogs(encode(batch([replay])), contentType)).toEqual({
        ok: true,
        body: undefined,
      });
    });

    it('preserves ordinary records and envelope metadata in mixed batches', () => {
      const result = filterReplayLogs(encode(batch()), contentType);
      expect(result.ok).toBe(true);
      if (!result.ok || !result.body) throw new Error('Expected ordinary log batch');
      expect(decode(result.body)).toEqual(batch([ordinary]));
      expect(result.body.toString()).not.toContain('private-replay-snapshot');
    });

    it('preserves replay-free payloads byte-for-byte', () => {
      const body = encode(batch([ordinary]));
      expect(filterReplayLogs(body, contentType)).toEqual({ ok: true, body });
    });

    it('drops recorder scopes even when a record has no rr-web attributes', () => {
      expect(filterReplayLogs(encode(batch([ordinary], 'rum.rr-web')), contentType)).toEqual({
        ok: true,
        body: undefined,
      });
    });

    it('removes the SDK recorder scope while retaining ordinary scopes', () => {
      const data = batch([ordinary]);
      data.resourceLogs[0].scopeLogs.push({
        scope: { name: 'rum.rr-web' },
        logRecords: [ordinary],
      });
      const result = filterReplayLogs(encode(data), contentType);
      if (!result.ok || !result.body) throw new Error('Expected ordinary log batch');
      const decoded = decode(result.body);
      if (encoding === 'json') {
        expect(decoded.resourceLogs[0].scopeLogs[0].logRecords).toEqual([ordinary]);
        expect(decoded.resourceLogs[0].scopeLogs[1].logRecords).toEqual([]);
      } else {
        expect(decoded).toEqual(batch([ordinary]));
      }
    });
  },
);

it.each(['not json', '{"resourceLogs":[{"scope_logs":[]}]}', '{"resource_logs":[]}'])(
  'rejects malformed or noncanonical JSON envelopes: %s',
  (body) => {
    expect(filterReplayLogs(body, 'application/json')).toEqual({ ok: false });
  },
);

it.each([Buffer.from([0]), Buffer.from([10, 255]), Buffer.from([8, 1])])(
  'rejects malformed protobuf rather than forwarding opaque logs',
  (body) => {
    expect(filterReplayLogs(body, 'application/x-protobuf')).toEqual({ ok: false });
  },
);

it('preserves unknown protobuf fields and untouched resources', () => {
  const original = Buffer.from(requestType.encode(requestType.create(batch([ordinary]))).finish());
  const extra = Buffer.from(Writer.create().uint32(120).uint32(7).finish());
  const body = Buffer.concat([original, extra]);
  expect(filterReplayLogs(body, 'application/x-protobuf')).toEqual({ ok: true, body });
});

it('preserves unknown protobuf fields when removing a replay from a mixed batch', () => {
  const original = Buffer.from(requestType.encode(requestType.create(batch())).finish());
  const extra = Buffer.from(Writer.create().uint32(120).uint32(7).finish());
  const result = filterReplayLogs(Buffer.concat([original, extra]), 'application/x-protobuf');
  if (!result.ok || !result.body) throw new Error('Expected ordinary log batch');
  const expected = Buffer.from(requestType.encode(requestType.create(batch([ordinary]))).finish());
  expect(result.body).toEqual(Buffer.concat([expected, extra]));
});
