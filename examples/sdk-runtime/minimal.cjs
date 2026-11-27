const { Run, Providers, FakeChatModel } = require('@librechat/agents');

/** Smallest key-free example: a real SDK Run, streamed through the native Agents UI. */
async function createMinimalRun({
  config,
  compileOptions,
  identity,
  agent,
  signal,
  hostTools,
  hostModel,
}) {
  const run = await Run.create({
    ...config,
    returnContent: true,
    tokenCounter: agent.model ? undefined : () => 1,
    graphConfig: {
      type: 'standard',
      signal,
      compileOptions,
      agents: [
        {
          agentId: identity.agentId,
          provider: agent.model?.provider ?? Providers.OPENAI,
          instructions: agent.instructions,
          tools: [],
          toolDefinitions: hostTools?.toolDefinitions,
          clientOptions: {
            model: agent.model?.name ?? 'gpt-4.1-mini',
            streaming: agent.model?.streaming ?? true,
          },
        },
      ],
    },
  });
  run.Graph.overrideModel =
    hostModel ??
    new FakeChatModel({
      responses: ['Hello from the separate SDK runtime.'],
      sleep: 10,
    });
  return run;
}
module.exports = { createMinimalRun };
