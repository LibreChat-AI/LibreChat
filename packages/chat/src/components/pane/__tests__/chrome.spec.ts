import type { TChatProject, TConversation } from 'librechat-data-provider';
import type { ChatPaneChrome } from '../chrome';
import type { ChatPaneView } from '../view';
import { getChatPaneChrome } from '../chrome';

type Input = Parameters<typeof getChatPaneChrome>[0];

/**
 * The derivation as `ChatView` wrote it inline before it moved here, line for line, so the
 * helper is held to the decisions the app made, not to a restatement of them.
 */
function inlineChatView({
  view,
  conversation,
  conversationId,
  project,
  landingFooter,
  configuredFooter,
}: Input): ChatPaneChrome {
  const activeConversation =
    conversation?.conversationId === conversationId ? conversation : undefined;
  const activeSubagentThread = activeConversation?.subagentThread;
  const chatProjectId = activeConversation?.chatProjectId || undefined;
  const { isLanding: isLandingPage } = view;
  const fullFooter = isLandingPage && landingFooter;
  const footerBelow = fullFooter || configuredFooter;
  const isProjectLandingPage = isLandingPage && project != null;
  const conversationTitle = activeConversation?.title?.trim();
  const newChat = isLandingPage || !conversationTitle;
  const parentConversationId = activeSubagentThread?.parentConversationId;
  const isSubagentThreadReadOnly = activeSubagentThread != null;
  return {
    title: newChat ? null : (conversationTitle ?? null),
    fullFooter,
    bandFooter: !fullFooter && configuredFooter,
    footerBelow,
    landingProject: isProjectLandingPage ? project : undefined,
    projectId: chatProjectId,
    readOnly: isSubagentThreadReadOnly,
    parentConversationId,
  };
}

const project = { _id: 'p1', name: 'Research' } as unknown as TChatProject;
const lineage = {
  rootConversationId: 'parent',
  parentConversationId: 'parent',
  parentMessageId: 'm1',
  parentToolCallId: 'call-1',
  subagentType: 'researcher',
  subagentKind: 'agent',
  depth: 1,
} as TConversation['subagentThread'];

const conversations: Array<TConversation | null> = [
  null,
  { conversationId: 'c1', title: 'Plans' } as TConversation,
  { conversationId: 'c1', title: '  Plans  ' } as TConversation,
  { conversationId: 'c1', title: '   ' } as TConversation,
  { conversationId: 'c1' } as TConversation,
  { conversationId: 'other', title: 'Lagging', chatProjectId: 'p2' } as TConversation,
  { conversationId: 'c1', title: 'Child', subagentThread: lineage } as TConversation,
  { conversationId: 'c1', title: 'In project', chatProjectId: 'p1' } as TConversation,
  { conversationId: 'c1', title: 'Empty project', chatProjectId: '' } as TConversation,
];

const views: ChatPaneView[] = [
  { isLanding: true, column: 'landing' },
  { isLanding: true, column: 'loading' },
  { isLanding: false, column: 'messages' },
  { isLanding: false, column: 'loading' },
];

function* inputs(): Generator<Input> {
  for (const view of views) {
    for (const conversation of conversations) {
      for (const conversationId of ['c1', undefined]) {
        for (const routeProject of [undefined, project]) {
          for (const landingFooter of [false, true]) {
            for (const configuredFooter of [false, true]) {
              yield {
                view,
                conversation,
                conversationId,
                project: routeProject,
                landingFooter,
                configuredFooter,
              };
            }
          }
        }
      }
    }
  }
}

describe('getChatPaneChrome', () => {
  it('makes the decisions ChatView made inline, for every combination', () => {
    let cases = 0;
    for (const input of inputs()) {
      expect(getChatPaneChrome(input)).toEqual(inlineChatView(input));
      cases += 1;
    }
    expect(cases).toBe(views.length * conversations.length * 2 * 2 * 2 * 2);
  });

  const conversationView: ChatPaneView = { isLanding: false, column: 'messages' };
  const landingView: ChatPaneView = { isLanding: true, column: 'landing' };
  const base = { landingFooter: true, configuredFooter: false };

  it.each([
    ['the routed conversation names the heading, trimmed', conversations[2], 'c1', 'Plans'],
    ['a blank title falls back to the new-chat label', conversations[3], 'c1', null],
    ['a conversation that lags the route never names it', conversations[5], 'c1', null],
  ])('%s', (_name, conversation, conversationId, title) => {
    const chrome = getChatPaneChrome({
      ...base,
      view: conversationView,
      conversation,
      conversationId,
    });
    expect(chrome.title).toBe(title);
  });

  it('labels the welcome screen as a new chat even when the conversation has a title', () => {
    const chrome = getChatPaneChrome({
      ...base,
      view: landingView,
      conversation: conversations[1],
      conversationId: 'c1',
    });
    expect(chrome.title).toBeNull();
  });

  it.each([
    [landingView, true, false, { fullFooter: true, bandFooter: false, footerBelow: true }],
    [landingView, true, true, { fullFooter: true, bandFooter: false, footerBelow: true }],
    [landingView, false, true, { fullFooter: false, bandFooter: true, footerBelow: true }],
    [landingView, false, false, { fullFooter: false, bandFooter: false, footerBelow: false }],
    [conversationView, true, false, { fullFooter: false, bandFooter: false, footerBelow: false }],
    [conversationView, true, true, { fullFooter: false, bandFooter: true, footerBelow: true }],
  ])('places the footers (%#)', (view, landingFooter, configuredFooter, expected) => {
    expect(getChatPaneChrome({ view, landingFooter, configuredFooter })).toMatchObject(expected);
  });

  it('starts a new chat in the routed project only on the welcome screen', () => {
    expect(getChatPaneChrome({ ...base, view: landingView, project }).landingProject).toBe(project);
    expect(
      getChatPaneChrome({ ...base, view: conversationView, project }).landingProject,
    ).toBeUndefined();
  });

  it("badges the routed conversation's project, not a lagging one's", () => {
    expect(
      getChatPaneChrome({
        ...base,
        view: conversationView,
        conversation: conversations[7],
        conversationId: 'c1',
      }).projectId,
    ).toBe('p1');
    expect(
      getChatPaneChrome({
        ...base,
        view: conversationView,
        conversation: conversations[5],
        conversationId: 'c1',
      }).projectId,
    ).toBeUndefined();
  });

  it("makes a subagent's thread read-only and names its parent", () => {
    expect(
      getChatPaneChrome({
        ...base,
        view: conversationView,
        conversation: conversations[6],
        conversationId: 'c1',
      }),
    ).toMatchObject({ readOnly: true, parentConversationId: 'parent' });
    expect(
      getChatPaneChrome({
        ...base,
        view: conversationView,
        conversation: conversations[6],
        conversationId: undefined,
      }),
    ).toMatchObject({ readOnly: false, parentConversationId: undefined });
  });
});
