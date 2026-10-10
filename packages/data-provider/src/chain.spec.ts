import { AgentCapabilities, defaultAgentCapabilities, agentsEndpointSchema } from './config';

test('retires chain from defaults without rejecting legacy deployment configuration', () => {
  expect(defaultAgentCapabilities).not.toContain(AgentCapabilities.chain);
  expect(
    agentsEndpointSchema.parse({ capabilities: [AgentCapabilities.chain] }).capabilities,
  ).toEqual([AgentCapabilities.chain]);
});
