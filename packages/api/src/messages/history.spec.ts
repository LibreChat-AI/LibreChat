import { Constants, ContentTypes } from 'librechat-data-provider';
import type { BranchLinks, BranchLinksCarrier, HistoryFilter } from './history';
import { orderConversationBranch, prepareRetainedAnswers } from '~/agents/hitl/answers';
import { loadHistoryRows, walkBranch } from './history';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

const USER = 'user-1';
const CONVERSATION = 'convo-1';
const SELECT = '+privateTextTokens';
const NO_PARENT: string = Constants.NO_PARENT;

type Stored = {
  messageId: string;
  parentMessageId: string;
  isCreatedByUser: boolean;
  conversationId: string;
  user: string;
  content?: unknown[];
};

const stored = (
  messageId: string,
  parentMessageId: string,
  isCreatedByUser = false,
  content?: unknown[],
): Stored => ({
  messageId,
  parentMessageId,
  isCreatedByUser,
  conversationId: CONVERSATION,
  user: USER,
  ...(content != null && { content }),
});

/** user-1 -> assistant-1 -> two regenerated exchanges; the second is the active branch. */
const branched = (): Stored[] => [
  stored('u1', NO_PARENT, true),
  stored('a1', 'u1'),
  stored('u2', 'a1', true),
  stored('a2', 'u2'),
  stored('u2b', 'a1', true),
  stored('a2b', 'u2b'),
];

const linear = (): Stored[] => [
  stored('u1', NO_PARENT, true),
  stored('a1', 'u1'),
  stored('u2', 'a1', true),
  stored('a2', 'u2'),
];

/** Stored messages, and a `getMessages` spy that answers the filters the history read issues. */
function createStore(rows: Stored[]) {
  const getMessages = jest.fn(
    async (filter: HistoryFilter, _select: string): Promise<Stored[]> =>
      rows.filter(
        (row) =>
          row.conversationId === filter.conversationId &&
          row.user === filter.user &&
          (filter.messageId == null || filter.messageId.$in.includes(row.messageId)),
      ),
  );
  return { rows, getMessages, all: (): Stored[] => [...rows] };
}

/** The links as the request middleware reads them: every row, reduced to the link fields. */
const readLinks = (rows: Stored[], head: string): BranchLinks => ({
  user: USER,
  conversationId: CONVERSATION,
  parentMessageId: head,
  rows: rows.map(({ messageId, parentMessageId, isCreatedByUser }) => ({
    messageId,
    parentMessageId,
    isCreatedByUser,
  })),
});

const ids = (rows: { messageId: string }[]): string[] => rows.map((row) => row.messageId);
const sorted = (values: string[]): string[] => [...values].sort();
const history = (rows: Stored[], head: string): string[] =>
  ids(orderConversationBranch(rows, head));
const requestOf = (links?: BranchLinks): BranchLinksCarrier => ({ branchLinks: links });

const load = (
  store: ReturnType<typeof createStore>,
  head: string | null | undefined,
  request?: BranchLinksCarrier | null,
  overrides: { user?: string | null; conversationId?: string } = {},
): Promise<Stored[]> =>
  loadHistoryRows({
    getMessages: store.getMessages,
    user: USER,
    conversationId: CONVERSATION,
    parentMessageId: head,
    request,
    ...overrides,
  });

const issuedFilter = (store: ReturnType<typeof createStore>): HistoryFilter =>
  store.getMessages.mock.calls[0][0];

describe('walkBranch', () => {
  it('lists a branch newest first, to its root', () => {
    expect(ids(walkBranch(branched(), 'a2b'))).toEqual(['a2b', 'u2b', 'a1', 'u1']);
  });

  it('ends at a parent no row has', () => {
    const rows = [stored('a1', 'gone'), stored('u2', 'a1', true), stored('a2', 'u2')];
    expect(ids(walkBranch(rows, 'a2'))).toEqual(['a2', 'u2', 'a1']);
  });

  it('ends when a row repeats', () => {
    const rows = [stored('a', 'b'), stored('b', 'a')];
    expect(ids(walkBranch(rows, 'a'))).toEqual(['a', 'b']);
  });

  it('is empty for a head no row has and for the root sentinel', () => {
    expect(walkBranch(branched(), 'unsaved')).toEqual([]);
    expect(walkBranch(branched(), NO_PARENT)).toEqual([]);
  });
});

describe('loadHistoryRows', () => {
  it('reads the whole conversation when the request carries no links', async () => {
    const store = createStore(branched());

    const rows = await load(store, 'a2b', requestOf());

    expect(store.getMessages).toHaveBeenCalledTimes(1);
    expect(issuedFilter(store)).toStrictEqual({ conversationId: CONVERSATION, user: USER });
    expect(store.getMessages).toHaveBeenCalledWith(expect.anything(), SELECT);
    expect(ids(rows)).toEqual(ids(store.all()));
  });

  it.each([
    ['an absent request', undefined],
    ['a null request', null],
  ])('reads the whole conversation for %s', async (_label, request) => {
    const store = createStore(branched());

    const rows = await load(store, 'a2b', request);

    expect(issuedFilter(store)).toStrictEqual({ conversationId: CONVERSATION, user: USER });
    expect(ids(rows)).toEqual(ids(store.all()));
  });

  it('issues exactly the whole-conversation query when the branch is every row', async () => {
    const store = createStore(linear());
    const request = requestOf(readLinks(store.all(), 'a2'));

    const rows = await load(store, 'a2', request);

    expect(store.getMessages).toHaveBeenCalledTimes(1);
    expect(issuedFilter(store)).toStrictEqual({ conversationId: CONVERSATION, user: USER });
    expect(store.getMessages).toHaveBeenCalledWith(expect.anything(), SELECT);
    expect(history(rows, 'a2')).toEqual(history(store.all(), 'a2'));
  });

  it('fetches only the branch when the conversation has other branches', async () => {
    const store = createStore(branched());
    const request = requestOf(readLinks(store.all(), 'a2b'));

    const rows = await load(store, 'a2b', request);

    expect(store.getMessages).toHaveBeenCalledTimes(1);
    const filter = issuedFilter(store);
    expect(Object.keys(filter).sort()).toEqual(['conversationId', 'messageId', 'user']);
    expect(filter).toMatchObject({ conversationId: CONVERSATION, user: USER });
    expect(sorted(filter.messageId?.$in ?? [])).toEqual(['a1', 'a2b', 'u1', 'u2b']);
    expect(store.getMessages).toHaveBeenCalledWith(expect.anything(), SELECT);
    expect(sorted(ids(rows))).toEqual(['a1', 'a2b', 'u1', 'u2b']);
    expect(history(rows, 'a2b')).toEqual(history(store.all(), 'a2b'));
  });

  /** A chain of `length` rows ending at `tail`, with `siblings` regenerated answers off its last user row. */
  const longChain = (length: number, siblings: number): { rows: Stored[]; tail: string } => {
    const rows: Stored[] = [];
    let parent = NO_PARENT;
    for (let i = 0; i < length; i++) {
      const messageId = `m${i}`;
      rows.push(stored(messageId, parent, i % 2 === 0));
      parent = messageId;
    }
    const anchor = rows[length - 2].messageId;
    for (let i = 0; i < siblings; i++) {
      rows.push(stored(`sibling${i}`, anchor));
    }
    return { rows, tail: parent };
  };

  it('reads the whole conversation when under a tenth of its rows are off the branch', async () => {
    const { rows: seeded, tail } = longChain(40, 1);
    const store = createStore(seeded);

    const rows = await load(store, tail, requestOf(readLinks(store.all(), tail)));

    expect(store.getMessages).toHaveBeenCalledTimes(1);
    expect(issuedFilter(store)).toStrictEqual({ conversationId: CONVERSATION, user: USER });
    expect(history(rows, tail)).toEqual(history(store.all(), tail));
  });

  it('fetches only the branch once a tenth of the rows are off it', async () => {
    const { rows: seeded, tail } = longChain(36, 4);
    const store = createStore(seeded);

    const rows = await load(store, tail, requestOf(readLinks(store.all(), tail)));

    expect(store.getMessages).toHaveBeenCalledTimes(1);
    expect(issuedFilter(store).messageId?.$in).toHaveLength(36);
    expect(rows).toHaveLength(36);
    expect(history(rows, tail)).toEqual(history(store.all(), tail));
  });

  it('keeps the whole-conversation order of the rows it fetches', async () => {
    const store = createStore(branched());

    const rows = await load(store, 'a2b', requestOf(readLinks(store.all(), 'a2b')));

    expect(ids(rows)).toEqual(['u1', 'a1', 'u2b', 'a2b']);
  });

  it('reads the whole branch of a chain that ends at a missing parent', async () => {
    const store = createStore([
      stored('a1', 'gone'),
      stored('u2', 'a1', true),
      stored('a2', 'u2'),
      stored('x', 'a1', true),
    ]);

    const rows = await load(store, 'a2', requestOf(readLinks(store.all(), 'a2')));

    expect(sorted(issuedFilter(store).messageId?.$in ?? [])).toEqual(['a1', 'a2', 'u2']);
    expect(history(rows, 'a2')).toEqual(history(store.all(), 'a2'));
  });

  it('reads the whole branch of a chain that loops', async () => {
    const store = createStore([stored('a', 'b'), stored('b', 'a'), stored('c', 'a')]);

    const rows = await load(store, 'b', requestOf(readLinks(store.all(), 'b')));

    expect(sorted(issuedFilter(store).messageId?.$in ?? [])).toEqual(['a', 'b']);
    expect(history(rows, 'b')).toEqual(history(store.all(), 'b'));
  });

  it('reads the whole conversation when the head is not among the links', async () => {
    const store = createStore(branched());
    const request = requestOf(readLinks(store.all(), 'a3'));
    store.rows.push(stored('a3', 'a2b'));

    const rows = await load(store, 'a3', request);

    expect(issuedFilter(store)).toStrictEqual({ conversationId: CONVERSATION, user: USER });
    expect(history(rows, 'a3')).toEqual(['u1', 'a1', 'u2b', 'a2b', 'a3']);
    expect(history(rows, 'a3')).toEqual(history(store.all(), 'a3'));
  });

  it.each(['u1', 'a1', 'u2b', 'a2b'])(
    'matches a whole read when %s was deleted after the links were read',
    async (deleted) => {
      const store = createStore(branched());
      const request = requestOf(readLinks(store.all(), 'a2b'));
      store.rows.splice(
        store.rows.findIndex((row) => row.messageId === deleted),
        1,
      );

      const rows = await load(store, 'a2b', request);

      expect(history(rows, 'a2b')).toEqual(history(store.all(), 'a2b'));
    },
  );

  it.each([
    ['another conversation', { conversationId: 'convo-2' }],
    ['another user', { user: 'user-2' }],
    ['no user', { user: null }],
  ])('reads the whole conversation when the links are for %s', async (_label, overrides) => {
    const store = createStore(branched());
    const request = requestOf(readLinks(store.all(), 'a2b'));

    await load(store, 'a2b', request, overrides);

    expect(issuedFilter(store).messageId).toBeUndefined();
  });

  it.each([
    ['another head, as an edited turn has', 'a2'],
    ['no head', null],
    ['an unset head', undefined],
  ])('reads the whole conversation when the history starts from %s', async (_label, head) => {
    const store = createStore(branched());
    const request = requestOf(readLinks(store.all(), 'a2b'));

    await load(store, head, request);

    expect(issuedFilter(store).messageId).toBeUndefined();
  });

  it.each([
    ['used', branched(), 'a2b', 'a2b'],
    ['unused because the branch is every row', linear(), 'a2', 'a2'],
    ['unused because the head does not match', branched(), 'a2b', 'a2'],
  ])(
    'clears the links from the request once they are %s',
    async (_label, rows, linksHead, head) => {
      const store = createStore(rows);
      const request = requestOf(readLinks(store.all(), linksHead));

      await load(store, head, request);

      expect('branchLinks' in request).toBe(false);
    },
  );

  it('returns the rows the reader returned, and an empty list for none', async () => {
    const result = [stored('u1', NO_PARENT, true)];

    await expect(
      loadHistoryRows({
        getMessages: jest.fn().mockResolvedValue(result),
        user: USER,
        conversationId: CONVERSATION,
        parentMessageId: 'u1',
      }),
    ).resolves.toBe(result);
    for (const empty of [null, undefined]) {
      await expect(
        loadHistoryRows({
          getMessages: jest.fn().mockResolvedValue(empty),
          user: USER,
          conversationId: CONVERSATION,
          parentMessageId: 'u1',
        }),
      ).resolves.toEqual([]);
    }
  });

  it('propagates a failed read instead of answering with no history', async () => {
    const failure = new Error('read failed');

    await expect(
      loadHistoryRows({
        getMessages: jest.fn().mockRejectedValue(failure),
        user: USER,
        conversationId: CONVERSATION,
        parentMessageId: 'u1',
      }),
    ).rejects.toBe(failure);
  });
});

describe('loadHistoryRows for the retained-answer scan', () => {
  const ask = (id: string, question: string, answer: string) => ({
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id,
      name: 'ask_user_question',
      args: JSON.stringify({ question }),
      output: answer,
      progress: 1,
    },
  });
  const summary = {
    type: ContentTypes.SUMMARY,
    text: 'Earlier context, compacted.',
    tokenCount: 5,
  };
  const countChars = (text: string): number => text.length;
  const newUser = { messageId: 'new-user', parentMessageId: 'a3b', isCreatedByUser: true };

  const blockFor = async (rows: Stored[]): Promise<string | undefined> =>
    (
      await prepareRetainedAnswers({
        messages: [newUser],
        parentMessageId: newUser.messageId,
        storedRows: rows,
        config: undefined,
        countTokens: countChars,
      })
    ).block;

  it('finds every answer on the branch, past a checkpoint summary, and none from a sibling branch', async () => {
    const store = createStore([
      stored('u1', NO_PARENT, true),
      stored('a1', 'u1', false, [ask('tc-1', 'What should I name the file?', 'notes.md')]),
      stored('u2', 'a1', true),
      stored('a2', 'u2', false, [summary, { type: ContentTypes.TEXT, text: 'Deployed.' }]),
      stored('u3', 'a2', true),
      stored('a3', 'u3', false, [ask('tc-2', 'Which region?', 'eu-west-sibling')]),
      stored('u3b', 'a2', true),
      stored('a3b', 'u3b', false, [ask('tc-3', 'Which window?', 'last 7 days')]),
    ]);

    const rows = await load(store, 'a3b', requestOf(readLinks(store.all(), 'a3b')));

    expect(sorted(issuedFilter(store).messageId?.$in ?? [])).toEqual([
      'a1',
      'a2',
      'a3b',
      'u1',
      'u2',
      'u3b',
    ]);
    const narrowed = await blockFor(rows);
    expect(narrowed).toBe(await blockFor(store.all()));
    expect(narrowed).toContain('notes.md');
    expect(narrowed).toContain('last 7 days');
    expect(narrowed).not.toContain('eu-west-sibling');
  });
});
