import { model, models } from 'mongoose';
import agentSchema from './agent';

it('persists repository instruction preference and rejects unknown modes', () => {
  const Agent = models.WorkspaceDefaultAgent ?? model('WorkspaceDefaultAgent', agentSchema);
  const agent = new Agent({ repositoryInstructions: 'off' });
  expect(new Agent(agent.toObject()).repositoryInstructions).toBe('off');
  agent.repositoryInstructions = 'invalid';
  expect(agent.validateSync()?.errors.repositoryInstructions).toBeDefined();
});

it('retains the agent workspace preference and explicit reset through serialization', () => {
  const Agent = models.WorkspaceDefaultAgent ?? model('WorkspaceDefaultAgent', agentSchema);
  const agent = new Agent({ code_environment_id: 'machine-a', code_workspace_id: 'project-a' });
  expect(new Agent(agent.toObject()).toObject().code_workspace_id).toBe('project-a');
  agent.code_workspace_id = '';
  expect(new Agent(agent.toObject()).toObject().code_workspace_id).toBe('');
});
