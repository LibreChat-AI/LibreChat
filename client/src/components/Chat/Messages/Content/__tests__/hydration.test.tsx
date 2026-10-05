import React from 'react';
import { RecoilRoot } from 'recoil';
import { ContentTypes, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessageContentParts, ToolCallPartResponse } from 'librechat-data-provider';
import type { ToolDisclosures } from '../disclosure';
import {
  SoleToolContext,
  useToolExpansion,
  useToolContentPending,
  ToolDisclosureContext,
  ToolDisclosureKeyContext,
} from '../disclosure';
import { isPreviewedToolCallPart, PreviewedToolCallPart, withFullToolCall } from '../hydration';
import { MessageContext } from '~/Providers';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, getToolCallPart: jest.fn() } };
});

jest.mock('@librechat/client', () => ({
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) => <span {...props} />,
}));

const fullOutput = `stdout:\n${'full line\n'.repeat(200)}[exit code: 0]`;
const fullArgs = JSON.stringify({ command: 'make', pad: 'p'.repeat(2_000) });

const previewPart = (toolCall: Record<string, unknown> = {}) =>
  ({
    type: ContentTypes.TOOL_CALL,
    tool_call: {
      id: 'call_1',
      type: 'tool_call',
      name: 'bash_tool',
      args: '{"command":"make","pad":"pp…"}',
      output: 'stdout:\nfull line\n…\n[exit code: 0]',
      progress: 1,
      outputTruncated: true,
      outputLength: fullOutput.length,
      argsTruncated: true,
      argsLength: fullArgs.length,
      ...toolCall,
    },
  }) as TMessageContentParts;

const stored = (toolCall: Record<string, unknown> = {}): ToolCallPartResponse => ({
  conversationId: 'convo-1',
  messageId: 'msg-1',
  partIndex: 2,
  tool_call: {
    id: 'call_1',
    type: 'tool_call',
    name: 'bash_tool',
    args: fullArgs,
    output: fullOutput,
    ...toolCall,
  },
});

/** A card that opens through the same disclosure hook every tool card uses. */
function Card({ part }: { part: TMessageContentParts }) {
  const [expanded, setExpanded] = useToolExpansion(true);
  const pending = useToolContentPending();
  const toolCall = (part as { tool_call: Record<string, unknown> }).tool_call;
  return (
    <div>
      <button type="button" onClick={() => setExpanded(!expanded)}>
        {'toggle'}
      </button>
      <span data-testid="output">{String(toolCall.output)}</span>
      <span data-testid="markers">
        {String('outputTruncated' in toolCall || 'argsTruncated' in toolCall)}
      </span>
      <span data-testid="pending">{String(pending)}</span>
    </div>
  );
}

function renderPart(
  part: TMessageContentParts,
  options: { sole?: boolean; partIndex?: number; queryClient?: QueryClient } = {},
) {
  const queryClient =
    options.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const partIndex = options.partIndex ?? 2;
  const disclosures: ToolDisclosures = new Map();
  const tree = (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MessageContext.Provider
          value={{ messageId: 'msg-1', conversationId: 'convo-1', partIndex, isExpanded: true }}
        >
          <ToolDisclosureContext.Provider value={disclosures}>
            <ToolDisclosureKeyContext.Provider value="call_1">
              <SoleToolContext.Provider value={options.sole}>
                {isPreviewedToolCallPart(part) ? (
                  <PreviewedToolCallPart part={part}>
                    {(rendered) => <Card part={rendered} />}
                  </PreviewedToolCallPart>
                ) : (
                  <Card part={part} />
                )}
              </SoleToolContext.Provider>
            </ToolDisclosureKeyContext.Provider>
          </ToolDisclosureContext.Provider>
        </MessageContext.Provider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  return { ...render(tree), queryClient };
}

describe('previewed tool-call parts', () => {
  const getToolCallPart = dataService.getToolCallPart as jest.Mock;

  beforeEach(() => {
    getToolCallPart.mockReset();
  });

  it('loads nothing while the card stays collapsed', () => {
    getToolCallPart.mockResolvedValue(stored());
    renderPart(previewPart());
    expect(screen.getByTestId('output')).toHaveTextContent('…');
    expect(getToolCallPart).not.toHaveBeenCalled();
  });

  it('fetches the stored part when the card opens, showing a status until it arrives', async () => {
    let resolve: (value: ToolCallPartResponse) => void = () => undefined;
    getToolCallPart.mockReturnValue(new Promise((done) => (resolve = done)));
    renderPart(previewPart());

    fireEvent.click(screen.getByText('toggle'));
    expect(await screen.findByRole('status')).toHaveTextContent('com_ui_tool_content_loading');
    expect(getToolCallPart).toHaveBeenCalledWith({
      conversationId: 'convo-1',
      messageId: 'msg-1',
      partIndex: 2,
      toolCallId: 'call_1',
    });

    expect(screen.getByTestId('pending')).toHaveTextContent('true');
    await act(async () => resolve(stored()));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(fullOutput));
    expect(screen.getByTestId('pending')).toHaveTextContent('false');
    expect(screen.getByTestId('markers')).toHaveTextContent('false');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an error with a retry that loads the part on the next attempt', async () => {
    getToolCallPart
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(stored());
    renderPart(previewPart());

    fireEvent.click(screen.getByText('toggle'));
    const alert = await screen.findByRole('alert', undefined, { timeout: 5_000 });
    expect(alert).toHaveTextContent('com_ui_tool_content_error');
    expect(screen.getByTestId('output')).toHaveTextContent('…');

    fireEvent.click(screen.getByText('com_ui_retry'));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(fullOutput));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getToolCallPart).toHaveBeenCalledTimes(3);
  });

  it('fetches once for a card that opens on its own, then serves reopenings from cache', async () => {
    getToolCallPart.mockResolvedValue(stored());
    renderPart(previewPart(), { sole: true });
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(fullOutput));

    fireEvent.click(screen.getByText('toggle'));
    fireEvent.click(screen.getByText('toggle'));
    expect(getToolCallPart).toHaveBeenCalledTimes(1);
  });

  it('serves the same call from cache when client-only cards shift its index', async () => {
    getToolCallPart.mockResolvedValue(stored());
    const first = renderPart(previewPart(), { sole: true });
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(fullOutput));
    first.unmount();

    renderPart(previewPart(), { sole: true, partIndex: 3, queryClient: first.queryClient });
    expect(screen.getByTestId('output').textContent).toBe(fullOutput);
    expect(getToolCallPart).toHaveBeenCalledTimes(1);
  });

  it('leaves a part the server sent in full alone', () => {
    const part = {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call_1', name: 'bash_tool', args: '{}', output: 'done', progress: 1 },
    } as TMessageContentParts;
    expect(isPreviewedToolCallPart(part)).toBe(false);
    renderPart(part, { sole: true });
    expect(screen.getByTestId('output')).toHaveTextContent('done');
    expect(getToolCallPart).not.toHaveBeenCalled();
  });
});

describe('previewed tool-call parts after the stored call changes', () => {
  const getToolCallPart = dataService.getToolCallPart as jest.Mock;

  beforeEach(() => {
    getToolCallPart.mockReset();
  });

  it('fetches again when the preview it was fetched for is replaced', async () => {
    getToolCallPart
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(stored({ output: `${fullOutput}\nharvested` }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const disclosures: ToolDisclosures = new Map();
    const tree = (part: TMessageContentParts) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <MessageContext.Provider
            value={{
              messageId: 'msg-1',
              conversationId: 'convo-1',
              partIndex: 2,
              isExpanded: true,
            }}
          >
            <ToolDisclosureContext.Provider value={disclosures}>
              <ToolDisclosureKeyContext.Provider value="call_1">
                <SoleToolContext.Provider value={true}>
                  <PreviewedToolCallPart part={part as never}>
                    {(rendered) => <Card part={rendered} />}
                  </PreviewedToolCallPart>
                </SoleToolContext.Provider>
              </ToolDisclosureKeyContext.Provider>
            </ToolDisclosureContext.Provider>
          </MessageContext.Provider>
        </RecoilRoot>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(previewPart()));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(fullOutput));

    rerender(
      tree(
        previewPart({
          output: 'stdout:\nfull line\n…\nharvested',
          outputLength: fullOutput.length + 10,
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('output').textContent).toBe(`${fullOutput}\nharvested`),
    );
    expect(getToolCallPart).toHaveBeenCalledTimes(2);
  });
});

describe('withFullToolCall', () => {
  it('keeps fields the preview carried in full, so a fetched copy cannot roll them back', () => {
    const part = previewPart({ output: 'current output', outputTruncated: undefined });
    const merged = withFullToolCall(part as never, { ...stored().tool_call, output: 'stale' });
    expect((merged.tool_call as { output: string }).output).toBe('current output');
    expect((merged.tool_call as { args: string }).args).toBe(fullArgs);
  });

  it('replaces only content fields and drops the markers', () => {
    const part = previewPart({ subagentContentOmitted: true, subagentContentParts: 1 });
    const transcript = [{ type: ContentTypes.TEXT, text: 'child' }] as TMessageContentParts[];
    const merged = withFullToolCall(part as never, {
      ...stored().tool_call,
      subagent_content: transcript,
    });
    expect(merged.tool_call).toEqual({
      id: 'call_1',
      type: 'tool_call',
      name: 'bash_tool',
      args: fullArgs,
      output: fullOutput,
      progress: 1,
      subagent_content: transcript,
    });
  });
});
