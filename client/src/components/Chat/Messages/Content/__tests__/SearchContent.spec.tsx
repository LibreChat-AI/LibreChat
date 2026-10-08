import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen } from '@testing-library/react';
import { ContentTypes, ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import SearchContent, {
  rendersMarkdownLite,
} from '~/components/Chat/Messages/Content/SearchContent';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/** `Container` reads message context for sequential-agent layout; not under test. */
jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

/**
 * Stands in for the dispatcher so this spec asserts routing; its copy is `Error.spec.tsx`'s. It
 * reports both identities it could render with: the row it was handed and the surrounding source.
 */
jest.mock('~/components/Messages/Content/Error', () => {
  const { useErrorSource } = jest.requireActual('~/components/Messages/Content/Error/source');
  return {
    __esModule: true,
    default: function ErrorDispatcher({ text, message }: { text: string; message?: TMessage }) {
      const source = useErrorSource();
      return (
        <span
          data-testid="error-dispatcher"
          data-endpoint={message?.endpoint}
          data-source-endpoint={source?.endpoint}
          data-source-agent={source?.partAgentId}
        >
          {text}
        </span>
      );
    },
  };
});

jest.mock('../MarkdownLite', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div data-testid="markdown-lite">{content}</div>,
}));

const message = (overrides: Partial<TMessage> = {}): TMessage =>
  ({ messageId: 'm', text: 'hi', ...overrides }) as TMessage;

describe('rendersMarkdownLite', () => {
  it('is true when there are no content parts to render', () => {
    expect(rendersMarkdownLite(message())).toBe(true);
    expect(rendersMarkdownLite(message({ content: [] }))).toBe(true);
  });

  it('is false once content parts drive the rendering', () => {
    expect(
      rendersMarkdownLite(
        message({ content: [{ type: ContentTypes.TEXT, text: 'hi' } as TMessageContentParts] }),
      ),
    ).toBe(false);
  });

  it('is false for a failed row, which renders through the error dispatcher', () => {
    expect(rendersMarkdownLite(message({ error: true }))).toBe(false);
  });
});

describe('SearchContent', () => {
  /** Search and shared views persist no content parts for a failed turn, only its payload. */
  it('routes a failed row to the error dispatcher instead of rendering its payload', () => {
    const text = JSON.stringify({ type: ErrorTypes.NO_USER_KEY });
    render(
      <RecoilRoot>
        <SearchContent message={message({ error: true, text, endpoint: 'openAI' })} />
      </RecoilRoot>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('error-dispatcher')).toHaveAttribute('data-endpoint', 'openAI');
    expect(screen.queryByTestId('markdown-lite')).not.toBeInTheDocument();
  });

  it('keeps rendering an ordinary text-only row as markdown', () => {
    render(
      <RecoilRoot>
        <SearchContent message={message({ text: 'A plain answer.' })} />
      </RecoilRoot>,
    );

    expect(screen.getByTestId('markdown-lite')).toHaveTextContent('A plain answer.');
    expect(screen.queryByTestId('error-dispatcher')).not.toBeInTheDocument();
  });

  /** `Part` renders an error part without its message, so the row has to supply its identity. */
  it("gives an error part its row's identity", () => {
    const text = JSON.stringify({ type: ViolationTypes.MESSAGE_LIMIT });
    render(
      <RecoilRoot>
        <SearchContent
          message={message({
            endpoint: 'anthropic',
            content: [{ type: ContentTypes.ERROR, error: text } as TMessageContentParts],
          })}
        />
      </RecoilRoot>,
    );

    const dispatcher = screen.getByTestId('error-dispatcher');
    expect(dispatcher).toHaveTextContent(text);
    expect(dispatcher).not.toHaveAttribute('data-endpoint');
    expect(dispatcher).toHaveAttribute('data-source-endpoint', 'anthropic');
  });

  it('resolves an error part after a handoff to the agent the run was handed to', () => {
    const text = JSON.stringify({ type: ViolationTypes.MESSAGE_LIMIT });
    render(
      <RecoilRoot>
        <SearchContent
          message={message({
            endpoint: 'agents',
            model: 'agent_root',
            content: [
              { type: ContentTypes.TEXT, text: 'Drafting the outline.' },
              {
                type: ContentTypes.AGENT_UPDATE,
                agent_update: { agentId: 'agent_writer', index: 1 },
              } as TMessageContentParts,
              { type: ContentTypes.ERROR, error: text } as TMessageContentParts,
            ] as TMessageContentParts[],
          })}
        />
      </RecoilRoot>,
    );

    expect(screen.getByTestId('error-dispatcher')).toHaveAttribute(
      'data-source-agent',
      'agent_writer',
    );
  });
});
