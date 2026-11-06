import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type * as t from '~/types';
import { createProviderSessionMethods } from './providerSession';
import providerSessionSchema from '~/schema/providerSession';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createProviderSessionMethods>;

const ref = { issuer: 'https://idp.example.com', clientId: 'librechat' };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  if (!mongoose.models.ProviderSession) {
    mongoose.model<t.IProviderSession>('ProviderSession', providerSessionSchema);
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  methods = createProviderSessionMethods(mongoose);
});

describe('ProviderSession Methods', () => {
  it('creates the unique and TTL indexes before the first write', async () => {
    await methods.establishProviderSession({
      ...ref,
      sid: 'sid-indexes',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const indexes = await mongoose.models.ProviderSession.listIndexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: { issuer: 1, clientId: 1, sid: 1 },
          unique: true,
        }),
        expect.objectContaining({ key: { expiresAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('establishes then authorizes, extending expiresAt without shortening it', async () => {
    const sid = 'sid-establish-authorize';
    const established = await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(established).toEqual({ ok: true });

    const shorterExpiry = new Date(Date.now() + 10_000);
    const authorized = await methods.authorizeProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: shorterExpiry,
    });
    expect(authorized).toEqual({ ok: true });

    const stored = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(shorterExpiry.getTime());

    const longerExpiry = new Date(Date.now() + 120_000);
    await methods.authorizeProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: longerExpiry,
    });
    const extended = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(extended?.expiresAt.getTime()).toBe(longerExpiry.getTime());
  });

  it('blocks a later establish with ENDED when revoke arrives first (sid-only, no subject)', async () => {
    const sid = 'sid-revoke-before-establish';
    const revoked = await methods.revokeProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(revoked).toEqual({ ok: true });

    const established = await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(established).toEqual({ ok: false, code: 'ENDED' });
  });

  it('denies authorize with ENDED after an established session is revoked', async () => {
    const sid = 'sid-revoke-after-establish';
    await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const revoked = await methods.revokeProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(revoked).toEqual({ ok: true });

    const authorized = await methods.authorizeProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(authorized).toEqual({ ok: false, code: 'ENDED' });
  });

  it('keeps the earliest revokedAt and never shortens expiresAt on a duplicate revoke', async () => {
    const sid = 'sid-duplicate-revoke';
    const firstExpiry = new Date(Date.now() + 30_000);
    await methods.revokeProviderSession({ ...ref, sid, expiresAt: firstExpiry });
    const afterFirst = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    const firstRevokedAt = afterFirst?.revokedAt?.getTime();
    expect(firstRevokedAt).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const shorterExpiry = new Date(Date.now() + 10_000);
    const secondRevoke = await methods.revokeProviderSession({
      ...ref,
      sid,
      expiresAt: shorterExpiry,
    });
    expect(secondRevoke).toEqual({ ok: true });

    const afterSecond = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(afterSecond?.revokedAt?.getTime()).toBe(firstRevokedAt);
    expect(afterSecond?.expiresAt.getTime()).toBeGreaterThanOrEqual(firstExpiry.getTime());

    const longerExpiry = new Date(Date.now() + 120_000);
    await methods.revokeProviderSession({ ...ref, sid, expiresAt: longerExpiry });
    const afterThird = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(afterThird?.revokedAt?.getTime()).toBe(firstRevokedAt);
    expect(afterThird?.expiresAt.getTime()).toBe(longerExpiry.getTime());
  });

  it('reports MISSING for an expired, unrevoked record and never creates one on authorize', async () => {
    const sid = 'sid-expired-unrevoked';
    const establishedAt = new Date(Date.now() - 120_000);
    await methods.establishProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(Date.now() - 1000),
      now: establishedAt,
    });

    const authorized = await methods.authorizeProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(authorized).toEqual({ ok: false, code: 'MISSING' });

    const authorizedNoRecord = await methods.authorizeProviderSession({
      ...ref,
      sid: 'sid-never-established',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(authorizedNoRecord).toEqual({ ok: false, code: 'MISSING' });
    expect(
      await mongoose.models.ProviderSession.findOne({ ...ref, sid: 'sid-never-established' }),
    ).toBeNull();
  });

  it('reports CONFLICT on authorize when the verified subject disagrees with the stored one', async () => {
    const sid = 'sid-subject-conflict-authorize';
    await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const authorized = await methods.authorizeProviderSession({
      ...ref,
      sid,
      subject: 'user-2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(authorized).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('reports CONFLICT on establish when the verified subject disagrees with the stored one', async () => {
    const sid = 'sid-subject-conflict-establish';
    await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const established = await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(established).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('reports SUBJECT_MISMATCH on revoke when the verified subject disagrees with the stored one', async () => {
    const sid = 'sid-subject-conflict-revoke';
    await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const revoked = await methods.revokeProviderSession({
      ...ref,
      sid,
      subject: 'user-2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(revoked).toEqual({ ok: false, code: 'SUBJECT_MISMATCH' });
  });

  it('throws rather than reporting ok when the final revoke update matches no document', async () => {
    const sid = 'sid-revoke-lost-race';
    const ProviderSession = mongoose.models.ProviderSession;
    const findOneAndUpdateSpy = jest
      .spyOn(ProviderSession, 'findOneAndUpdate')
      .mockResolvedValueOnce(null) // initial upsert attempt
      .mockResolvedValueOnce(null) // retry without upsert
      .mockResolvedValueOnce(null); // final update, by key alone
    const findOneSpy = jest.spyOn(ProviderSession, 'findOne').mockReturnValue({
      read: () => ({
        lean: () => Promise.resolve({ ...ref, sid }),
      }),
    } as unknown as ReturnType<typeof ProviderSession.findOne>);

    try {
      await expect(
        methods.revokeProviderSession({
          ...ref,
          sid,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).rejects.toThrow('[revokeProviderSession] final update matched no document');
    } finally {
      findOneAndUpdateSpy.mockRestore();
      findOneSpy.mockRestore();
    }
  });

  it('fills a missing subject on establish rather than treating it as a conflict', async () => {
    const sid = 'sid-fill-subject';
    await methods.establishProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const established = await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(established).toEqual({ ok: true });

    const stored = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(stored?.subject).toBe('user-1');
  });

  it('succeeds both sides of a concurrent establish race for the same session', async () => {
    const sid = 'sid-concurrent-establish';
    const [first, second] = await Promise.all([
      methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 30_000),
      }),
      methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 90_000),
      }),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });

    const count = await mongoose.models.ProviderSession.countDocuments({ ...ref, sid });
    expect(count).toBe(1);
  });

  describe('establish fallback after a duplicate-key race', () => {
    it('reactivates an expired-but-unrevoked record when the subject still agrees', async () => {
      const sid = 'sid-reactivate-match';
      const base = new Date('2026-01-01T00:00:00Z');
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(base.getTime() + 1000),
        now: base,
      });

      const later = new Date(base.getTime() + 2000);
      const reactivated = await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(later.getTime() + 60_000),
        now: later,
      });
      expect(reactivated).toEqual({ ok: true });

      const stored = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid,
      }).lean<t.IProviderSession>();
      expect(stored?.expiresAt.getTime()).toBe(later.getTime() + 60_000);
    });

    it('retries the upsert once when the classification read finds the TTL already removed it', async () => {
      const sid = 'sid-ttl-retry';
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-2',
        expiresAt: new Date(Date.now() + 1000),
      });

      const ProviderSession = mongoose.models.ProviderSession;
      const simulateTtlRemoval = (filter: Record<string, unknown>) => ({
        read: () => ({
          lean: async () => {
            await ProviderSession.deleteOne(filter).exec();
            return null;
          },
        }),
      });
      const findOneSpy = jest
        .spyOn(ProviderSession, 'findOne')
        .mockImplementationOnce(simulateTtlRemoval as unknown as typeof ProviderSession.findOne);

      const result = await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
      });
      findOneSpy.mockRestore();

      expect(result).toEqual({ ok: true });
      const stored = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid,
      }).lean<t.IProviderSession>();
      expect(stored?.subject).toBe('user-1');
    });
  });

  describe('expiresAt invariant', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const pastOrEqual = [new Date('2025-12-31T23:59:59Z'), now];

    it.each(pastOrEqual)(
      'establishProviderSession throws when expiresAt is not after now',
      (expiresAt) => {
        return expect(
          methods.establishProviderSession({
            ...ref,
            sid: 'sid-invariant-establish',
            expiresAt,
            now,
          }),
        ).rejects.toThrow();
      },
    );

    it.each(pastOrEqual)(
      'authorizeProviderSession throws when expiresAt is not after now',
      (expiresAt) => {
        return expect(
          methods.authorizeProviderSession({
            ...ref,
            sid: 'sid-invariant-authorize',
            expiresAt,
            now,
          }),
        ).rejects.toThrow();
      },
    );

    it.each(pastOrEqual)(
      'revokeProviderSession throws when expiresAt is not after now',
      (expiresAt) => {
        return expect(
          methods.revokeProviderSession({ ...ref, sid: 'sid-invariant-revoke', expiresAt, now }),
        ).rejects.toThrow();
      },
    );
  });

  describe('concurrent establish and revoke', () => {
    it('a matching-subject race always revokes once revoke reports ok', async () => {
      for (let i = 0; i < 5; i++) {
        const sid = `sid-concurrent-match-${i}`;
        const [, revoked] = await Promise.all([
          methods.establishProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
          methods.revokeProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ]);

        expect(revoked.ok).toBe(true);
        const stored = await mongoose.models.ProviderSession.findOne({
          ...ref,
          sid,
        }).lean<t.IProviderSession>();
        expect(stored?.revokedAt).toBeDefined();
      }
    });

    it('a sid-only revoke race always revokes regardless of who owns the subject', async () => {
      for (let i = 0; i < 5; i++) {
        const sid = `sid-concurrent-sidonly-${i}`;
        const [, revoked] = await Promise.all([
          methods.establishProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
          methods.revokeProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ]);

        expect(revoked.ok).toBe(true);
        const stored = await mongoose.models.ProviderSession.findOne({
          ...ref,
          sid,
        }).lean<t.IProviderSession>();
        expect(stored?.revokedAt).toBeDefined();
      }
    });

    it("a genuinely conflicting subject never revokes the other subject's record", async () => {
      for (let i = 0; i < 5; i++) {
        const sid = `sid-concurrent-conflict-${i}`;
        const [, revoked] = await Promise.all([
          methods.establishProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
          methods.revokeProviderSession({
            ...ref,
            sid,
            subject: 'user-2',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ]);

        const stored = await mongoose.models.ProviderSession.findOne({
          ...ref,
          sid,
        }).lean<t.IProviderSession>();
        if (revoked.ok) {
          expect(stored?.revokedAt).toBeDefined();
        } else {
          expect(revoked).toEqual({ ok: false, code: 'SUBJECT_MISMATCH' });
          expect(stored?.subject).toBe('user-1');
          expect(stored?.revokedAt).toBeUndefined();
        }
      }
    });

    it('duplicate concurrent revokes on a sid that was never established both return ok', async () => {
      for (let i = 0; i < 5; i++) {
        const sid = `sid-concurrent-missing-${i}`;
        const [first, second] = await Promise.all([
          methods.revokeProviderSession({ ...ref, sid, expiresAt: new Date(Date.now() + 60_000) }),
          methods.revokeProviderSession({ ...ref, sid, expiresAt: new Date(Date.now() + 60_000) }),
        ]);

        expect(first).toEqual({ ok: true });
        expect(second).toEqual({ ok: true });
        const stored = await mongoose.models.ProviderSession.findOne({
          ...ref,
          sid,
        }).lean<t.IProviderSession>();
        expect(stored?.revokedAt).toBeDefined();
      }
    });
  });
});
