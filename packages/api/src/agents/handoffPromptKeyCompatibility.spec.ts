import { Constants } from '@librechat/agents';
import { HumanMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { GraphEdge, IState, Run, RunConfig } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import { applyCustomHandoffPromptKeyCompatibility } from './handoffPromptKeyCompatibility';

type HandoffReceptionResult = {
  filteredMessages: BaseMessage[];
  instructions: string | null;
  sourceAgentName: string | null;
  parallelSiblings: string[];
} | null;

type ProcessHandoffReception = (messages: BaseMessage[], agentId: string) => HandoffReceptionResult;

type TestGraph = {
  processHandoffReception: ProcessHandoffReception;
};

const createGraphConfig = (edges: GraphEdge[]): RunConfig['graphConfig'] => ({
  type: 'multi-agent',
  agents: [],
  edges,
});

const createRun = (
  processHandoffReception: ProcessHandoffReception,
): { run: Run<IState>; graph: TestGraph } => {
  const graph: TestGraph = { processHandoffReception };
  return {
    run: { Graph: graph } as unknown as Run<IState>,
    graph,
  };
};

const findTransfer = (messages: BaseMessage[], agentId: string): ToolMessage | undefined =>
  messages.find(
    (message): message is ToolMessage =>
      ToolMessage.isInstance(message) &&
      (message.name === `${Constants.LC_TRANSFER_TO_}${agentId}` ||
        (message.name === 'conditional_transfer' &&
          message.additional_kwargs.handoff_destination === agentId)),
  );

/**
 * Models the reception behavior in @librechat/agents 3.2.68: filtering and
 * metadata work, but only the built-in Instructions/Context labels are read.
 */
const createSdkProcess = (): jest.MockedFunction<ProcessHandoffReception> =>
  jest.fn((messages, agentId) => {
    const transfer = findTransfer(messages, agentId);
    if (!transfer) {
      return null;
    }

    const content =
      typeof transfer.content === 'string' ? transfer.content : JSON.stringify(transfer.content);
    const instructions =
      content.match(/(?:Instructions?|Context):\s*([\s\S]+)/i)?.[1]?.trim() ?? null;
    const rawSiblings = transfer.additional_kwargs.handoff_parallel_siblings;

    return {
      filteredMessages: messages.filter((message) => message !== transfer),
      instructions,
      sourceAgentName:
        typeof transfer.additional_kwargs.handoff_source_name === 'string'
          ? transfer.additional_kwargs.handoff_source_name
          : null,
      parallelSiblings: Array.isArray(rawSiblings)
        ? rawSiblings.filter((sibling): sibling is string => typeof sibling === 'string')
        : [],
    };
  });

describe('applyCustomHandoffPromptKeyCompatibility', () => {
  it('leaves multi-agent graphs without edges unpatched', () => {
    const sdkProcess = createSdkProcess();
    const { run, graph } = createRun(sdkProcess);
    const originalProcess = graph.processHandoffReception;
    // Persisted agents can predate `edges`, even though the current SDK type requires it.
    const graphConfig = {
      type: 'multi-agent',
      agents: [],
    } as unknown as RunConfig['graphConfig'];

    expect(() => applyCustomHandoffPromptKeyCompatibility(run, graphConfig)).not.toThrow();
    expect(graph.processHandoffReception).toBe(originalProcess);
  });

  it('recovers a custom prompt key for scalar and array handoff endpoints', () => {
    const sdkProcess = createSdkProcess();
    const { run, graph } = createRun(sdkProcess);
    const userMessage = new HumanMessage('Delegate the audit');
    const transferMessage = new ToolMessage({
      id: 'transfer-message',
      name: `${Constants.LC_TRANSFER_TO_}specialist`,
      tool_call_id: 'transfer-call',
      content: 'Successfully transferred to specialist\n\nWork_items: Audit cache invalidation',
      status: 'success',
      artifact: { preserved: true },
      metadata: { trace: 'handoff' },
      response_metadata: { provider: 'mock' },
      additional_kwargs: {
        handoff_source_name: 'Router',
        handoff_parallel_siblings: ['peer', 42],
      },
    });
    const messages = [userMessage, transferMessage];

    applyCustomHandoffPromptKeyCompatibility(
      run,
      createGraphConfig([
        {
          from: ['router', 'peer'],
          to: ['specialist', 'backup'],
          edgeType: 'handoff',
          prompt: 'Work to complete',
          promptKey: 'work_items',
        },
      ]),
    );

    const result = graph.processHandoffReception(messages, 'specialist');

    expect(result).toEqual({
      filteredMessages: [userMessage],
      instructions: 'Audit cache invalidation',
      sourceAgentName: 'Router',
      parallelSiblings: ['peer'],
    });
    expect(sdkProcess).toHaveBeenCalledTimes(2);
    expect(sdkProcess.mock.calls[0]?.[0]).toBe(messages);

    const retryMessages = sdkProcess.mock.calls[1]?.[0];
    const normalizedTransfer = retryMessages?.[1];
    expect(retryMessages).not.toBe(messages);
    expect(normalizedTransfer).toBeInstanceOf(ToolMessage);
    expect(normalizedTransfer).not.toBe(transferMessage);
    expect(normalizedTransfer?.content).toBe(
      'Successfully transferred to specialist\n\nInstructions: Audit cache invalidation',
    );
    expect(normalizedTransfer).toMatchObject({
      id: 'transfer-message',
      name: `${Constants.LC_TRANSFER_TO_}specialist`,
      tool_call_id: 'transfer-call',
      status: 'success',
      artifact: { preserved: true },
      metadata: { trace: 'handoff' },
      response_metadata: { provider: 'mock' },
      additional_kwargs: {
        handoff_source_name: 'Router',
        handoff_parallel_siblings: ['peer', 42],
      },
    });
    expect(transferMessage.content).toContain('Work_items:');
  });

  it.each([
    {
      name: 'the default instructions key',
      promptKey: undefined,
      label: 'Instructions',
    },
    {
      name: 'the already-supported context key',
      promptKey: 'context',
      label: 'Context',
    },
  ])('leaves $name on the SDK path', ({ promptKey, label }) => {
    const sdkProcess = createSdkProcess();
    const { run, graph } = createRun(sdkProcess);
    const originalProcess = graph.processHandoffReception;
    const edge: GraphEdge = {
      from: 'router',
      to: 'specialist',
      edgeType: 'handoff',
      prompt: 'Work to complete',
      ...(promptKey && { promptKey }),
    };

    applyCustomHandoffPromptKeyCompatibility(run, createGraphConfig([edge]));

    expect(graph.processHandoffReception).toBe(originalProcess);
    expect(
      graph.processHandoffReception(
        [
          new ToolMessage({
            name: `${Constants.LC_TRANSFER_TO_}specialist`,
            tool_call_id: 'transfer-call',
            content: `Successfully transferred\n\n${label}: Keep the native behavior`,
          }),
        ],
        'specialist',
      )?.instructions,
    ).toBe('Keep the native behavior');
    expect(sdkProcess).toHaveBeenCalledTimes(1);
  });

  it('self-disables when the SDK already extracts a custom prompt key', () => {
    const upstreamResult: Exclude<HandoffReceptionResult, null> = {
      filteredMessages: [],
      instructions: 'Handled upstream',
      sourceAgentName: 'Router',
      parallelSiblings: [],
    };
    const sdkProcess = jest.fn<
      ReturnType<ProcessHandoffReception>,
      Parameters<ProcessHandoffReception>
    >(() => upstreamResult);
    const { run, graph } = createRun(sdkProcess);
    const config = createGraphConfig([
      {
        from: 'router',
        to: 'specialist',
        edgeType: 'handoff',
        prompt: 'Work to complete',
        promptKey: 'work_items',
      },
    ]);

    applyCustomHandoffPromptKeyCompatibility(run, config);
    const wrappedProcess = graph.processHandoffReception;
    applyCustomHandoffPromptKeyCompatibility(run, config);

    expect(graph.processHandoffReception).toBe(wrappedProcess);
    expect(
      graph.processHandoffReception(
        [
          new ToolMessage({
            name: `${Constants.LC_TRANSFER_TO_}specialist`,
            tool_call_id: 'transfer-call',
            content: 'Successfully transferred\n\nWork_items: Handled upstream',
          }),
        ],
        'specialist',
      ),
    ).toBe(upstreamResult);
    expect(sdkProcess).toHaveBeenCalledTimes(1);
  });

  it('ignores custom keys on irrelevant destinations and direct edges', () => {
    const sdkProcess = createSdkProcess();
    const { run, graph } = createRun(sdkProcess);

    applyCustomHandoffPromptKeyCompatibility(
      run,
      createGraphConfig([
        {
          from: 'router',
          to: 'different-agent',
          edgeType: 'handoff',
          prompt: 'Work to complete',
          promptKey: 'work_items',
        },
        {
          from: ['router', 'peer'],
          to: ['specialist', 'backup'],
          edgeType: 'direct',
          prompt: 'Direct prompt',
          promptKey: 'work_items',
        },
      ]),
    );

    const result = graph.processHandoffReception(
      [
        new ToolMessage({
          name: `${Constants.LC_TRANSFER_TO_}specialist`,
          tool_call_id: 'transfer-call',
          content: 'Successfully transferred\n\nWork_items: Do not reinterpret this edge',
        }),
      ],
      'specialist',
    );

    expect(result?.instructions).toBeNull();
    expect(sdkProcess).toHaveBeenCalledTimes(1);
  });
});
