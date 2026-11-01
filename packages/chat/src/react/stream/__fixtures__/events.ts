import type { EventServices } from '../services';

/** Event services with no app behind them: an empty cache, a new-chat route, and every effect a spy. */
export const createEventServices = (overrides: Partial<EventServices> = {}): EventServices => ({
  conversations: {
    upsert: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    listEntry: (conversation) => conversation,
    getTitle: ({ currentTitle, titleSetByUser, titleRevision }) => ({
      title: currentTitle ?? null,
      titleSetByUser,
      titleRevision,
    }),
    commitReply: jest.fn(),
  },
  titles: { queue: jest.fn(), markProcessed: jest.fn(), setDocumentTitle: jest.fn() },
  drafts: {
    save: jest.fn(),
    getId: (runIndex, conversationId) => conversationId ?? `new-${runIndex}`,
    adopt: jest.fn(),
  },
  navigation: { pathname: '/c/new', conversationId: 'new', navigate: jest.fn() },
  focus: {
    announce: jest.fn(),
    showRegenerated: jest.fn(),
    focusComposer: jest.fn(),
    scrollToEnd: jest.fn(),
  },
  templates: { apply: jest.fn(), reconcileFailedCode: jest.fn() },
  transport: { abortRun: jest.fn(async () => new Response(null, { status: 204 })) },
  logger: { log: jest.fn(), dir: jest.fn(), warn: jest.fn() },
  ...overrides,
});
