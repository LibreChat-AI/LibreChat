import { RecoilRoot } from 'recoil';
import { ContentTypes, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageChatContext } from '~/common';
import { OwnerTextProvider } from '~/components/Chat/Messages/PrivateText';
import MessageRender from '~/components/Chat/Messages/ui/MessageRender';
import ContentRender from '../ContentRender';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getOwnerMessageTexts: jest.fn(),
  },
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { id: 'owner', tenantId: 'tenant' } }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachments: () => ({}),
  useContentMetadata: () => ({ hasParallelContent: false }),
  useMessageActions: () => ({
    edit: false,
    index: 0,
    conversation: { conversationId: 'protected-conversation', endpoint: 'agents' },
    messageLabel: 'You',
    getCanCopy: () => true,
  }),
}));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Messages/HoverButtons', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Messages/SiblingSwitch', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Messages/Elapsed', () => ({
  __esModule: true,
  default: () => null,
  shouldShowElapsed: () => false,
}));

const canonical: TMessage = {
  messageId: 'protected-message',
  parentMessageId: 'parent',
  conversationId: 'protected-conversation',
  isCreatedByUser: true,
  text: '[EMAIL_1_turn]',
  privacyRevision: 'turn',
  files: [
    { file_id: 'notes', filename: 'notes.txt', type: 'text/plain', bytes: 128 },
    {
      file_id: 'image',
      filename: 'preview.png',
      type: 'image/png',
      filepath: '/images/preview.png',
      width: 320,
      height: 180,
    },
  ],
};
const original = {
  messageId: canonical.messageId,
  canonicalText: canonical.text,
  revision: 'turn',
  text: 'alice@example.com',
};
const chatContext = { latestMessageId: canonical.messageId } as TMessageChatContext;

for (const [name, Row] of [
  ['plain', MessageRender],
  ['structured', ContentRender],
] as const) {
  describe(`${name} protected attachments`, () => {
    const message: TMessage = {
      ...canonical,
      ...(name === 'structured'
        ? { content: [{ type: ContentTypes.TEXT, text: canonical.text }] }
        : {}),
    };
    function renderMessage(overrides: Partial<TMessage> = {}) {
      const current = { ...message, ...overrides };
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return render(
        <QueryClientProvider client={queryClient}>
          <RecoilRoot>
            <OwnerTextProvider
              messages={[current]}
              conversationId={current.conversationId ?? undefined}
              isSubmitting={false}
            >
              <Row message={current} chatContext={chatContext} currentEditId={null} />
            </OwnerTextProvider>
          </RecoilRoot>
        </QueryClientProvider>,
      );
    }

    function expectAttachments() {
      const attachments = screen.getByTestId('message-attachments');
      const body = screen.getByTestId('message-body');
      expect(within(attachments).getByRole('button', { name: 'notes.txt' })).toBeVisible();
      expect(
        within(attachments).getByRole('button', { name: 'View preview.png in dialog' }),
      ).toBeVisible();
      expect(body).not.toContainElement(attachments);
      return attachments;
    }

    it('preserves previews while owner text loads and after it resolves', async () => {
      let finish!: (value: { messages: (typeof original)[] }) => void;
      (dataService.getOwnerMessageTexts as jest.Mock).mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      renderMessage();
      expectAttachments();
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_loading');
      await act(async () => finish({ messages: [original] }));
      expect(await screen.findByText(original.text)).toBeInTheDocument();
      expectAttachments();
      expect(message.text).toBe(canonical.text);
      fireEvent.click(screen.getByRole('button', { name: 'View preview.png in dialog' }));
      expect(await screen.findByRole('dialog')).toBeVisible();
    });

    it('keeps attachments and private-text recovery when canonical text is empty', async () => {
      (dataService.getOwnerMessageTexts as jest.Mock).mockResolvedValue({ messages: [] });
      renderMessage({ text: '', content: [] });
      expectAttachments();
      expect(
        await screen.findByRole('button', { name: 'com_ui_private_text_retry' }),
      ).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent('com_ui_private_text_unavailable');
      expectAttachments();
    });
  });
}
