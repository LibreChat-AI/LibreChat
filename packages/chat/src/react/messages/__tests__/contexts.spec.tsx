/**
 * @jest-environment jsdom
 */
import { useContext } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { ErrorSourceProvider, useErrorSource } from '../error';
import { AuthorContext, useAuthorContext } from '../author';
import { MessageSurfaceContext } from '../surface';
import { MessageContext } from '../../message';

function Source() {
  const source = useErrorSource();
  return <output>{source == null ? 'none' : JSON.stringify(source)}</output>;
}

function atPart(partIndex: number | undefined, children: ReactNode) {
  return (
    <MessageContext.Provider value={{ messageId: 'm1', isExpanded: false, partIndex }}>
      {children}
    </MessageContext.Provider>
  );
}

const createdAt = '2026-10-31T10:00:00.000Z';

function renderSource(content: TMessage['content'], partIndex?: number) {
  return render(
    <ErrorSourceProvider message={{ endpoint: 'agents', model: 'gpt-x', createdAt, content }}>
      {atPart(partIndex, <Source />)}
    </ErrorSourceProvider>,
  );
}

const readSource = () => JSON.parse(screen.getByRole('status').textContent ?? '{}');

describe('ErrorSourceProvider', () => {
  it('reports nothing outside a message row', () => {
    render(atPart(0, <Source />));

    expect(screen.getByRole('status')).toHaveTextContent('none');
  });

  it("names the row's endpoint, model and time for a single-agent row", () => {
    renderSource([{ type: ContentTypes.TEXT, text: 'hi' }], 0);

    expect(readSource()).toEqual({ endpoint: 'agents', model: 'gpt-x', createdAt });
  });

  it('resolves the agent a handoff before the failing part made active', () => {
    renderSource(
      [
        { type: ContentTypes.AGENT_UPDATE, agent_update: { agentId: 'agent_a' } },
        { type: ContentTypes.TEXT, text: 'first' },
        { type: ContentTypes.AGENT_UPDATE, agent_update: { agentId: 'agent_b' } },
        { type: ContentTypes.ERROR, error: 'boom' },
      ] as TMessage['content'],
      3,
    );

    expect(readSource().partAgentId).toBe('agent_b');
  });

  it('prefers the agent a parallel lane stamped on the error part', () => {
    renderSource(
      [
        { type: ContentTypes.AGENT_UPDATE, agent_update: { agentId: 'agent_a' } },
        { type: ContentTypes.ERROR, error: 'boom', agentId: 'agent_lane' },
      ] as TMessage['content'],
      1,
    );

    expect(readSource().partAgentId).toBe('agent_lane');
  });
});

describe('AuthorContext', () => {
  function Author() {
    const author = useAuthorContext();
    return <output>{author?.label ?? 'none'}</output>;
  }

  it('is empty until a row supplies its author', () => {
    render(<Author />);
    expect(screen.getByRole('status')).toHaveTextContent('none');
  });

  it('passes the row author to the headers inside its content', () => {
    render(
      <AuthorContext.Provider value={{ icon: null, label: 'Research Agent' }}>
        <Author />
      </AuthorContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Research Agent');
  });
});

describe('MessageSurfaceContext', () => {
  function Surface() {
    return <output>{useContext(MessageSurfaceContext)}</output>;
  }

  it('defaults to the chat canvas and follows the host surface', () => {
    const { rerender } = render(<Surface />);
    expect(screen.getByRole('status')).toHaveTextContent('bg-surface-primary-alt');

    rerender(
      <MessageSurfaceContext.Provider value="bg-surface-dialog">
        <Surface />
      </MessageSurfaceContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('bg-surface-dialog');
  });
});
