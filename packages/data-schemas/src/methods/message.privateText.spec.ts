import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryServer;
const methods = createMessageMethods(mongoose);
const tenant = <T>(id: string, fn: () => T) => tenantStorage.run({ tenantId: id }, fn);

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await runAsSystem(() => mongoose.models.Message.deleteMany({}));
});

it('stores both views atomically and excludes ciphertext from ordinary and client reads', async () => {
  const conversationId = uuid();
  const messageId = uuid();
  await tenant('tenant-a', async () => {
    const saved = await methods.saveMessage(
      { userId: 'owner' },
      {
        messageId,
        conversationId,
        text: '[EMAIL_1_turn]',
        isCreatedByUser: true,
      },
      { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
    );
    expect(saved?.privacyRevision).toBe('turn');
    expect(saved).not.toHaveProperty('privateText');
    for (const projection of [undefined, CLIENT_MESSAGE_SELECT]) {
      const rows = await methods.getMessages({ conversationId, user: 'owner' }, projection);
      expect(rows[0].text).toBe('[EMAIL_1_turn]');
      expect(rows[0]).not.toHaveProperty('privateText');
    }
    const own = await methods.getPrivateMessageTexts({
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId,
      messageIds: [messageId],
    });
    expect(own[0]).toMatchObject({
      privateText: 'v1:ciphertext',
      privacyRevision: 'turn',
      text: '[EMAIL_1_turn]',
    });
    const protectedRow = {
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId,
      messageId,
      text: '[EMAIL_1_turn]',
      privacyRevision: 'turn',
    };
    expect(await methods.hasPersistedPrivateText(protectedRow)).toBe(true);
    expect(await methods.getPersistedPrivateTextId(protectedRow)).toBe(String(saved?._id));
    for (const mismatch of [
      { userId: 'other' },
      { tenantId: 'tenant-b' },
      { conversationId: uuid() },
      { messageId: uuid() },
      { text: 'changed text' },
      { privacyRevision: 'wrong' },
    ]) {
      expect(await methods.hasPersistedPrivateText({ ...protectedRow, ...mismatch })).toBe(false);
    }

    expect(
      await methods.getPrivateMessageTexts({
        userId: 'other',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-b',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
  expect(
    await tenant('tenant-b', () =>
      methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-b',
        conversationId,
        messageIds: [messageId],
      }),
    ),
  ).toEqual([]);
  await tenant('tenant-a', async () => {
    await methods.deleteMessages({ conversationId, user: 'owner' });
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('inserts a missing Stop prerequisite once without overwriting a stored or concurrent protected row', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    const context = { userId: 'owner', expiredAt: new Date(Date.now() + 60_000) };
    const user = {
      messageId,
      conversationId,
      isCreatedByUser: true,
      text: '[EMAIL_1_turn]',
    };
    const inserted = await methods.saveMessage(context, user, { insertOnly: true });
    expect(inserted?.text).toBe(user.text);
    expect(inserted?.expiredAt).toEqual(context.expiredAt);
    await methods.saveMessage(context, user, {
      privateText: { envelope: 'v1:owner', revision: 'turn' },
    });
    const retry = await methods.saveMessage(context, user, { insertOnly: true });
    expect(retry?.privacyRevision).toBe('turn');
    expect(retry).not.toHaveProperty('privateText');
    const stored = await mongoose.models.Message.findOne({ messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({
      text: user.text,
      privateText: 'v1:owner',
      privacyRevision: 'turn',
    });

    const concurrentId = uuid();
    await Promise.all([
      methods.saveMessage(context, { ...user, messageId: concurrentId }, { insertOnly: true }),
      methods.saveMessage(
        context,
        { ...user, messageId: concurrentId },
        {
          privateText: { envelope: 'v1:concurrent', revision: 'turn' },
        },
      ),
    ]);
    expect(await mongoose.models.Message.countDocuments({ messageId: concurrentId })).toBe(1);
    const concurrent = await mongoose.models.Message.findOne({ messageId: concurrentId })
      .select('+privateText')
      .lean();
    expect(concurrent).toMatchObject({ privateText: 'v1:concurrent', privacyRevision: 'turn' });
  });
});

it('does not accept sidecar writes from message parameters or generic edits', async () => {
  await tenant('tenant-a', async () => {
    const messageId = uuid();
    const conversationId = uuid();
    const saved = await methods.saveMessage(
      { userId: 'owner' },
      {
        messageId,
        conversationId,
        isCreatedByUser: true,
        text: 'clean',
        privateText: 'untrusted',
        privacyRevision: 'untrusted',
      },
    );
    expect(saved).not.toHaveProperty('privateText');
    expect(saved).not.toHaveProperty('privacyRevision');
    await methods.updateMessage('owner', {
      messageId,
      privateText: 'forged',
      privacyRevision: 'forged',
    });
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('invalidates an encrypted original when an untyped canonical edit sets text to null', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    await methods.updateMessage('owner', { messageId, text: null as unknown as string });
    const stored = await mongoose.models.Message.findOne({ messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({ text: null });
    expect(stored).not.toHaveProperty('privateText');
    expect(stored).not.toHaveProperty('privacyRevision');
  });
});

it('does not return expired originals even before the TTL sweeper runs', async () => {
  await tenant('tenant-a', async () => {
    const messageId = uuid();
    const conversationId = uuid();
    await methods.saveMessage(
      { userId: 'owner', expiredAt: new Date(0), isTemporary: true },
      {
        messageId,
        conversationId,
        text: '[EMAIL_1]',
        isCreatedByUser: true,
      },
      { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
    );
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('strips private fields from bulk copies, including overwrites of protected rows', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    await methods.bulkSaveMessages([
      {
        user: 'owner',
        conversationId,
        messageId,
        text: 'clean copied',
        isCreatedByUser: true,
        privateText: 'forged',
        privacyRevision: 'forged',
      },
      {
        user: 'owner',
        conversationId,
        messageId: uuid(),
        text: 'fresh copied',
        isCreatedByUser: true,
        privateText: 'forged',
        privacyRevision: 'forged',
      },
    ]);
    const rows = await mongoose.models.Message.find({ conversationId })
      .select('+privateText')
      .lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty('privateText');
      expect(row).not.toHaveProperty('privacyRevision');
    }
  });
});

it.each([
  'updateMessage',
  'updateMessageWithProvenance',
  'updateMessageText',
  'saveMessage',
  'recordMessage',
])('removes stored private text atomically when %s rewrites text', async (method) => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    if (method === 'updateMessage' || method === 'updateMessageWithProvenance') {
      const updated = await methods.updateMessage('owner', {
        messageId,
        text: 'clean edited',
        ...(method === 'updateMessageWithProvenance' && { userSubmittedPaths: ['/text'] }),
      });
      expect(updated).not.toHaveProperty('privacyRevision');
    } else if (method === 'updateMessageText') {
      await methods.updateMessageText('owner', { messageId, text: 'clean edited' });
    } else if (method === 'recordMessage') {
      await methods.recordMessage({
        user: 'owner',
        conversationId,
        messageId,
        text: 'clean edited',
        isCreatedByUser: true,
      });
    } else {
      await methods.saveMessage(
        { userId: 'owner' },
        {
          conversationId,
          messageId,
          text: 'clean edited',
          isCreatedByUser: true,
        },
      );
    }
    const stored = await mongoose.models.Message.findOne({ conversationId, messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({ text: 'clean edited' });
    expect(stored).not.toHaveProperty('privateText');
    expect(stored).not.toHaveProperty('privacyRevision');
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
    expect(
      await methods.hasPersistedPrivateText({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageId,
        text: '[EMAIL_1]',
        privacyRevision: 'turn',
      }),
    ).toBe(false);
  });
});

it('persists native-copy token provenance only from metadata and clears it on canonical edits', async () => {
  const token = `[EMAIL_1_${'a'.repeat(32)}]`;
  const conversationId = uuid();
  const messageId = uuid();
  const message = {
    messageId,
    conversationId,
    user: 'owner',
    text: token,
    isCreatedByUser: true,
    privateTextTokens: [token],
    privacyRevision: 'forged',
    privateText: 'forged',
  };
  await tenant('tenant-a', async () => {
    await methods.bulkSaveMessages([message]);
    expect(
      (await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens'))[0],
    ).not.toHaveProperty('privateTextTokens');
    await methods.bulkSaveMessages([message], true, {
      privateTextTokens: new Map([[messageId, [token]]]),
    });
    const internal = (
      await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens')
    )[0];
    expect(internal.privateTextTokens).toEqual([token]);
    expect(internal).not.toHaveProperty('privacyRevision');
    expect(internal).not.toHaveProperty('privateText');
    for (const select of [undefined, CLIENT_MESSAGE_SELECT]) {
      expect(
        (await methods.getMessages({ messageId, user: 'owner' }, select))[0],
      ).not.toHaveProperty('privateTextTokens');
    }
    await methods.updateMessageText('owner', { messageId, text: 'Clean edit' });
    expect(
      (await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens'))[0],
    ).not.toHaveProperty('privateTextTokens');
  });
});

it.each(['saveMessage', 'recordMessage', 'updateMessage', 'bulkSaveMessages'] as const)(
  'clears native-copy provenance when %s overwrites canonical text',
  async (writer) => {
    const token = `[EMAIL_1_${'a'.repeat(32)}]`;
    const messageId = uuid();
    const conversationId = uuid();
    await tenant('tenant-a', async () => {
      await methods.bulkSaveMessages(
        [{ user: 'owner', conversationId, messageId, text: token, isCreatedByUser: true }],
        true,
        { privateTextTokens: new Map([[messageId, [token]]]) },
      );
      const edited = {
        conversationId,
        messageId,
        text: 'Edited text',
        isCreatedByUser: true,
        privateTextTokens: [token],
      };
      if (writer === 'saveMessage') {
        await methods.saveMessage({ userId: 'owner' }, edited);
      } else if (writer === 'recordMessage') {
        await methods.recordMessage({ user: 'owner', ...edited });
      } else if (writer === 'updateMessage') {
        await methods.updateMessage('owner', edited);
      } else {
        await methods.bulkSaveMessages([{ user: 'owner', ...edited }]);
      }
      expect(
        (await methods.getMessages({ user: 'owner', messageId }, '+privateTextTokens'))[0],
      ).not.toHaveProperty('privateTextTokens');
    });
  },
);
