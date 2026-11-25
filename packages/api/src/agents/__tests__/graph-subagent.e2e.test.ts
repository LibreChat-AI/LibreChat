/**
 * Live-provider verification for LibreChat's saved-team -> SDK graph-subagent bridge.
 *
 * Run from `packages/api` with credentials loaded into the environment:
 * `RUN_GRAPH_SUBAGENT_LIVE_TESTS=1 npx jest graph-subagent.e2e --runInBand`
 */
import { GraphEvents, Providers, formatAgentMessages } from '@librechat/agents';
import type { EventHandler, SubagentUpdateEvent, SubagentUsageEvent } from '@librechat/agents';
import { createRun } from '~/agents/run';

const shouldRun = process.env.RUN_GRAPH_SUBAGENT_LIVE_TESTS === '1';
const liveDescribe = shouldRun ? describe : describe.skip;

type LiveProvider = {
  provider: string;
  model: string;
  apiKey: string | undefined;
};

const providers: LiveProvider[] = [
  {
    provider: Providers.OPENAI,
    model: process.env.GRAPH_SUBAGENT_OPENAI_MODEL ?? 'gpt-4.1-mini',
    apiKey: process.env.OPENAI_API_KEY,
  },
  {
    provider: Providers.ANTHROPIC,
    model: process.env.GRAPH_SUBAGENT_ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
];
const requestedProvider = process.env.GRAPH_SUBAGENT_LIVE_PROVIDER;
const selectedProviders = requestedProvider
  ? providers.filter(({ provider }) => provider === requestedProvider)
  : providers;

function makeAgent(provider: string, model: string, id: string, instructions: string) {
  return {
    id,
    name: id,
    provider,
    endpoint: provider,
    instructions,
    tools: [],
    maxContextTokens: 4096,
    recursion_limit: 9,
    model_parameters: {
      model,
      temperature: 0,
      max_tokens: 64,
      streaming: false,
    },
  };
}

liveDescribe('Graph subagent E2E (LibreChat)', () => {
  jest.setTimeout(180_000);

  beforeAll(() => {
    if (selectedProviders.length === 0) {
      throw new Error(`Unknown live graph-subagent provider: ${requestedProvider}`);
    }
    if (!selectedProviders.every(({ apiKey }) => Boolean(apiKey))) {
      throw new Error('The selected live graph-subagent providers require API credentials.');
    }
  });

  test.each(selectedProviders)(
    '$provider executes a saved team with member telemetry',
    async (liveProvider) => {
      const { provider, model } = liveProvider;
      const entry = makeAgent(
        provider,
        model,
        'live_entry',
        'Calculate 17 + 25 and state the result for the next team member.',
      );
      const worker = makeAgent(
        provider,
        model,
        'live_worker',
        'Review the prior arithmetic and state the verified result for the final writer.',
      );
      const result = makeAgent(
        provider,
        model,
        'live_result',
        'Answer the arithmetic question using only the verified number.',
      );
      const definition = {
        type: 'live_team',
        name: 'Live team',
        description: 'Runs the live provider verification team',
        agent_ids: [entry.id, worker.id, result.id],
        edges: [
          { from: entry.id, to: worker.id, edgeType: 'direct' as const },
          { from: worker.id, to: result.id, edgeType: 'direct' as const },
        ],
        entry_agent_id: entry.id,
        result_agent_id: result.id,
      };
      const root = {
        ...makeAgent(
          provider,
          model,
          'live_root',
          'You must call the live_team subagent exactly once to answer the user. After it returns, reply with only its returned text.',
        ),
        subagents: { enabled: true, allowSelf: false, graphs: [definition] },
        subagentGraphConfigs: [{ definition, memberConfigs: [entry, worker, result] }],
      };
      const updates: SubagentUpdateEvent[] = [];
      const usage: SubagentUsageEvent[] = [];
      const handlers: Record<string, EventHandler> = {
        [GraphEvents.ON_SUBAGENT_UPDATE]: {
          handle: (_event: string, data: unknown) => {
            updates.push(data as SubagentUpdateEvent);
          },
        },
      };
      const { messages } = formatAgentMessages(
        [{ role: 'user', content: 'What is 17 + 25? Delegate this to the live team.' }] as never,
        {},
      );
      const runId = `graph-subagent-live-${provider}-${Date.now()}`;
      const run = await createRun({
        agents: [root] as never,
        messages,
        runId,
        signal: new AbortController().signal,
        customHandlers: handlers,
        subagentUsageSink: (event) => usage.push(event),
        streaming: false,
        streamUsage: true,
      });

      await run.processStream(
        { messages },
        {
          configurable: { thread_id: runId },
          recursionLimit: 100,
          version: 'v2',
        },
      );

      const runMessages = run.getRunMessages();
      if (!runMessages) {
        throw new Error('Expected graph subagent run messages');
      }

      const output = runMessages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        )
        .join('\n');
      const envelopeMembers = new Set(updates.map((event) => event.memberAgentId).filter(Boolean));
      const payloadMembers = new Set(
        updates
          .map((event) => (event.data as { agentId?: string } | undefined)?.agentId)
          .filter(Boolean),
      );
      const billedMembers = new Set(usage.map((event) => event.memberAgentId).filter(Boolean));

      console.info(
        JSON.stringify({
          provider,
          outputHas42: output.includes('42'),
          envelopeMembers: [...envelopeMembers],
          payloadMembers: [...payloadMembers],
          billedMembers: [...billedMembers],
          updatePhases: updates.map((event) => event.phase),
          usageCount: usage.length,
        }),
      );

      expect(output).toContain('42');
      expect(payloadMembers).toEqual(new Set([entry.id, worker.id, result.id]));
      expect(billedMembers).toEqual(new Set([entry.id, worker.id, result.id]));
      expect(usage.every((event) => event.subagentKind === 'graph')).toBe(true);
      expect(usage.every((event) => event.depth === 1)).toBe(true);
      expect(usage.every((event) => event.ancestry?.length === 1)).toBe(true);
    },
  );
});
