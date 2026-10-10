/**
 * @jest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { ContentTypes, ToolCallTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { PartRenderers, ToolRenderer } from '../Part';
import { MessageContext } from '../../react/message';
import { Part } from '../Part';

const toolPart = (toolCall: Record<string, unknown>) =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { type: ToolCallTypes.TOOL_CALL, args: '{}', ...toolCall },
  }) as unknown as TMessageContentParts;

const named =
  (label: string): ToolRenderer =>
  ({ toolCall, toolCallId }) => (
    <p>
      {label}:{toolCall.name}:{toolCallId ?? 'none'}
    </p>
  );

function createRenderers(overrides: Partial<PartRenderers> = {}): PartRenderers {
  return {
    parts: {
      [ContentTypes.TEXT]: ({ part, partIndex, isLast }) => (
        <p>
          text:{typeof part.text === 'string' ? part.text : part.text?.value}:{partIndex}:
          {String(isLast)}
        </p>
      ),
      [ContentTypes.TOOL_CALL]: ({ part }) => <p>assistants:{part.tool_call.type}</p>,
    },
    tools: { web_search: named('search') },
    defaultTool: named('generic'),
    ...overrides,
  };
}

const baseProps = { isSubmitting: false, showCursor: false, isCreatedByUser: false };

describe('Part', () => {
  it('routes a part to the renderer for its type, with its index from the message', () => {
    render(
      <MessageContext.Provider value={{ messageId: 'm1', isExpanded: false, partIndex: 3 }}>
        <Part
          {...baseProps}
          isLast={true}
          part={{ type: ContentTypes.TEXT, text: 'hello' }}
          renderers={createRenderers()}
        />
      </MessageContext.Provider>,
    );
    expect(screen.getByText('text:hello:3:true')).toBeTruthy();
  });

  it('draws nothing for a missing part or a type without a renderer', () => {
    const renderers = createRenderers();
    const { container } = render(
      <>
        <Part {...baseProps} renderers={renderers} />
        <Part
          {...baseProps}
          part={{ type: ContentTypes.THINK, think: 'hmm' }}
          renderers={renderers}
        />
      </>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('routes an agent tool call by name, falling back to the default tool', () => {
    render(
      <>
        <Part
          {...baseProps}
          part={toolPart({ id: 'call-1', name: 'web_search' })}
          renderers={createRenderers()}
        />
        <Part
          {...baseProps}
          part={toolPart({ name: 'unknown_tool' })}
          renderers={createRenderers()}
        />
      </>,
    );
    expect(screen.getByText('search:web_search:call-1')).toBeTruthy();
    expect(screen.getByText('generic:unknown_tool:none')).toBeTruthy();
  });

  it('lets a matcher route a call before its name, and wraps every agent tool card', () => {
    const renderers = createRenderers({
      matchTool: (toolCall) => (toolCall.name?.startsWith('lc_') ? named('matched') : undefined),
      wrapTool: (card, { toolCall }) => (
        <section aria-label={`wrapped ${toolCall.name}`}>{card}</section>
      ),
    });
    render(<Part {...baseProps} part={toolPart({ name: 'lc_transfer' })} renderers={renderers} />);
    const wrapper = screen.getByRole('region', { name: 'wrapped lc_transfer' });
    expect(wrapper.textContent).toBe('matched:lc_transfer:none');
  });

  it('sends the Assistants tool call shapes to the tool call part renderer, unwrapped', () => {
    const wrapTool = jest.fn((card: React.ReactNode) => card);
    render(
      <Part
        {...baseProps}
        part={
          {
            type: ContentTypes.TOOL_CALL,
            [ContentTypes.TOOL_CALL]: {
              type: ToolCallTypes.CODE_INTERPRETER,
              code_interpreter: { input: '', outputs: [] },
            },
          } as unknown as TMessageContentParts
        }
        renderers={createRenderers({ wrapTool })}
      />,
    );
    expect(screen.getByText(`assistants:${ToolCallTypes.CODE_INTERPRETER}`)).toBeTruthy();
    expect(wrapTool).not.toHaveBeenCalled();
  });

  it('lets a claim take a part before type routing, and pass on the rest', () => {
    const renderers = createRenderers({
      claim: ({ part }) =>
        part.type === ContentTypes.TEXT && part.text === 'claimed' ? <p>claim</p> : undefined,
    });
    render(
      <>
        <Part
          {...baseProps}
          part={{ type: ContentTypes.TEXT, text: 'claimed' }}
          renderers={renderers}
        />
        <Part
          {...baseProps}
          part={{ type: ContentTypes.TEXT, text: 'free' }}
          renderers={renderers}
        />
      </>,
    );
    expect(screen.getByText('claim')).toBeTruthy();
    expect(screen.getByText('text:free::undefined')).toBeTruthy();
  });
});
