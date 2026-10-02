import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TAttachment } from 'librechat-data-provider';
import type {
  MessagePartArtifactPanel,
  MessagePartMessage,
  MessagePartsHost,
} from '~/hooks/Chat/contract';
import type { Artifact, PtcTrace } from '~/common';
import { MessagePartsHostProvider, appMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import ToolArtifactCard from '../ToolArtifactCard';
import PtcToolTrace from '../PtcToolTrace';
import TextPart from '../Text';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
jest.mock('~/hooks/MCP', () => ({ useMCPServerNames: () => [] }));
jest.mock('~/hooks/Messages/useSmoothStreaming', () => () => false);
jest.mock('~/components/Chat/Messages/Content/Markdown', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));
jest.mock('~/components/Chat/Messages/Content/MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="markdown-lite">{content}</div>,
}));
jest.mock('../LogLink', () => ({
  useAttachmentLink: () => ({ handleDownload: jest.fn() }),
}));

/** A host backed by plain values: rendering under it must not touch Recoil, Jotai or app providers. */
function createHost(overrides: Partial<MessagePartsHost> = {}): MessagePartsHost {
  const message: MessagePartMessage = { messageId: 'msg-1', isSubmitting: false };
  return {
    ...appMessagePartsHost,
    useMessage: () => message,
    useFontSize: () => 'text-base',
    useShowThinking: () => false,
    useUserTextPreferences: () => ({
      usernameDisplay: false,
      enableUserMsgMarkdown: false,
      collapseLongUserMessages: false,
    }),
    useUser: () => undefined,
    useFileMap: () => undefined,
    useToast: () => jest.fn(),
    useSandboxStarting: () => false,
    usePtcTrace: () => ({ entries: [], dropped: 0 }),
    useToolArtifactClaim: () => [null, jest.fn()],
    usePendingSteers: () => [],
    useSteerEscalating: () => false,
    usePaneConversationId: () => null,
    useLiveAppliedSteer: () => [false, jest.fn()],
    ...overrides,
  };
}

function createPanel(overrides: Partial<MessagePartArtifactPanel> = {}): MessagePartArtifactPanel {
  return {
    currentArtifactId: null,
    registered: undefined,
    register: jest.fn(),
    open: jest.fn(),
    close: jest.fn(),
    consumeJustResolved: jest.fn(() => false),
    ...overrides,
  };
}

const artifact = {
  id: 'artifact-1',
  type: 'text/html',
  title: 'report.html',
  content: '<p>hi</p>',
} as Artifact;

const attachment = {
  file_id: 'file-1',
  filename: 'report.html',
  filepath: '/files/report.html',
  messageId: 'msg-1',
} as unknown as TAttachment;

describe('message parts host', () => {
  it('renders user text from the host preferences without an app store', () => {
    render(
      <MessagePartsHostProvider host={createHost()}>
        <TextPart text="plain *words*" isCreatedByUser={true} showCursor={false} />
      </MessagePartsHostProvider>,
    );
    expect(screen.queryByTestId('markdown-lite')).toBeNull();
    expect(screen.getByText('plain *words*')).toHaveClass('whitespace-pre-wrap');
  });

  it('honors the host markdown preference for user text', () => {
    const host = createHost({
      useUserTextPreferences: () => ({
        usernameDisplay: false,
        enableUserMsgMarkdown: true,
        collapseLongUserMessages: false,
      }),
    });
    render(
      <MessagePartsHostProvider host={host}>
        <TextPart text="plain *words*" isCreatedByUser={true} showCursor={false} />
      </MessagePartsHostProvider>,
    );
    expect(screen.getByTestId('markdown-lite')).toHaveTextContent('plain *words*');
  });

  it('reads the PTC trace for its own message and tool call from the host', () => {
    const trace: PtcTrace = {
      entries: [{ callId: 'c1', name: 'search_code', status: 'success' }],
      dropped: 0,
    };
    const usePtcTrace = jest.fn(() => trace);
    render(
      <MessagePartsHostProvider host={createHost({ usePtcTrace })}>
        <PtcToolTrace toolCallId="call-1" />
      </MessagePartsHostProvider>,
    );
    expect(usePtcTrace).toHaveBeenCalledWith('msg-1', 'call-1');
    expect(screen.getByText(/search_code/)).toBeInTheDocument();
  });

  it('auto-opens an artifact card mounted while its message streams', () => {
    const panel = createPanel();
    const host = createHost({
      useMessage: () => ({ messageId: 'msg-1', isSubmitting: true }),
      useArtifactPanel: () => panel,
    });
    render(
      <MessagePartsHostProvider host={host}>
        <ToolArtifactCard attachment={attachment} artifact={artifact} />
      </MessagePartsHostProvider>,
    );
    expect(panel.register).not.toHaveBeenCalled();
    expect(panel.open).toHaveBeenCalledWith('artifact-1');
  });

  it('registers as the claim holder and toggles the panel through the host', () => {
    const panel = createPanel({ currentArtifactId: 'artifact-1' });
    const setClaim = jest.fn();
    const host = createHost({
      useArtifactPanel: () => panel,
      useToolArtifactClaim: () => [null, setClaim],
    });
    const { rerender } = render(
      <MessagePartsHostProvider host={host}>
        <ToolArtifactCard attachment={attachment} artifact={artifact} />
      </MessagePartsHostProvider>,
    );
    expect(setClaim).toHaveBeenCalledWith(expect.any(String));
    expect(panel.open).not.toHaveBeenCalled();
    expect(panel.consumeJustResolved).toHaveBeenCalledWith('msg-1', 'file-1');

    fireEvent.click(screen.getByRole('button', { expanded: true }));
    expect(panel.close).toHaveBeenCalledTimes(1);

    const claimKey = setClaim.mock.calls[0][0] as string;
    const claimed = createHost({
      useArtifactPanel: () => panel,
      useToolArtifactClaim: () => [claimKey, setClaim],
    });
    rerender(
      <MessagePartsHostProvider host={claimed}>
        <ToolArtifactCard attachment={attachment} artifact={artifact} />
      </MessagePartsHostProvider>,
    );
    expect(panel.register).toHaveBeenCalledWith(artifact);
  });
});
