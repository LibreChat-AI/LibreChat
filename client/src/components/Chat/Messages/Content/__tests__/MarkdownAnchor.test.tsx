import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { TAttachment, TMessage } from 'librechat-data-provider';
import { MediaContext, ConversationFilesContext } from '~/Providers/MediaContext';
import { buildFilesByName, buildConversationFilesByName } from '~/utils/media';
import { a as MarkdownAnchor } from '../MarkdownComponents';
import { triggerDownload } from '~/utils';

jest.mock('~/utils', () => ({ ...jest.requireActual('~/utils'), triggerDownload: jest.fn() }));

jest.mock('~/Providers/MessagePartsHostContext', () => ({
  useMessagePartsHost: () => ({ useUser: () => ({ id: 'u1' }), useToast: () => jest.fn() }),
}));
jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers/MediaContext'),
  useCodeBlockContext: jest.fn(),
  useShareContext: () => ({}),
}));
jest.mock('~/data-provider', () => ({
  useFileDownload: () => ({ refetch: jest.fn() }),
  useCodeOutputDownload: () => ({ refetch: jest.fn().mockResolvedValue({ data: 'blob:deck' }) }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);
jest.mock('~/hooks/Roles/useHasAccess', () => () => true);
jest.mock('~/components/Messages/Content/CodeBlock', () => () => null);
jest.mock('~/components/Messages/Content/Mermaid', () => ({
  __esModule: true,
  default: () => null,
  MermaidErrorBoundary: () => null,
}));

const LINK_TEXT = 'link text';

const deck = {
  filename: 'deck.pptx',
  filepath: '/api/files/code/download/sess/abc/deck.pptx',
  conversationId: 'c1',
} as unknown as TAttachment;

const renderAnchor = (
  href: string,
  attachments: TAttachment[] = [],
  conversationAttachments: TAttachment[] = [],
) =>
  render(
    <ConversationFilesContext.Provider
      value={buildConversationFilesByName([
        { attachments: conversationAttachments } as unknown as TMessage,
      ])}
    >
      <MediaContext.Provider value={{ filesByName: buildFilesByName(attachments) }}>
        <MarkdownAnchor href={href}>{LINK_TEXT}</MarkdownAnchor>
      </MediaContext.Provider>
    </ConversationFilesContext.Provider>,
  );

describe('markdown a', () => {
  it('downloads the attachment a sandbox path names instead of navigating', async () => {
    renderAnchor('/mnt/data/deck.pptx', [deck]);
    const anchor = screen.getByRole('link', { name: LINK_TEXT });
    expect(anchor).toHaveAttribute('href', deck.filepath);
    // handleDownload calls preventDefault; fireEvent returns false when it did.
    expect(fireEvent.click(anchor)).toBe(false);
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('blob:deck', 'deck.pptx'));
  });

  it('renders plain text for a sandbox path nothing matches', () => {
    const { container } = renderAnchor('/mnt/data/missing.pptx', [deck]);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(LINK_TEXT)).toBeInTheDocument();
  });

  it('leaves a normal link unchanged', () => {
    renderAnchor('https://example.com/page', [deck]);
    const anchor = screen.getByRole('link', { name: LINK_TEXT });
    expect(anchor).toHaveAttribute('href', 'https://example.com/page');
    expect(anchor).toHaveAttribute('target', '_blank');
  });

  it('falls back to a file an earlier turn produced', async () => {
    renderAnchor('/mnt/data/deck.pptx', [], [deck]);
    const anchor = screen.getByRole('link', { name: LINK_TEXT });
    expect(anchor).toHaveAttribute('href', deck.filepath);
    fireEvent.click(anchor);
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledWith('blob:deck', 'deck.pptx'));
  });

  it("prefers the turn's own file over the conversation's", () => {
    const older = {
      ...deck,
      file_id: 'old',
      filepath: '/api/files/code/download/sess/old/deck.pptx',
    } as unknown as TAttachment;
    renderAnchor('/mnt/data/deck.pptx', [deck], [older]);
    expect(screen.getByRole('link', { name: LINK_TEXT })).toHaveAttribute('href', deck.filepath);
  });

  it('renders plain text when neither the turn nor the conversation has the file', () => {
    const { container } = renderAnchor('/mnt/data/deck.pptx');
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(LINK_TEXT).tagName).toBe('SPAN');
  });

  it("does not fall back when the turn's own files name the basename ambiguously", () => {
    const other = {
      ...deck,
      file_id: 'other',
      filepath: '/api/files/code/download/sess/other/deck.pptx',
    } as unknown as TAttachment;
    const third = {
      ...deck,
      file_id: 'third',
      filepath: '/api/files/code/download/sess/third/deck.pptx',
    } as unknown as TAttachment;
    const first = { ...deck, file_id: 'first' } as unknown as TAttachment;
    const { container } = renderAnchor('/mnt/data/deck.pptx', [first, other], [third]);
    expect(container.querySelector('a')).toBeNull();
    expect(screen.getByText(LINK_TEXT).tagName).toBe('SPAN');
  });
});
