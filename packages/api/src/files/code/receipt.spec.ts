import { createHash } from 'node:crypto';
import { FileContext } from 'librechat-data-provider';
import type { CodeEnvRef, TFile } from 'librechat-data-provider';
import {
  digestCodeUpload,
  getSnapshotReceipt,
  mountsStoredObjects,
  provesStoredContent,
} from './receipt';

const bytes = Buffer.from('captured bytes');
const content = digestCodeUpload(bytes);

function snapshot(ref: Partial<CodeEnvRef> = {}, sha256: string | undefined = content.sha256) {
  const pointer = {
    kind: 'user',
    id: 'user',
    storage_session_id: 'session',
    file_id: 'object',
    content,
    ...ref,
  } as CodeEnvRef;
  return {
    context: FileContext.execute_code_snapshot,
    metadata: {
      ...(sha256 ? { codeOutput: { messageId: 'message', sha256 } } : {}),
      codeEnvRefs: {
        [pointer.executionRouteKey ?? pointer.executionProfile ?? 'default']: pointer,
      },
    },
  } as Pick<TFile, 'context' | 'metadata'>;
}

describe('digestCodeUpload', () => {
  it('records the digests the record and the object store report', () => {
    expect(content).toEqual({
      sha256: createHash('sha256').update(bytes).digest('hex'),
      md5: createHash('md5').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  });
});

describe('getSnapshotReceipt', () => {
  it('returns the pointer whose upload digested the content the record still holds', () => {
    expect(getSnapshotReceipt(snapshot(), 'default')).toMatchObject({
      file_id: 'object',
      content,
    });
  });

  it.each([
    ['a pointer without a digest', snapshot({ content: undefined })],
    ['a digest of other content', snapshot({}, 'f'.repeat(64))],
    ['a record without a content version', snapshot({}, '')],
    ['a file that is not a snapshot', { ...snapshot(), context: FileContext.message_attachment }],
  ])('refuses %s', (_label, file) => {
    expect(getSnapshotReceipt(file, 'default')).toBeUndefined();
  });

  it('refuses every route that keeps a workspace between executions', () => {
    expect(mountsStoredObjects('default')).toBe(true);
    for (const routeKey of ['stateful', 'stateful:deployment']) {
      expect(mountsStoredObjects(routeKey)).toBe(false);
      const file = snapshot({ executionProfile: 'stateful', executionRouteKey: routeKey });
      expect(getSnapshotReceipt(file, routeKey)).toBeUndefined();
    }
  });
});

describe('provesStoredContent', () => {
  const info = { etag: content.md5, size: content.bytes };

  it('accepts the entity tag of the uploaded bytes in any quoting', () => {
    expect(provesStoredContent(content, info)).toBe(true);
    expect(provesStoredContent(content, { ...info, etag: `"${content.md5}"` })).toBe(true);
    expect(provesStoredContent(content, { ...info, etag: content.md5!.toUpperCase() })).toBe(true);
  });

  it.each([
    ['another object', { ...info, etag: createHash('md5').update('other').digest('hex') }],
    ['a multipart entity tag', { ...info, etag: `${content.md5}-2` }],
    ['a truncated object', { ...info, size: content.bytes - 1 }],
    ['a listing without an entity tag', { size: content.bytes }],
    ['a failed probe', null],
  ])('rejects %s', (_label, probed) => {
    expect(provesStoredContent(content, probed)).toBe(false);
  });

  it('proves nothing for an upload that could not record an MD5', () => {
    expect(provesStoredContent({ sha256: content.sha256, bytes: content.bytes }, info)).toBe(false);
  });
});
