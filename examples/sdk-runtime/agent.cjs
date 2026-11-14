const { setTimeout: delay } = require('node:timers/promises');
const { z } = require('zod');
const { Run, Providers } = require('@librechat/agents');
const { AIMessageChunk, HumanMessage } = require('@librechat/agents/langchain/messages');
const { tool } = require('@librechat/agents/langchain/tools');
const { FakeChatModel } = require('@langchain/core/utils/testing');
const {
  Annotation,
  StateGraph,
  START,
  END,
  messagesStateReducer,
} = require('@langchain/langgraph');

/** Real SDK execution; the default deterministic model keeps the example key-free and repeatable. */
async function createExampleRun(input, { complex = true, stepDelayMs = 0 } = {}) {
  if (!Number.isSafeInteger(stepDelayMs) || stepDelayMs < 0 || stepDelayMs > 30000)
    throw new Error('Invalid example delay');
  const inspect = tool(
    async ({ topic }) =>
      JSON.stringify({ topic, findings: ['Plan prepared', 'Read-only inspection finished'] }),
    {
      name: 'inspect_example',
      description: 'Read-only inspection of the example fixture.',
      schema: z.object({ topic: z.string() }),
    },
  );
  const live = process.env.SDK_EXAMPLE_LIVE_MODEL === 'true';
  const run = await Run.create({
    ...input.config,
    returnContent: true,
    tokenCounter: live ? undefined : () => 1,
    graphConfig: {
      type: 'standard',
      signal: input.signal,
      compileOptions: input.compileOptions,
      agents: [
        {
          agentId: input.identity.agentId,
          provider: Providers.OPENAI,
          tools: [inspect],
          instructions: `${input.agent.instructions ?? ''}\nInspect the request using inspect_example, then explain the findings.`,
          clientOptions: {
            model: process.env.SDK_EXAMPLE_MODEL || 'gpt-4.1-mini',
            apiKey: process.env.OPENAI_API_KEY,
            streaming: live,
          },
        },
      ],
    },
  });
  if (!run.Graph) throw new Error('SDK graph was not initialized');
  if (!live) {
    const model = new FakeChatModel({});
    model._generate = async (messages) => ({
      generations: [
        {
          text: '',
          message: new AIMessageChunk(
            !complex
              ? { content: 'Hello from the separate SDK runtime.' }
              : messages.some((message) => message.getType() === 'tool')
                ? {
                    content: messages.some(
                      (message) =>
                        message.getType() === 'human' &&
                        message.content === 'Summarize the reviewed findings concisely.',
                    )
                      ? 'Custom graph complete: inspected the fixture, reviewed the findings, and prepared the result.'
                      : 'Inspection complete; reviewing the findings.',
                  }
                : {
                    content: 'I will inspect the fixture.',
                    tool_calls: [
                      {
                        id: 'example-inspection',
                        name: 'inspect_example',
                        args: { topic: 'runtime bridge' },
                      },
                    ],
                  },
          ),
        },
      ],
    });
    run.Graph.overrideModel = model;
  }
  if (complex) {
    // Retain the SDK's compiled agent node: native tools, hooks, events, and approvals stay intact.
    const agent = run.graphRunnable;
    const State = Annotation.Root({
      messages: Annotation({ reducer: messagesStateReducer, default: () => [] }),
      reviewed: Annotation({ reducer: (_old, next) => next, default: () => false }),
      runStepState: Annotation({ reducer: (_old, next) => next, default: () => undefined }),
    });
    run.graphRunnable = new StateGraph(State)
      .addNode('plan', async () => {
        if (stepDelayMs) {
          try {
            await delay(stepDelayMs, undefined, { signal: input.signal });
          } catch (error) {
            if (input.signal.aborted) console.log('Example node cancelled');
            throw error;
          }
        }
        return { reviewed: false };
      })
      .addNode('inspect', agent)
      .addNode('review', async () => ({ reviewed: true }))
      .addNode('refine', async () => ({
        messages: [new HumanMessage('Summarize the reviewed findings concisely.')],
      }))
      .addEdge(START, 'plan')
      .addEdge('plan', 'inspect')
      .addConditionalEdges('inspect', (state) => (state.reviewed ? END : 'review'))
      .addEdge('review', 'refine')
      .addEdge('refine', 'inspect')
      .compile(input.compileOptions);
  }
  return run;
}
module.exports = { createExampleRun };
