import { logger } from '@librechat/data-schemas';
import { createNmbHandlers, type NmbAuditEntry } from './handlers';
import { ScannerError } from './scanner';
import { SECRET, baseConfig, fakeScanner, mockReq, mockRes, reviewItem } from './testkit.helper';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const REVIEWER = { id: 'rev-user', role: 'REVIEWER', username: 'asmith' };
const ID = 'rev_0123456789ab';

function setup(
  opts: {
    reviewer?: boolean;
    scanner?: ReturnType<typeof fakeScanner>;
    config?: typeof baseConfig;
  } = {},
) {
  const audits: NmbAuditEntry[] = [];
  const scanner = opts.scanner ?? fakeScanner();
  const isReviewer = jest.fn().mockResolvedValue(opts.reviewer ?? true);
  const handlers = createNmbHandlers({
    config: opts.config ?? baseConfig,
    scanner,
    isReviewer,
    recordAudit: async (e) => {
      audits.push(e);
    },
    getUserLabels: async (ids) => Object.fromEntries(ids.map((i) => [i, `label-${i}`])),
  });
  return { handlers, scanner, audits, isReviewer };
}

const call = async (handler: (...a: never[]) => unknown, req: ReturnType<typeof mockReq>) => {
  const res = mockRes();
  const next = jest.fn();
  await (handler as unknown as (q: unknown, r: unknown, n: unknown) => Promise<void>)(
    req,
    res,
    next,
  );
  return { res, next };
};

describe('role enforcement', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses a non-reviewer, audits the denial, and never touches the scanner', async () => {
    const { handlers, scanner, audits } = setup({ reviewer: false });
    const { res, next } = await call(
      handlers.requireReviewer,
      mockReq({ method: 'GET', user: { id: 'u1', role: 'USER' } }),
    );
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect(scanner.listReviews).not.toHaveBeenCalled();
    expect(audits).toEqual([
      expect.objectContaining({ action: 'nmb_review.denied', outcome: 'denied' }),
    ]);
  });

  it('decides on the LibreChat capability, not on a client-supplied role', async () => {
    const { handlers, isReviewer } = setup({ reviewer: false });
    const req = mockReq({
      user: { id: 'u1', role: 'USER' },
      body: { roles: ['reviewer', 'admin'] },
      headers: { 'x-nmb-roles': 'reviewer' },
    });
    const { res } = await call(handlers.requireReviewer, req);
    expect(isReviewer).toHaveBeenCalledWith({ id: 'u1', role: 'USER', tenantId: undefined });
    expect(res.statusCode).toBe(403);
  });

  it('lets a reviewer through', async () => {
    const { handlers } = setup({ reviewer: true });
    const { next } = await call(handlers.requireReviewer, mockReq({ user: REVIEWER }));
    expect(next).toHaveBeenCalled();
  });

  it('refuses when the gateway is disabled or misconfigured', async () => {
    const off = setup({ config: { ...baseConfig, enabled: false } });
    expect(
      (await call(off.handlers.requireReviewer, mockReq({ user: REVIEWER }))).res.statusCode,
    ).toBe(404);
    const bad = setup({ config: { ...baseConfig, serviceKey: '' } });
    expect(
      (await call(bad.handlers.requireReviewer, mockReq({ user: REVIEWER }))).res.statusCode,
    ).toBe(503);
  });

  it('/me reports reviewer status for the current user only', async () => {
    const yes = setup({ reviewer: true });
    expect((await call(yes.handlers.me, mockReq({ user: REVIEWER }))).res.body).toMatchObject({
      enabled: true,
      reviewer: true,
    });
    const no = setup({ reviewer: false });
    expect((await call(no.handlers.me, mockReq({ user: REVIEWER }))).res.body).toMatchObject({
      reviewer: false,
    });
  });
});

describe('self-review prohibition', () => {
  const own = reviewItem({ user: REVIEWER.id });

  it("hides the reviewer's own submissions from the queue", async () => {
    const scanner = fakeScanner({
      listReviews: jest
        .fn()
        .mockResolvedValue([own, reviewItem({ id: 'rev_aaaaaaaaaaaa', user: 'other' })]),
    });
    const { handlers } = setup({ scanner });
    const { res } = await call(handlers.listReviews, mockReq({ method: 'GET', user: REVIEWER }));
    const items = (res.body as { items: Array<{ id: string; user_label: string }> }).items;
    expect(items.map((i) => i.id)).toEqual(['rev_aaaaaaaaaaaa']);
    expect(items[0].user_label).toBe('label-other');
  });

  it.each([
    ['getReview', {}],
    ['getOriginal', {}],
    ['approve', { body: {} }],
    ['reject', { body: { reason: 'not acceptable' } }],
  ] as const)(
    '%s on your own submission is 403 and does not reach the scanner',
    async (name, extra) => {
      const scanner = fakeScanner({ getReview: jest.fn().mockResolvedValue(own) });
      const { handlers, audits } = setup({ scanner });
      const { res } = await call(
        handlers[name],
        mockReq({ user: REVIEWER, params: { id: ID }, ...extra }),
      );
      expect(res.statusCode).toBe(403);
      expect(scanner.getOriginal).not.toHaveBeenCalled();
      expect(scanner.approveMasked).not.toHaveBeenCalled();
      expect(scanner.reject).not.toHaveBeenCalled();
      expect(audits[0]).toMatchObject({
        action: 'nmb_review.denied',
        metadata: { reason: 'self_review' },
      });
    },
  );
});

describe('reviewer actions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('view original: returns segments, no-store, and audits without content', async () => {
    const { handlers, audits } = setup();
    const { res } = await call(
      handlers.getOriginal,
      mockReq({ method: 'GET', user: REVIEWER, params: { id: ID } }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect((res.body as { segments: unknown[] }).segments).toHaveLength(1);
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'nmb_review.original_viewed',
        actor: expect.objectContaining({ id: REVIEWER.id }),
        target: { type: 'nmb_review', id: ID },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('view original: 404 for a rejected item (nothing retained) without calling the scanner', async () => {
    const scanner = fakeScanner({
      getReview: jest
        .fn()
        .mockResolvedValue(reviewItem({ decision_at_creation: 'reject', status: 'rejected' })),
    });
    const { handlers } = setup({ scanner });
    const { res } = await call(
      handlers.getOriginal,
      mockReq({ user: REVIEWER, params: { id: ID } }),
    );
    expect(res.statusCode).toBe(404);
    expect(scanner.getOriginal).not.toHaveBeenCalled();
  });

  it('rejects malformed review ids before any lookup', async () => {
    const { handlers, scanner } = setup();
    const { res } = await call(
      handlers.getReview,
      mockReq({ user: REVIEWER, params: { id: '../x' } }),
    );
    expect(res.statusCode).toBe(400);
    expect(scanner.getReview).not.toHaveBeenCalled();
  });

  it('approve: passes the verified literal additions and the reviewer identity from the session', async () => {
    const { handlers, scanner, audits } = setup();
    const req = mockReq({
      user: REVIEWER,
      params: { id: ID },
      body: {
        note: 'ok to send masked',
        additions: [{ value: SECRET, mode: 'literal' }],
        reviewer: 'forged-reviewer',
        roles: ['admin'],
      },
    });
    const { res } = await call(handlers.approve, req);
    expect(res.statusCode).toBe(200);
    expect(scanner.approveMasked).toHaveBeenCalledWith(ID, {
      reviewer: REVIEWER.id,
      roles: ['reviewer'],
      note: 'ok to send masked',
      blocklist_additions: [SECRET],
    });
    expect(audits).toEqual([
      expect.objectContaining({
        action: 'nmb_review.approved',
        outcome: 'success',
        metadata: expect.objectContaining({ literals_added: 1, patterns_added: 0 }),
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(SECRET);
  });

  it('approve: refuses blocklist values that are not in the reviewed content', async () => {
    const { handlers, scanner } = setup();
    const { res } = await call(
      handlers.approve,
      mockReq({
        user: REVIEWER,
        params: { id: ID },
        body: { additions: [{ value: 'Totally Unrelated', mode: 'literal' }] },
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(scanner.approveMasked).not.toHaveBeenCalled();
  });

  it('approve: regex entries are refused until the scanner advertises support', async () => {
    const { handlers, scanner } = setup();
    const { res } = await call(
      handlers.approve,
      mockReq({
        user: REVIEWER,
        params: { id: ID },
        body: { additions: [{ value: 'ACCT-[0-9]+-[A-Z]+', mode: 'regex' }] },
      }),
    );
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ type: 'nmb_regex_unsupported' });
    expect(scanner.approveMasked).not.toHaveBeenCalled();
  });

  it('approve: regex entries are forwarded when supported', async () => {
    const { handlers, scanner } = setup({ config: { ...baseConfig, regexBlocklist: true } });
    const { res } = await call(
      handlers.approve,
      mockReq({
        user: REVIEWER,
        params: { id: ID },
        body: { additions: [{ value: 'ACCT-[0-9]+-[A-Z]+', mode: 'regex' }] },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(scanner.addBlocklist).toHaveBeenCalledWith(
      { terms: [], regexes: ['ACCT-[0-9]+-[A-Z]+'] },
      ['reviewer'],
    );
  });

  it('approve: 409 when the review is no longer pending', async () => {
    const scanner = fakeScanner({
      getReview: jest.fn().mockResolvedValue(reviewItem({ status: 'rejected' })),
    });
    const { handlers } = setup({ scanner });
    const { res } = await call(
      handlers.approve,
      mockReq({ user: REVIEWER, params: { id: ID }, body: {} }),
    );
    expect(res.statusCode).toBe(409);
    expect(scanner.approveMasked).not.toHaveBeenCalled();
  });

  it('reject: requires a reason', async () => {
    const { handlers, scanner } = setup();
    for (const body of [{}, { reason: '' }, { reason: '  ' }, { reason: 'x' }]) {
      const { res } = await call(
        handlers.reject,
        mockReq({ user: REVIEWER, params: { id: ID }, body }),
      );
      expect(res.statusCode).toBe(400);
    }
    expect(scanner.reject).not.toHaveBeenCalled();
  });

  it('reject: records the reason with the scanner and audits who/what/when without the reason text', async () => {
    const { handlers, scanner, audits } = setup();
    const { res } = await call(
      handlers.reject,
      mockReq({
        user: REVIEWER,
        params: { id: ID },
        body: { reason: 'contains customer secrets' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(scanner.reject).toHaveBeenCalledWith(ID, {
      reviewer: REVIEWER.id,
      roles: ['reviewer'],
      note: 'contains customer secrets',
    });
    expect(audits[0]).toMatchObject({
      action: 'nmb_review.rejected',
      outcome: 'success',
      actor: { id: REVIEWER.id, name: 'asmith' },
    });
    expect(JSON.stringify(audits)).not.toContain('customer secrets');
  });

  it('audits a failed approval and maps scanner failures', async () => {
    const scanner = fakeScanner({
      approveMasked: jest.fn().mockRejectedValue(new ScannerError('unavailable')),
    });
    const { handlers, audits } = setup({ scanner });
    const { res } = await call(
      handlers.approve,
      mockReq({ user: REVIEWER, params: { id: ID }, body: {} }),
    );
    expect(res.statusCode).toBe(503);
    expect(audits[0]).toMatchObject({ action: 'nmb_review.approved', outcome: 'failure' });
  });

  it('blocklist edit: literal terms only unless regex is supported; audited by count', async () => {
    const { handlers, scanner, audits } = setup();
    const { res } = await call(
      handlers.addBlocklist,
      mockReq({ user: REVIEWER, body: { entries: [{ value: 'Project Zebra', mode: 'literal' }] } }),
    );
    expect(res.statusCode).toBe(200);
    expect(scanner.addBlocklist).toHaveBeenCalledWith({ terms: ['Project Zebra'] }, ['reviewer']);
    expect(audits[0]).toMatchObject({ action: 'nmb_review.blocklist_updated' });
    expect(JSON.stringify(audits)).not.toContain('Zebra');
  });

  it("never exposes the scanner's opaque blob references", async () => {
    const scanner = fakeScanner({
      listReviews: jest
        .fn()
        .mockResolvedValue([
          { ...reviewItem({ user: 'other' }), original_prompt_ref: 'blob_x', result_ref: 'blob_y' },
        ]),
    });
    const { handlers } = setup({ scanner });
    const { res } = await call(handlers.listReviews, mockReq({ user: REVIEWER }));
    expect(JSON.stringify(res.body)).not.toContain('blob_');
  });

  it('survives an audit-store failure by logging, not by hiding the action', async () => {
    const handlers = createNmbHandlers({
      config: baseConfig,
      scanner: fakeScanner(),
      isReviewer: async () => true,
      recordAudit: async () => {
        throw new Error('db down');
      },
    });
    const { res } = await call(
      handlers.reject,
      mockReq({ user: REVIEWER, params: { id: ID }, body: { reason: 'nope nope' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(logger.error).toHaveBeenCalledWith(
      '[nmb][audit] failed to write audit entry',
      expect.any(Object),
    );
  });
});

describe('end-user endpoints', () => {
  it('submission status is visible to the owner only, and exposes only the reject reason', async () => {
    const item = reviewItem({
      user: 'user-1',
      status: 'rejected',
      reviewer_note: 'contains client data',
      reviewer: 'asmith',
    });
    const { handlers } = setup({
      scanner: fakeScanner({ getReview: jest.fn().mockResolvedValue(item) }),
    });
    const own = await call(handlers.mySubmission, mockReq({ method: 'GET', params: { id: ID } }));
    expect(own.res.body).toEqual(
      expect.objectContaining({ status: 'rejected', reason: 'contains client data' }),
    );
    expect(JSON.stringify(own.res.body)).not.toContain('asmith');
    expect(JSON.stringify(own.res.body)).not.toContain('findings');
    const other = await call(
      handlers.mySubmission,
      mockReq({ method: 'GET', user: { id: 'user-2', role: 'USER' }, params: { id: ID } }),
    );
    expect(other.res.statusCode).toBe(404);
  });

  it('unmask uses the session scope and roles; a body-supplied conversation is ignored', async () => {
    const { handlers, scanner } = setup();
    const { res } = await call(
      handlers.unmask,
      mockReq({
        user: { id: 'user-9', role: 'USER' },
        body: { text: 'pay <ACCOUNT_001>', conversationId: 'victim', roles: ['admin'] },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(scanner.unmask).toHaveBeenCalledWith('u:user-9', 'pay <ACCOUNT_001>', ['user']);
  });

  it('unmask skips the scanner when there are no placeholders, and degrades to masked text when forbidden', async () => {
    const { handlers, scanner } = setup();
    expect((await call(handlers.unmask, mockReq({ body: { text: 'nothing' } }))).res.body).toEqual({
      text: 'nothing',
      restored: 0,
    });
    expect(scanner.unmask).not.toHaveBeenCalled();
    const forbidden = setup({
      scanner: fakeScanner({
        unmask: jest.fn().mockRejectedValue(new ScannerError('forbidden', 403)),
      }),
    });
    expect(
      (await call(forbidden.handlers.unmask, mockReq({ body: { text: 'a <CARD_001>' } }))).res.body,
    ).toEqual({ text: 'a <CARD_001>', restored: 0 });
  });
});
