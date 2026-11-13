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

  it('reports ok on the retried update after a duplicate-key error on the initial upsert', async () => {
    const sid = 'sid-revoke-duplicate-key-retry-success';
    await methods.establishProviderSession({
      ...ref,
      sid,
      subject: 'user-1',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const ProviderSession = mongoose.models.ProviderSession;
    const findOneAndUpdateSpy = jest
      .spyOn(ProviderSession, 'findOneAndUpdate')
      .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 })); // initial upsert attempt; the retry below runs on the real DB

    try {
      await expect(
        methods.revokeProviderSession({
          ...ref,
          sid,
          subject: 'user-1',
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      findOneAndUpdateSpy.mockRestore();
    }

    const stored = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(stored?.revokedAt).toBeInstanceOf(Date);
  });

  describe('non-duplicate-key errors are rethrown rather than classified as a conflict', () => {
    it('establishProviderSession rethrows a non-duplicate-key error from the initial upsert', async () => {
      const sid = 'sid-establish-nondup-error';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 121 });

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toEqual({ code: 121 });
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
      expect(await mongoose.models.ProviderSession.findOne({ ...ref, sid })).toBeNull();
    });

    it('establishProviderSession rethrows a plain Error without a numeric code', async () => {
      const sid = 'sid-establish-plain-error';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce(new Error('connection reset'));

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toThrow('connection reset');
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
    });

    it('revokeProviderSession rethrows a non-duplicate-key error from the initial upsert', async () => {
      const sid = 'sid-revoke-nondup-error';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 121 });

      try {
        await expect(
          methods.revokeProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toEqual({ code: 121 });
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
    });
  });

  describe('establish: duplicate-key recheck path', () => {
    it('reports CONFLICT when the classification read finds no record and the retried upsert also fails', async () => {
      const sid = 'sid-establish-retry-also-fails';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 11000 }) // initial upsert attempt
        .mockResolvedValueOnce(null); // the single retry inside the classification block
      const findOneSpy = jest.spyOn(ProviderSession, 'findOne').mockReturnValue({
        read: () => ({ lean: () => Promise.resolve(null) }),
      } as unknown as ReturnType<typeof ProviderSession.findOne>);

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).resolves.toEqual({ ok: false, code: 'CONFLICT' });
      } finally {
        findOneAndUpdateSpy.mockRestore();
        findOneSpy.mockRestore();
      }
    });

    it('rethrows an error raised while classifying a duplicate-key conflict', async () => {
      const sid = 'sid-establish-classify-throws';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 11000 });
      const findOneSpy = jest.spyOn(ProviderSession, 'findOne').mockReturnValue({
        read: () => ({ lean: () => Promise.reject(new Error('classify read failed')) }),
      } as unknown as ReturnType<typeof ProviderSession.findOne>);

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toThrow('classify read failed');
      } finally {
        findOneAndUpdateSpy.mockRestore();
        findOneSpy.mockRestore();
      }
    });

    it('reports CONFLICT via the recheck when the reactivation update loses a race and the record is still active', async () => {
      const sid = 'sid-establish-reactivation-race-conflict';
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 1000),
      });

      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 11000 }) // initial upsert attempt
        .mockResolvedValueOnce(null); // reactivation attempt loses the race

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).resolves.toEqual({ ok: false, code: 'CONFLICT' });
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
    });

    it('reports ENDED via the recheck when the record was revoked between classification and reactivation', async () => {
      const sid = 'sid-establish-reactivation-race-ended';
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 1000),
      });

      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce({ code: 11000 }) // initial upsert attempt
        .mockImplementationOnce((async () => {
          // Simulate a concurrent revoke landing between the classification read and this
          // reactivation attempt, then report the lost race the same way Mongo would.
          await ProviderSession.updateOne({ ...ref, sid }, { $set: { revokedAt: new Date() } });
          return null;
        }) as unknown as typeof ProviderSession.findOneAndUpdate);

      try {
        await expect(
          methods.establishProviderSession({
            ...ref,
            sid,
            subject: 'user-1',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).resolves.toEqual({ ok: false, code: 'ENDED' });
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
    });

    it('does not attempt reactivation once a genuine subject conflict is classified', async () => {
      const sid = 'sid-establish-subject-conflict-shortcircuit';
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest.spyOn(ProviderSession, 'findOneAndUpdate');

      const result = await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-2',
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(result).toEqual({ ok: false, code: 'CONFLICT' });
      // The initial (failed, duplicate-key) upsert attempt is the only findOneAndUpdate call;
      // the explicit subject-conflict check must return before a second (reactivation) attempt.
      expect(findOneAndUpdateSpy).toHaveBeenCalledTimes(1);
      findOneAndUpdateSpy.mockRestore();
    });
  });

  describe('authorize: MISSING fallback and classification errors', () => {
    it('reports MISSING when the top-level update fails to match for a reason other than ENDED, expiry, or subject conflict', async () => {
      const sid = 'sid-authorize-fallback-missing';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockResolvedValueOnce(null);
      const findOneSpy = jest.spyOn(ProviderSession, 'findOne').mockReturnValue({
        read: () => ({
          lean: () =>
            Promise.resolve({
              ...ref,
              sid,
              expiresAt: new Date(Date.now() + 60_000),
            }),
        }),
      } as unknown as ReturnType<typeof ProviderSession.findOne>);

      try {
        await expect(
          methods.authorizeProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).resolves.toEqual({ ok: false, code: 'MISSING' });
      } finally {
        findOneAndUpdateSpy.mockRestore();
        findOneSpy.mockRestore();
      }
    });

    it('rethrows an error raised while authorizing', async () => {
      const sid = 'sid-authorize-classify-throws';
      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockRejectedValueOnce(new Error('authorize db failure'));

      try {
        await expect(
          methods.authorizeProviderSession({
            ...ref,
            sid,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ).rejects.toThrow('authorize db failure');
      } finally {
        findOneAndUpdateSpy.mockRestore();
      }
    });

    it('reports MISSING, not CONFLICT, for an expired record whose subject disagrees with the request', async () => {
      const sid = 'sid-authorize-expired-subject-mismatch';
      const establishedAt = new Date(Date.now() - 120_000);
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() - 1000),
        now: establishedAt,
      });

      const authorized = await methods.authorizeProviderSession({
        ...ref,
        sid,
        subject: 'user-2',
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(authorized).toEqual({ ok: false, code: 'MISSING' });
    });
  });

  describe('revoke $setOnInsert subject on a fresh record', () => {
    it('stores the given subject and createdAt when revoking a sid that was never established', async () => {
      const sid = 'sid-revoke-fresh-subject';
      const now = new Date('2026-03-01T00:00:00Z');
      const revoked = await methods.revokeProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(now.getTime() + 60_000),
        now,
      });
      expect(revoked).toEqual({ ok: true });

      const stored = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid,
      }).lean<t.IProviderSession>();
      expect(stored?.subject).toBe('user-1');
      expect(stored?.createdAt.getTime()).toBe(now.getTime());
    });

    it('never writes a subject field on a fresh revoke when subject is explicitly null', async () => {
      const sid = 'sid-revoke-fresh-null-subject';
      await methods.revokeProviderSession({
        ...ref,
        sid,
        subject: null,
        expiresAt: new Date(Date.now() + 60_000),
      } as unknown as t.ProviderSessionOperationData);

      const raw = await mongoose.connection.db
        ?.collection('providersessions')
        .findOne({ ...ref, sid });
      expect(raw).not.toBeNull();
      expect('subject' in (raw as Record<string, unknown>)).toBe(false);
    });
  });

  it('establishProviderSession stores the injected now as createdAt on a fresh insert', async () => {
    const sid = 'sid-establish-fresh-createdat';
    const now = new Date('2026-04-01T00:00:00Z');
    await methods.establishProviderSession({
      ...ref,
      sid,
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });

    const stored = await mongoose.models.ProviderSession.findOne({
      ...ref,
      sid,
    }).lean<t.IProviderSession>();
    expect(stored?.createdAt.getTime()).toBe(now.getTime());
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

    it('reactivates an expired-but-unrevoked record that never stored a subject, storing the one just supplied', async () => {
      const sid = 'sid-reactivate-fill-missing-subject';
      const base = new Date('2026-02-01T00:00:00Z');
      await methods.establishProviderSession({
        ...ref,
        sid,
        expiresAt: new Date(base.getTime() + 1000),
        now: base,
      });

      const later = new Date(base.getTime() + 5000);
      const result = await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(later.getTime() + 60_000),
        now: later,
      });
      expect(result).toEqual({ ok: true });

      const stored = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid,
      }).lean<t.IProviderSession>();
      expect(stored?.subject).toBe('user-1');
      expect(stored?.expiresAt.getTime()).toBe(later.getTime() + 60_000);
    });

    it('reactivates an expired-but-unrevoked record when the follow-up request carries no subject, leaving the stored one unchanged', async () => {
      const sid = 'sid-reactivate-no-subject-in-request';
      const base = new Date('2026-02-01T00:00:00Z');
      await methods.establishProviderSession({
        ...ref,
        sid,
        subject: 'user-1',
        expiresAt: new Date(base.getTime() + 1000),
        now: base,
      });

      const later = new Date(base.getTime() + 5000);
      const result = await methods.establishProviderSession({
        ...ref,
        sid,
        subject: null,
        expiresAt: new Date(later.getTime() + 60_000),
        now: later,
      } as unknown as t.ProviderSessionOperationData);
      expect(result).toEqual({ ok: true });

      const stored = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid,
      }).lean<t.IProviderSession>();
      expect(stored?.subject).toBe('user-1');
      expect(stored?.expiresAt.getTime()).toBe(later.getTime() + 60_000);
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

  /**
   * Every test above keeps exactly one record per `sid`, so a mutation that widens a method's
   * internal classification/update filter to `{}` would still happen to touch the right
   * document. Each of these plants an unrelated decoy record sharing `issuer`/`clientId` (a
   * different `sid`, inserted first so it is also first in natural/insertion order) and asserts
   * the decoy is left exactly as it was.
   */
  describe('decoy-record scoping', () => {
    it('establish classification and reactivation act on the matching sid record, not an unrelated one', async () => {
      const decoySid = 'sid-decoy-reactivate';
      const targetSid = 'sid-target-reactivate';
      const base = new Date('2026-02-01T00:00:00Z');

      await methods.establishProviderSession({
        ...ref,
        sid: decoySid,
        subject: 'decoy-user',
        expiresAt: new Date(base.getTime() + 60_000),
        now: base,
      });
      await methods.establishProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'target-user',
        expiresAt: new Date(base.getTime() + 1_000),
        now: base,
      });

      const later = new Date(base.getTime() + 2_000);
      const reactivated = await methods.establishProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'target-user',
        expiresAt: new Date(later.getTime() + 60_000),
        now: later,
      });
      expect(reactivated).toEqual({ ok: true });

      const target = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: targetSid,
      }).lean<t.IProviderSession>();
      expect(target?.expiresAt.getTime()).toBe(later.getTime() + 60_000);
      expect(target?.subject).toBe('target-user');

      const decoy = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: decoySid,
      }).lean<t.IProviderSession>();
      expect(decoy?.expiresAt.getTime()).toBe(base.getTime() + 60_000);
      expect(decoy?.subject).toBe('decoy-user');
    });

    it('authorize on a never-established sid reports MISSING and never touches an unrelated record', async () => {
      const decoySid = 'sid-decoy-authorize';
      const targetSid = 'sid-target-authorize-missing';
      const decoyExpiry = new Date(Date.now() + 60_000);

      await methods.establishProviderSession({
        ...ref,
        sid: decoySid,
        subject: 'decoy-user',
        expiresAt: decoyExpiry,
      });

      const authorized = await methods.authorizeProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'target-user',
        expiresAt: new Date(Date.now() + 120_000),
      });
      expect(authorized).toEqual({ ok: false, code: 'MISSING' });

      const decoy = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: decoySid,
      }).lean<t.IProviderSession>();
      expect(decoy?.expiresAt.getTime()).toBe(decoyExpiry.getTime());
      expect(decoy?.subject).toBe('decoy-user');
      expect(await mongoose.models.ProviderSession.findOne({ ...ref, sid: targetSid })).toBeNull();
    });

    it('revoke subject-mismatch classification reads the record for the given sid, not an unrelated one', async () => {
      const decoySid = 'sid-decoy-revoke-classify';
      const targetSid = 'sid-target-revoke-classify';

      // Decoy has no subject, so a classification read that landed on it instead of the
      // target would skip the mismatch check entirely.
      await methods.establishProviderSession({
        ...ref,
        sid: decoySid,
        expiresAt: new Date(Date.now() + 60_000),
      });
      await methods.establishProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const revoked = await methods.revokeProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'user-2',
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(revoked).toEqual({ ok: false, code: 'SUBJECT_MISMATCH' });

      const target = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: targetSid,
      }).lean<t.IProviderSession>();
      expect(target?.revokedAt).toBeUndefined();
      expect(target?.subject).toBe('user-1');
    });

    it('revoke force-final update (no real subject conflict) applies to the matching sid record only', async () => {
      const decoySid = 'sid-decoy-revoke-force-final';
      const targetSid = 'sid-target-revoke-force-final';

      await methods.establishProviderSession({
        ...ref,
        sid: decoySid,
        subject: 'decoy-user',
        expiresAt: new Date(Date.now() + 60_000),
      });
      await methods.establishProviderSession({
        ...ref,
        sid: targetSid,
        subject: 'user-1',
        expiresAt: new Date(Date.now() + 60_000),
      });

      const ProviderSession = mongoose.models.ProviderSession;
      const findOneAndUpdateSpy = jest
        .spyOn(ProviderSession, 'findOneAndUpdate')
        .mockResolvedValueOnce(null) // primary upsert attempt
        .mockResolvedValueOnce(null); // retry without upsert; falls through to the real final update
      const findOneSpy = jest.spyOn(ProviderSession, 'findOne').mockReturnValue({
        read: () => ({
          // Classification sees no subject on the stored record, so the mismatch check is
          // skipped and the force-final update (by key alone) is the one that must apply.
          lean: () => Promise.resolve({ ...ref, sid: targetSid }),
        }),
      } as unknown as ReturnType<typeof ProviderSession.findOne>);

      try {
        const revoked = await methods.revokeProviderSession({
          ...ref,
          sid: targetSid,
          subject: 'user-2',
          expiresAt: new Date(Date.now() + 120_000),
        });
        expect(revoked).toEqual({ ok: true });
      } finally {
        findOneAndUpdateSpy.mockRestore();
        findOneSpy.mockRestore();
      }

      const target = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: targetSid,
      }).lean<t.IProviderSession>();
      expect(target?.revokedAt).toBeDefined();

      const decoy = await mongoose.models.ProviderSession.findOne({
        ...ref,
        sid: decoySid,
      }).lean<t.IProviderSession>();
      expect(decoy?.revokedAt).toBeUndefined();
      expect(decoy?.subject).toBe('decoy-user');
    });
  });
});
