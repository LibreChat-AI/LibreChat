import { RetentionMode } from 'librechat-data-provider';
import type { ForcedRetentionStore } from './retention';
import {
  applyForcedTemporaryRequest,
  applyForcedRetention,
  resolveResumableRetention,
  persistForcedTemporaryMetadata,
  resolveImportRetentionFields,
  resolveImportTagCounts,
} from './retention';

describe('applyForcedRetention', () => {
  const conversationId = 'conversation-1';
  const messageId = 'message-1';
  let store: { stampForcedRetention: jest.Mock };

  const ctxFor = (retentionMode?: RetentionMode) => ({
    userId: 'user-1',
    isTemporary: false,
    interfaceConfig: retentionMode == null ? undefined : { retentionMode },
  });

  beforeEach(() => {
    store = { stampForcedRetention: jest.fn() };
  });

  const run = (ctx: ReturnType<typeof ctxFor>, messageIdArg?: string) =>
    applyForcedRetention(store as unknown as ForcedRetentionStore, {
      ctx,
      conversationId,
      ...(messageIdArg == null ? {} : { messageId: messageIdArg }),
    });

  it('stamps the conversation and the named message under ephemeral retention', async () => {
    await run(ctxFor(RetentionMode.EPHEMERAL), messageId);

    expect(store.stampForcedRetention).toHaveBeenCalledWith(
      { userId: 'user-1', interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } },
      { conversationId, messageIds: [messageId] },
    );
  });

  it('stamps only the conversation when the caller already saved the message', async () => {
    await run(ctxFor(RetentionMode.EPHEMERAL));

    expect(store.stampForcedRetention).toHaveBeenCalledWith(expect.anything(), {
      conversationId,
      messageIds: [],
    });
  });

  it('never forwards the caller-supplied temporary flag or deadline', async () => {
    await applyForcedRetention(store as unknown as ForcedRetentionStore, {
      ctx: {
        userId: 'user-1',
        isTemporary: false,
        expiredAt: new Date('2099-01-01T00:00:00.000Z'),
        interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL },
      },
      conversationId,
    });

    const [ctx] = store.stampForcedRetention.mock.calls[0];
    expect(ctx).toEqual({
      userId: 'user-1',
      interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL },
    });
  });

  it.each([undefined, null, ''])(
    'writes nothing when the message has no stored conversation (%s)',
    async (storedConversationId) => {
      await applyForcedRetention(store as unknown as ForcedRetentionStore, {
        ctx: ctxFor(RetentionMode.EPHEMERAL),
        conversationId: storedConversationId,
        messageId,
      });

      expect(store.stampForcedRetention).not.toHaveBeenCalled();
    },
  );

  it.each([RetentionMode.TEMPORARY, RetentionMode.ALL, undefined])(
    'writes nothing under retentionMode %s',
    async (retentionMode) => {
      await run(ctxFor(retentionMode), messageId);

      expect(store.stampForcedRetention).not.toHaveBeenCalled();
    },
  );
});

describe('applyForcedTemporaryRequest', () => {
  it('overrides a pre-policy paused job along with the resume request', () => {
    const req = {
      body: { isTemporary: false },
      config: { interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } },
    };
    const metadata = { isTemporary: false };

    applyForcedTemporaryRequest(req, metadata);

    expect(req.body.isTemporary).toBe(true);
    expect(metadata.isTemporary).toBe(true);
  });

  it.each([false, undefined, 'false'])(
    'marks the request temporary under ephemeral whatever the client sent (%s)',
    (isTemporary) => {
      const req = {
        body: { isTemporary },
        config: { interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } },
      };

      applyForcedTemporaryRequest(req);

      expect(req.body.isTemporary).toBe(true);
    },
  );

  it.each([RetentionMode.TEMPORARY, RetentionMode.ALL, undefined])(
    'leaves the client flag alone under retentionMode %s',
    (retentionMode) => {
      const req = {
        body: { isTemporary: false },
        config: { interfaceConfig: retentionMode == null ? undefined : { retentionMode } },
      };

      applyForcedTemporaryRequest(req);

      expect(req.body.isTemporary).toBe(false);
    },
  );

  it('tolerates a request without a body', () => {
    expect(() =>
      applyForcedTemporaryRequest({
        body: null,
        config: { interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } },
      }),
    ).not.toThrow();
  });
});

describe('persistForcedTemporaryMetadata', () => {
  it.each([RetentionMode.TEMPORARY, RetentionMode.ALL, undefined])(
    'does not write job metadata under %s',
    async (retentionMode) => {
      const store = { updateMetadata: jest.fn() };
      await persistForcedTemporaryMetadata(
        { config: { interfaceConfig: { retentionMode } } },
        { streamId: 'conversation-1', createdAt: 1000 },
        store,
      );
      expect(store.updateMetadata).not.toHaveBeenCalled();
    },
  );

  it('fences the persisted temporary flag to the generation being resumed', async () => {
    const store = { updateMetadata: jest.fn() };
    await persistForcedTemporaryMetadata(
      { config: { interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } } },
      { streamId: 'conversation-1', createdAt: 1000 },
      store,
    );
    expect(store.updateMetadata).toHaveBeenCalledWith(
      'conversation-1',
      { isTemporary: true },
      1000,
    );
  });
});

describe('resolveResumableRetention', () => {
  const deadline = new Date('2030-01-01T00:00:00.000Z');
  const createExpiration = jest.fn(() => deadline);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([RetentionMode.TEMPORARY, undefined])(
    'keeps the stored temporary state without inventing a deadline under %s',
    (retentionMode) => {
      expect(
        resolveResumableRetention(
          {
            body: { isTemporary: false },
            resolvedConversation: { isTemporary: true },
            config: { interfaceConfig: { retentionMode } },
          },
          createExpiration,
        ),
      ).toEqual({ isTemporary: true });
      expect(createExpiration).not.toHaveBeenCalled();
    },
  );

  it('preserves the bound deadline while forcing an ephemeral turn temporary', () => {
    expect(
      resolveResumableRetention(
        {
          _agentEventBindingRetention: { isTemporary: false, expiredAt: deadline },
          resolvedConversation: { expiredAt: new Date('2031-01-01T00:00:00.000Z') },
          config: { interfaceConfig: { retentionMode: RetentionMode.EPHEMERAL } },
        },
        createExpiration,
      ),
    ).toEqual({ isTemporary: true, retentionExpiresAt: deadline.toISOString() });
    expect(createExpiration).not.toHaveBeenCalled();
  });

  it.each([
    { retentionMode: RetentionMode.ALL, isTemporary: false },
    { retentionMode: RetentionMode.EPHEMERAL, isTemporary: true },
  ])('captures a deadline for $retentionMode turns', ({ retentionMode, isTemporary }) => {
    expect(
      resolveResumableRetention(
        { body: { isTemporary: false }, config: { interfaceConfig: { retentionMode } } },
        createExpiration,
      ),
    ).toEqual({ isTemporary, retentionExpiresAt: deadline.toISOString() });
    expect(createExpiration).toHaveBeenCalledTimes(1);
  });
});

describe('resolveImportRetentionFields', () => {
  const deps = {
    createChatExpirationDate: jest.fn(() => new Date('2030-01-01T00:00:00.000Z')),
    createFallbackRetentionDate: jest.fn(() => new Date('2031-01-01T00:00:00.000Z')),
    logger: { error: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([RetentionMode.TEMPORARY, undefined])('stores nothing under retentionMode %s', (mode) => {
    expect(
      resolveImportRetentionFields(mode == null ? undefined : { retentionMode: mode }, deps),
    ).toEqual({});
    expect(deps.createChatExpirationDate).not.toHaveBeenCalled();
  });

  it('gives an all-data import a deadline without marking it temporary', () => {
    const fields = resolveImportRetentionFields({ retentionMode: RetentionMode.ALL }, deps);

    expect(fields).toEqual({ isTemporary: false, expiredAt: new Date('2030-01-01T00:00:00.000Z') });
    expect(deps.createChatExpirationDate).toHaveBeenCalledWith(
      { retentionMode: RetentionMode.ALL },
      false,
    );
  });

  it('marks an ephemeral import temporary with the temporary-chat deadline', () => {
    const interfaceConfig = { retentionMode: RetentionMode.EPHEMERAL, temporaryChatRetention: 1 };
    const fields = resolveImportRetentionFields(interfaceConfig, deps);

    expect(fields).toEqual({ isTemporary: true, expiredAt: new Date('2030-01-01T00:00:00.000Z') });
    expect(deps.createChatExpirationDate).toHaveBeenCalledWith(interfaceConfig, true);
  });

  it('keeps a copy of a temporary chat temporary under all-data retention', () => {
    const interfaceConfig = { retentionMode: RetentionMode.ALL, generalChatRetention: 2160 };
    const fields = resolveImportRetentionFields(interfaceConfig, deps, { sourceIsTemporary: true });

    expect(fields.isTemporary).toBe(true);
    expect(deps.createChatExpirationDate).toHaveBeenCalledWith(interfaceConfig, true);
  });

  it('leaves a copy of an ordinary chat visible under all-data retention', () => {
    const interfaceConfig = { retentionMode: RetentionMode.ALL, generalChatRetention: 2160 };
    const fields = resolveImportRetentionFields(interfaceConfig, deps, {
      sourceIsTemporary: false,
    });

    expect(fields.isTemporary).toBe(false);
    expect(deps.createChatExpirationDate).toHaveBeenCalledWith(interfaceConfig, false);
  });

  it('forces a copy temporary under ephemeral whatever its source was', () => {
    const fields = resolveImportRetentionFields({ retentionMode: RetentionMode.EPHEMERAL }, deps, {
      sourceIsTemporary: false,
    });

    expect(fields.isTemporary).toBe(true);
  });

  it('falls back rather than storing an import with no deadline', () => {
    deps.createChatExpirationDate.mockImplementationOnce(() => {
      throw new Error('bad retention window');
    });

    expect(resolveImportRetentionFields({ retentionMode: RetentionMode.EPHEMERAL }, deps)).toEqual({
      isTemporary: true,
      expiredAt: new Date('2031-01-01T00:00:00.000Z'),
    });
    expect(deps.logger.error).toHaveBeenCalled();
  });
});

describe('resolveImportTagCounts', () => {
  it('counts the tags of an import that stays visible', () => {
    expect(resolveImportTagCounts({ isTemporary: false }, ['work', 'urgent'])).toEqual([
      'work',
      'urgent',
    ]);
    expect(resolveImportTagCounts({}, ['work'])).toEqual(['work']);
  });

  it('counts nothing for a forced-temporary import', () => {
    expect(resolveImportTagCounts({ isTemporary: true }, ['work', 'urgent'])).toEqual([]);
  });
});
