const { Run, Providers, FakeChatModel } = require('@librechat/agents');

/** Smallest key-free example: a real SDK Run, streamed through the native Agents UI. */
async function createMinimalRun({ config, compileOptions, identity, agent, signal }) {
  const run = await Run.create({
    ...config,
    returnContent: true,
    tokenCounter: () => 1,
    graphConfig: {
      type: 'standard',
      signal,
      compileOptions,
      agents: [
        {
          agentId: identity.agentId,
          provider: Providers.OPENAI,
          instructions: agent.instructions,
          tools: [],
          clientOptions: { model: 'gpt-4.1-mini' },
        },
      ],
    },
  });
  run.Graph.overrideModel = new FakeChatModel({
    responses: ['Hello from the separate SDK runtime.'],
    sleep: 10,
  });
  return run;
}
module.exports = { createMinimalRun };
