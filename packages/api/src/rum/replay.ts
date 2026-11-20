import { z } from 'zod';
import { Reader, Writer } from 'protobufjs/minimal';

const attributeSchema = z.object({ key: z.string() }).passthrough();
const logsSchema = z
  .object({
    resourceLogs: z
      .array(
        z
          .object({
            resource: z.unknown().optional(),
            schemaUrl: z.string().optional(),
            scopeLogs: z
              .array(
                z
                  .object({
                    schemaUrl: z.string().optional(),
                    scope: z.object({ name: z.string().optional() }).passthrough().optional(),
                    logRecords: z
                      .array(
                        z
                          .object({
                            attributes: z.array(attributeSchema).optional(),
                          })
                          .passthrough(),
                      )
                      .optional(),
                  })
                  .strict(),
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const isReplayScope = (name: string | undefined): boolean => name === 'rum.rr-web';

type FilteredMessage = { bytes: Uint8Array; records: number; removed: number };

/** Preserve unknown protobuf fields byte-for-byte; inspect only OTLP's nested log-record fields. */
function filterMessage(
  bytes: Uint8Array,
  field: number,
  filter: (value: Uint8Array) => FilteredMessage,
): FilteredMessage {
  const reader = Reader.create(bytes);
  const parts: Uint8Array[] = [];
  let records = 0;
  let removed = 0;
  while (reader.pos < reader.len) {
    const start = reader.pos;
    const tag = reader.uint32();
    if (tag >>> 3 === 0) throw new Error('Invalid protobuf field');
    if (tag >>> 3 === field) {
      if ((tag & 7) !== 2) throw new Error('Invalid protobuf wire type');
      const result = filter(reader.bytes());
      records += result.records;
      removed += result.removed;
      if (result.removed === 0) {
        parts.push(bytes.subarray(start, reader.pos));
      } else if (result.records > 0) {
        parts.push(Writer.create().uint32(tag).bytes(result.bytes).finish());
      }
    } else {
      reader.skipType(tag & 7);
      parts.push(bytes.subarray(start, reader.pos));
    }
  }
  return { bytes: Buffer.concat(parts), records, removed };
}

function stringField(bytes: Uint8Array, field: number): string | undefined {
  const reader = Reader.create(bytes);
  let result: string | undefined;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === 0) throw new Error('Invalid protobuf field');
    if (tag >>> 3 === field) {
      if ((tag & 7) !== 2) throw new Error('Invalid protobuf wire type');
      result = reader.string();
    } else {
      reader.skipType(tag & 7);
    }
  }
  return result;
}

function filterRecord(bytes: Uint8Array): FilteredMessage {
  let replay = false;
  // OTLP LogRecord.attributes = field 6; KeyValue.key = field 1.
  filterMessage(bytes, 6, (attribute) => {
    replay ||= stringField(attribute, 1)?.startsWith('rr-web.') ?? false;
    return { bytes: attribute, records: 1, removed: 0 };
  });
  return { bytes, records: replay ? 0 : 1, removed: replay ? 1 : 0 };
}

function filterScope(bytes: Uint8Array): FilteredMessage {
  const reader = Reader.create(bytes);
  let replay = false;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    if (tag >>> 3 === 0) throw new Error('Invalid protobuf field');
    if (tag >>> 3 === 1) {
      if ((tag & 7) !== 2) throw new Error('Invalid protobuf wire type');
      const scope = reader.bytes();
      replay ||= isReplayScope(stringField(scope, 1));
    } else {
      reader.skipType(tag & 7);
    }
  }
  // ScopeLogs.logRecords = field 2.
  return filterMessage(bytes, 2, (record) =>
    replay ? { bytes: record, records: 0, removed: 1 } : filterRecord(record),
  );
}

/** Fail closed on malformed logs. Mixed batches retain ordinary records and their resource metadata. */
export function filterReplayLogs(
  body: Buffer | string,
  contentType: string,
): { ok: true; body?: Buffer | string } | { ok: false } {
  try {
    if (contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      // ExportLogsServiceRequest.resourceLogs = 1; ResourceLogs.scopeLogs = 2.
      const result = filterMessage(bytes, 1, (resource) => filterMessage(resource, 2, filterScope));
      if (result.removed === 0) return { ok: true, body };
      return {
        ok: true,
        body: result.records > 0 ? Buffer.from(result.bytes) : undefined,
      };
    }

    const parsed = logsSchema.safeParse(JSON.parse(body.toString()));
    if (!parsed.success) return { ok: false };
    let removed = 0;
    let records = 0;
    for (const resource of parsed.data.resourceLogs ?? []) {
      for (const scope of resource.scopeLogs ?? []) {
        scope.logRecords = scope.logRecords?.filter((record) => {
          const replay =
            isReplayScope(scope.scope?.name) ||
            record.attributes?.some((attribute) => attribute.key.startsWith('rr-web.'));
          if (replay) {
            removed++;
            return false;
          }
          records++;
          return true;
        });
      }
    }
    if (removed === 0) return { ok: true, body };
    return { ok: true, body: records > 0 ? JSON.stringify(parsed.data) : undefined };
  } catch {
    return { ok: false };
  }
}
