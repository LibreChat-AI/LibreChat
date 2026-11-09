import os from 'os';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { logger } from '@librechat/data-schemas';
import type { UploadedFile } from './files';
import { createNmbUploadGate } from './files';
import { ScannerError } from './scanner';
import {
  SECRET,
  baseConfig,
  fakeScanner,
  mockReq,
  mockRes,
  reviewItem,
  scanResult,
} from './testkit.helper';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let dir: string;
beforeEach(async () => {
  jest.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nmb-upload-'));
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

async function makeReq(name: string, content: string | Buffer) {
  const p = path.join(dir, name);
  await fs.writeFile(p, content);
  const file: UploadedFile = {
    path: p,
    filename: name,
    originalname: name,
    mimetype: 'application/octet-stream',
    size: Buffer.byteLength(content),
  };
  return { req: mockReq({ file }), file, original: p };
}

function setup(scanner = fakeScanner()) {
  const holds: Array<{ userId: string; sha256: string; reviewId: string }> = [];
  const consumed = new Set<string>();
  const gate = createNmbUploadGate({
    config: baseConfig,
    scanner,
    createNmbFileHold: async (h) => {
      holds.push(h);
    },
    findNmbFileHolds: async (userId, sha256) =>
      holds.filter((h) => h.userId === userId && h.sha256 === sha256 && !consumed.has(h.reviewId)),
    consumeNmbFileHold: async (id) => (consumed.has(id) ? false : (consumed.add(id), true)),
  });
  return { gate, scanner, holds };
}

const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe('upload gate', () => {
  it('MASK: replaces the upload with the sanitised markdown and deletes the original', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'mask',
          sanitized_content: '## Sheet\n| <ACCOUNT_001> |',
          findings: [
            {
              entity: 'ACCOUNT_NUMBER',
              type: 'financial',
              location: { segment: 's', start: 0, end: 1 },
              score: 1,
              action: 'MASK',
              value_hash: 'h',
              placeholder: '<ACCOUNT_001>',
            },
          ],
        }),
      ),
    });
    const { gate } = setup(scanner);
    const { req, file, original } = await makeReq('book.xlsx', 'binary');
    const res = mockRes();
    expect(await gate(req, res)).toBe(true);
    expect(file.originalname).toBe('book.xlsx.masked.md');
    expect(file.mimetype).toBe('text/markdown');
    expect(await fs.readFile(file.path, 'utf8')).toBe('## Sheet\n| <ACCOUNT_001> |');
    expect(file.size).toBe(Buffer.byteLength('## Sheet\n| <ACCOUNT_001> |'));
    expect(await exists(original)).toBe(false);
    expect(scanner.scanFile).toHaveBeenCalledWith(
      'book.xlsx',
      expect.any(Uint8Array),
      expect.objectContaining({ scope: 'u:user-1' }),
    );
  });

  it('text types go through /scan/text', async () => {
    const scanner = fakeScanner({
      scanText: jest.fn().mockResolvedValue(scanResult({ sanitized_content: 'clean csv' })),
    });
    const { gate } = setup(scanner);
    const { req, file } = await makeReq('data.csv', `a,b\n${SECRET},2`);
    expect(await gate(req, mockRes())).toBe(true);
    expect(scanner.scanText).toHaveBeenCalled();
    expect(await fs.readFile(file.path, 'utf8')).toBe('clean csv');
  });

  it('REVIEW: refuses the upload, records a hold, and keeps nothing replaced', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'review',
          sanitized_content: null,
          review_id: 'rev_0123456789ab',
        }),
      ),
    });
    const { gate, holds } = setup(scanner);
    const { req } = await makeReq('doc.docx', 'bytes');
    const res = mockRes();
    expect(await gate(req, res)).toBe(false);
    expect(res.statusCode).toBe(423);
    expect(res.body).toMatchObject({ type: 'nmb_review_pending', review_id: 'rev_0123456789ab' });
    expect(holds).toEqual([
      expect.objectContaining({ userId: 'user-1', reviewId: 'rev_0123456789ab' }),
    ]);
  });

  it('re-uploading the identical file after approval releases the sanitised content once', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'review',
          sanitized_content: null,
          review_id: 'rev_0123456789ab',
        }),
      ),
      getReview: jest
        .fn()
        .mockResolvedValue(reviewItem({ status: 'approved-masked', source: 'file' })),
    });
    const { gate } = setup(scanner);
    const first = await makeReq('doc.docx', 'same bytes');
    await gate(first.req, mockRes()); // held
    // pending while unapproved
    (scanner.getReview as jest.Mock).mockResolvedValueOnce(
      reviewItem({ status: 'pending', source: 'file' }),
    );
    const pending = await makeReq('doc.docx', 'same bytes');
    const pendingRes = mockRes();
    expect(await gate(pending.req, pendingRes)).toBe(false);
    expect(pendingRes.body).toMatchObject({ type: 'nmb_review_pending' });
    expect(scanner.scanFile).toHaveBeenCalledTimes(1);

    const second = await makeReq('doc.docx', 'same bytes');
    expect(await gate(second.req, mockRes())).toBe(true);
    expect(await fs.readFile(second.file.path, 'utf8')).toBe('pay <ACCOUNT_001> now');

    const third = await makeReq('doc.docx', 'same bytes');
    await gate(third.req, mockRes());
    expect(scanner.scanFile).toHaveBeenCalledTimes(2); // hold consumed: scanned again
  });

  it("a rejected review keeps refusing the same file, with the reviewer's reason", async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'review',
          sanitized_content: null,
          review_id: 'rev_0123456789ab',
        }),
      ),
      getReview: jest
        .fn()
        .mockResolvedValue(
          reviewItem({ status: 'rejected', reviewer_note: 'client data', source: 'file' }),
        ),
    });
    const { gate } = setup(scanner);
    await gate((await makeReq('a.pdf', 'x')).req, mockRes());
    const again = await makeReq('a.pdf', 'x');
    const res = mockRes();
    expect(await gate(again.req, res)).toBe(false);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ type: 'nmb_rejected', reason: 'client data' });
  });

  it('another user cannot claim a hold on the same bytes', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'review',
          sanitized_content: null,
          review_id: 'rev_0123456789ab',
        }),
      ),
      getReview: jest
        .fn()
        .mockResolvedValue(reviewItem({ status: 'approved-masked', source: 'file' })),
    });
    const { gate } = setup(scanner);
    await gate((await makeReq('a.pdf', 'x')).req, mockRes());
    const other = await makeReq('a.pdf', 'x');
    (other.req as unknown as { user: unknown }).user = { id: 'user-2', role: 'USER' };
    await gate(other.req, mockRes());
    expect(scanner.scanFile).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the scanner is down: refuses and the original is not forwarded', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockRejectedValue(new ScannerError('unavailable')),
    });
    const { gate } = setup(scanner);
    const { req, file, original } = await makeReq('doc.docx', `has ${SECRET}`);
    const res = mockRes();
    expect(await gate(req, res)).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(file.path).toBe(original); // never swapped to anything that implies clearance
    expect(file.originalname).toBe('doc.docx');
  });

  it.each(['photo.png', 'archive.zip', 'noext', 'macro.docm'])(
    'refuses %s, which it cannot inspect',
    async (name) => {
      const { gate, scanner } = setup();
      const { req } = await makeReq(name, 'x');
      const res = mockRes();
      expect(await gate(req, res)).toBe(false);
      expect(res.statusCode).toBe(422);
      expect(scanner.scanFile).not.toHaveBeenCalled();
    },
  );

  it('refuses text that is not valid UTF-8', async () => {
    const { gate } = setup();
    const { req } = await makeReq('bad.txt', Buffer.from([0xff, 0xfe, 0xfa]));
    expect(await gate(req, mockRes())).toBe(false);
  });

  it('REJECT from the scanner refuses the upload', async () => {
    const scanner = fakeScanner({
      scanFile: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'reject',
          sanitized_content: null,
          review_required_reason: 'File could not be parsed (x); it was not sent.',
        }),
      ),
    });
    const { gate } = setup(scanner);
    const res = mockRes();
    expect(await gate((await makeReq('bad.docx', 'x')).req, res)).toBe(false);
    expect(res.statusCode).toBe(422);
  });

  it('is a no-op when disabled', async () => {
    const gate = createNmbUploadGate({
      config: { ...baseConfig, enabled: false },
      scanner: fakeScanner(),
      createNmbFileHold: jest.fn(),
      findNmbFileHolds: jest.fn(),
      consumeNmbFileHold: jest.fn(),
    });
    const { req } = await makeReq('photo.png', 'x');
    expect(await gate(req, mockRes())).toBe(true);
  });

  it('never logs file content or the hash of it', async () => {
    const { gate } = setup(
      fakeScanner({ scanFile: jest.fn().mockRejectedValue(new Error(`boom ${SECRET}`)) }),
    );
    const { req } = await makeReq('doc.docx', `has ${SECRET}`);
    await gate(req, mockRes());
    const sha = crypto.createHash('sha256').update(`has ${SECRET}`).digest('hex');
    const logs = JSON.stringify(
      [logger.info, logger.warn, logger.error].map((f) => (f as jest.Mock).mock.calls),
    );
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(sha);
  });
});
