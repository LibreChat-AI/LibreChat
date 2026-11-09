import { logger } from '@librechat/data-schemas';
import type { NmbConfig } from './types';
import { classifyChatRoute, createNmbChatGateway, MASK_NOTE } from './chat';
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

const run = async (
  req: ReturnType<typeof mockReq>,
  scanner = fakeScanner(),
  config: NmbConfig = baseConfig,
  getFiles?: jest.Mock,
) => {
  const gate = createNmbChatGateway({ config, scanner, getFiles });
  const res = mockRes();
  const next = jest.fn();
  await gate(req, res, next);
  return { res, next, scanner };
};

const loggedText = () =>
  JSON.stringify(
    [logger.info, logger.warn, logger.error, logger.debug].map((f) => (f as jest.Mock).mock.calls),
  );

describe('classifyChatRoute', () => {
  it.each([
    ['POST', '/', 'text'],
    ['POST', '/agents', 'text'],
    ['POST', '/steer', 'text'],
    ['POST', '/steer/deliver', 'text'],
    ['POST', '/queued-turns', 'text'],
    ['POST', '/queued-turns/v2', 'text'],
    ['POST', '/resume', 'resume'],
    ['POST', '/abort', null],
    ['POST', '/steer/cancel', null],
    ['POST', '/steer/arm', null],
    ['GET', '/', null],
    ['GET', '/stream/abc', null],
  ])('%s %s -> %s', (method, path, expected) => {
    expect(classifyChatRoute(method, path)).toBe(expected);
  });
});

describe('createNmbChatGateway', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a pass-through when the gateway is disabled', async () => {
    const { next, scanner } = await run(mockReq({ body: { text: SECRET } }), fakeScanner(), {
      ...baseConfig,
      enabled: false,
    });
    expect(next).toHaveBeenCalled();
    expect(scanner.scanText).not.toHaveBeenCalled();
  });

  it('ALLOW: forwards the (identical) sanitised content', async () => {
    const req = mockReq({ body: { text: 'hello' } });
    const { next } = await run(req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body.text).toBe('hello');
  });

  it('MASK: replaces the text with the sanitised content and adds the note', async () => {
    const scanner = fakeScanner({
      scanText: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'mask',
          sanitized_content: 'pay <ACCOUNT_001>',
          findings: [
            {
              entity: 'ACCOUNT_NUMBER',
              type: 'financial',
              location: { segment: 'text', start: 4, end: 20 },
              score: 0.9,
              action: 'MASK',
              value_hash: 'abc123abc123',
              placeholder: '<ACCOUNT_001>',
            },
          ],
        }),
      ),
    });
    const req = mockReq({ body: { text: `pay ${SECRET}` } });
    const { next, res } = await run(req, scanner);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.body.text).toBe(`pay <ACCOUNT_001>${MASK_NOTE}`);
    expect(req.body.text).not.toContain(SECRET);
    expect(res.headers['X-NMB-Masked']).toBe('1');
  });

  it('REVIEW: holds the message, returns the review id, and never calls the controller', async () => {
    const scanner = fakeScanner({
      scanText: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'review',
          sanitized_content: null,
          review_id: 'rev_0123456789ab',
        }),
      ),
    });
    const req = mockReq({ body: { text: `key ${SECRET}` } });
    const { res, next } = await run(req, scanner);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(423);
    expect(res.body).toMatchObject({ type: 'nmb_review_pending', review_id: 'rev_0123456789ab' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('REJECT: refuses with the scanner reason and does not forward', async () => {
    const scanner = fakeScanner({
      scanText: jest.fn().mockResolvedValue(
        scanResult({
          decision: 'reject',
          sanitized_content: null,
          review_required_reason:
            'Submission contains material that policy forbids sending: secret:PRIVATE_KEY',
        }),
      ),
    });
    const { res, next } = await run(mockReq({ body: { text: 'x' } }), scanner);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ type: 'nmb_rejected' });
  });

  describe('fail closed', () => {
    it.each([
      ['scanner unreachable', new ScannerError('unavailable')],
      ['wrong service key', new ScannerError('unauthorized', 401)],
      ['malformed response', new ScannerError('bad_response')],
      ['unexpected throw', new Error('boom')],
    ])('%s: refuses and never forwards the original', async (_name, error) => {
      const scanner = fakeScanner({ scanText: jest.fn().mockRejectedValue(error) });
      const req = mockReq({ body: { text: `pay ${SECRET}` } });
      const { res, next } = await run(req, scanner);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ type: 'nmb_unavailable' });
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it('treats an allow/mask decision without sanitised content as a failure', async () => {
      const scanner = fakeScanner({
        scanText: jest
          .fn()
          .mockResolvedValue(scanResult({ decision: 'mask', sanitized_content: null })),
      });
      const { res, next } = await run(mockReq({ body: { text: 'x' } }), scanner);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
    });

    it('refuses everything when enabled but the scanner URL or key is missing', async () => {
      const { res, next, scanner } = await run(mockReq({ body: { text: 'x' } }), fakeScanner(), {
        ...baseConfig,
        scannerUrl: '',
      });
      expect(next).not.toHaveBeenCalled();
      expect(scanner.scanText).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
    });
  });

  it('takes user, department and roles from the session, never from the body', async () => {
    const req = mockReq({
      user: { id: 'user-7', role: 'RISK' },
      body: {
        text: 'hi',
        user: 'admin-1',
        department: 'Compliance',
        roles: ['admin', 'reviewer'],
        conversationId: 'someone-elses-convo',
      },
    });
    const { scanner } = await run(req);
    expect(scanner.scanText).toHaveBeenCalledWith('hi', {
      scope: 'u:user-7',
      user: 'user-7',
      department: 'Risk',
      roles: ['risk'],
    });
  });

  it('also screens custom instructions and edited content parts', async () => {
    const scanner = fakeScanner({
      scanText: jest.fn().mockImplementation(async (t: string) =>
        scanResult({
          decision: 'mask',
          sanitized_content: t.replace(SECRET, '<ACCOUNT_001>'),
          findings: [
            {
              entity: 'ACCOUNT_NUMBER',
              type: 'financial',
              location: { segment: 'text', start: 0, end: 1 },
              score: 1,
              action: 'MASK',
              value_hash: 'h',
              placeholder: '<ACCOUNT_001>',
            },
          ],
        }),
      ),
    });
    const req = mockReq({
      body: {
        text: 'a',
        promptPrefix: `use ${SECRET}`,
        editedContent: [{ type: 'text', text: `edited ${SECRET}` }],
      },
    });
    const { next } = await run(req, scanner);
    expect(next).toHaveBeenCalled();
    expect(JSON.stringify(req.body)).not.toContain(SECRET);
    expect(scanner.scanText).toHaveBeenCalledTimes(3);
  });

  it('does not scan control routes', async () => {
    const { next, scanner } = await run(mockReq({ path: '/abort', body: { text: SECRET } }));
    expect(next).toHaveBeenCalled();
    expect(scanner.scanText).not.toHaveBeenCalled();
  });

  describe('ask-user answers (/resume)', () => {
    it('masks answer strings', async () => {
      const scanner = fakeScanner({
        scanText: jest.fn().mockResolvedValue(scanResult({ sanitized_content: 'clean' })),
      });
      const req = mockReq({ path: '/resume', body: { answers: { q1: SECRET, q2: ['a', 'b'] } } });
      const { next } = await run(req, scanner);
      expect(next).toHaveBeenCalled();
      expect(req.body.answers).toEqual({ q1: 'clean', q2: ['clean', 'clean'] });
    });

    it('refuses answers it cannot inspect', async () => {
      const { res, next } = await run(
        mockReq({ path: '/resume', body: { answers: { q1: { nested: SECRET } } } }),
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
    });
  });

  describe('release of an approved hold', () => {
    const sentinel = '[[nmb:release:rev_0123456789ab]]';

    it('swaps in the scanner-stored content; the client cannot choose it', async () => {
      const req = mockReq({ body: { text: sentinel } });
      const scanner = fakeScanner({
        getReview: jest.fn().mockResolvedValue(reviewItem({ status: 'approved-masked' })),
      });
      const { next } = await run(req, scanner);
      expect(next).toHaveBeenCalled();
      expect(req.body.text).toContain('pay <ACCOUNT_001> now');
      expect(scanner.scanText).not.toHaveBeenCalled();
    });

    it("refuses another user's review", async () => {
      const scanner = fakeScanner({
        getReview: jest
          .fn()
          .mockResolvedValue(reviewItem({ user: 'someone-else', status: 'approved-masked' })),
      });
      const { res, next } = await run(mockReq({ body: { text: sentinel } }), scanner);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    it('refuses a review that is still pending or was rejected', async () => {
      for (const status of ['pending', 'rejected'] as const) {
        const scanner = fakeScanner({
          getReview: jest.fn().mockResolvedValue(reviewItem({ status })),
        });
        const { res, next } = await run(mockReq({ body: { text: sentinel } }), scanner);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(403);
      }
    });

    it('fails closed when the scanner is down during release', async () => {
      const scanner = fakeScanner({
        getReview: jest.fn().mockRejectedValue(new ScannerError('unavailable')),
      });
      const { res, next } = await run(mockReq({ body: { text: sentinel } }), scanner);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
    });
  });

  describe('attachments', () => {
    it('refuses files that did not pass the upload gate', async () => {
      const getFiles = jest.fn().mockResolvedValue([{ file_id: 'f1', filename: 'raw.docx' }]);
      const { res, next } = await run(
        mockReq({ body: { text: 'hi', files: [{ file_id: 'f1' }] } }),
        fakeScanner(),
        baseConfig,
        getFiles,
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ type: 'nmb_file_not_cleared' });
    });

    it('accepts files cleared by the upload gate', async () => {
      const getFiles = jest
        .fn()
        .mockResolvedValue([{ file_id: 'f1', filename: 'a.docx.masked.md' }]);
      const { next } = await run(
        mockReq({ body: { text: 'hi', files: [{ file_id: 'f1' }] } }),
        fakeScanner(),
        baseConfig,
        getFiles,
      );
      expect(next).toHaveBeenCalled();
    });
  });

  it('never writes raw sensitive values to logs, in any outcome', async () => {
    const outcomes = [
      scanResult({ decision: 'mask', sanitized_content: 'pay <ACCOUNT_001>' }),
      scanResult({ decision: 'review', sanitized_content: null, review_id: 'rev_0123456789ab' }),
      scanResult({ decision: 'reject', sanitized_content: null, review_required_reason: 'no' }),
    ];
    for (const out of outcomes) {
      await run(
        mockReq({ body: { text: `pay ${SECRET}` } }),
        fakeScanner({ scanText: jest.fn().mockResolvedValue(out) }),
      );
    }
    await run(
      mockReq({ body: { text: `pay ${SECRET}` } }),
      fakeScanner({ scanText: jest.fn().mockRejectedValue(new Error(`leaky ${SECRET}`)) }),
    );
    expect(loggedText()).not.toContain(SECRET);
  });
});
